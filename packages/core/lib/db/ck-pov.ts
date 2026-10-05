/**
 * 다시점 경기 저장 — 이미 있는 경기에 VOD 시점을 더한다. docs/CK-MULTI-POV-PLAN.md §3~4.
 *
 * ★ 경기 값은 덮어쓰지 않는다. 시점이 직접 읽은 값(observed)을 남기고, 경기 쪽이 **비어 있는 칸만**
 *   채운다. 다른 값은 그대로 두고 불일치로 보인다(계산은 metrics/pov.ts).
 * ★ 사진은 연결이 승인된 시점의 것을 빠짐없이 잇되, 사람이 고친 사진(reviewed_at)은 건드리지 않는다.
 * ★ 검수된 경기(match.reviewed_at)도 시점·사진은 받는다. 값 보호는 칸 단위다(review-lock.ts) —
 *   사람이 바꾼 칸은 그대로, 사람이 안 바꾼 빈 칸은 채운다(actor=auto 이력). 이력으로 칸을 가릴 수 없는
 *   검수 경기와 검수 완료 경기는 전체가 잠긴다.
 */

import { isDeepStrictEqual } from "node:util";
import type postgres from "postgres";

import { db } from "./client.ts";
import { affectedStreamers } from "./ck.ts";
import { recomputeChampionStatsInTx, rederiveEncountersInTx } from "./ingest.ts";
import { resolveChampion } from "./participant.ts";
import {
  autoFillVerdict, loadReviewLockInTx, matchCell, participantCell, recordAutoChangesInTx, type AutoChange,
} from "./review-lock.ts";
import {
  comparePov, fillPlan, mergeObserved, summarizeComparison,
  type PovHistoryEntry, type PovObserved, type PovSubmission, type StoredMatch,
} from "../metrics/pov.ts";

type Tx = postgres.TransactionSql;

export type PovSource = "own" | "rebroadcast";
export type PovRole = "created" | "added";

export interface MatchPovRow {
  match_id: string;
  lead_id: string;
  streamer_id: string | null;
  role: PovRole;
  mode: "full";
  source: PovSource;
  observed: PovObserved;
  link_basis: string | null;
  filled: Array<{ scope: string; participant_id: number | null; field: string; value: unknown; at: string }>;
  history: PovHistoryEntry[];
  created_at: Date;
  submitted_at: Date;
}

/**
 * 시점 칸 → 경기의 컬럼. 첫 컬럼이 칸 주소이고, 묶음 중 하나라도 사람이 바꿨으면 그 칸은 사람 것이다
 * (검수 화면은 챔피언을 id·이름 한 쌍으로, 포지션을 team·individual 로 고친다).
 */
const POV_FILL_COLUMNS: Record<string, readonly string[]> = {
  duration: ["game_duration"],
  series_game_no: ["series_game_no"],
  champion_id: ["champion_id", "champion_name"],
  position: ["team_position", "individual_position"],
  kills: ["kills"], deaths: ["deaths"], assists: ["assists"],
};

/** 시각 모순 검사 여유. 밴픽은 시작 전, 결과창은 종료 뒤라 경기 시간 안으로 좁히지 않는다(§4.5). */
export const POV_TIME_SLACK_SEC = 30 * 60;

interface StoredMatchRow extends StoredMatch {
  match_id: string;
  reviewed_at: Date | null;
  game_creation: Date;
  game_creation_precision: "datetime" | "date";
}

/** 비교에 쓸 경기 값. 사람은 계정 주인을 먼저 본다(조우 파생·champion_stat 과 같은 순서). */
export async function loadStoredMatchInTx(tx: Tx | postgres.Sql, matchId: string, lock = false): Promise<StoredMatchRow | null> {
  const rows = await tx<Omit<StoredMatchRow, "participants">[]>`
    SELECT match_id, winning_team, game_duration, series_id, series_game_no,
           review_completed_at, reviewed_at, game_creation, game_creation_precision
      FROM match WHERE match_id = ${matchId} ${lock ? tx`FOR UPDATE` : tx``}`;
  if (!rows.length) return null;
  const participants = await tx<StoredMatch["participants"]>`
    SELECT mp.participant_id, COALESCE(sa.streamer_id, mp.streamer_id) AS person_id, mp.puuid, mp.observed_name,
           mp.team_id, mp.team_position, mp.champion_id, mp.kills, mp.deaths, mp.assists
      FROM match_participant mp
      LEFT JOIN streamer_account sa ON sa.puuid = mp.puuid AND sa.active_to IS NULL
     WHERE mp.match_id = ${matchId} ORDER BY mp.participant_id`;
  return { ...rows[0], participants };
}

/** VOD 방송 주인. 단서에 사람이 없으면 채널로 찾는다. 등록 안 된 채널이면 null. */
export async function leadOwnerInTx(tx: Tx, leadId: string): Promise<string | null> {
  const [row] = await tx<{ owner: string | null }[]>`
    SELECT COALESCE(el.streamer_id, (
             SELECT c.streamer_id FROM streamer_channel c
              WHERE c.channel_id = el.channel_id AND c.platform = 'soop'
              ORDER BY c.active_to IS NULL DESC LIMIT 1)) AS owner
      FROM event_lead el WHERE el.id = ${leadId}::uuid`;
  return row?.owner ?? null;
}

export interface PovSubmitInput {
  match_id: string;
  lead_id: string;
  source: PovSource;
  link_basis: string | null;
  /** 이 화면에서 직접 읽은 칸만. 사람은 streamer_id 로, 챔피언은 id 로 이미 바꿔 둔 값. */
  submission: PovSubmission;
  /** 이 시점이 근거로 낸 사진(이 VOD 의 것). */
  frame_ids: string[];
  /**
   * 사진의 절대시각. **실제 경기 시각과 방송 시각을 직접 대응할 수 있을 때만** 넘긴다
   * (본인 화면 · VOD 시작 시각 확인 · 연속 시간축). 아니면 undefined — 시각 모순 검사를 하지 않는다.
   */
  frame_times?: Date[];
  /** created: 이 시점이 경기를 만들었다. 경기 값 검사·채우기 없이 관측만 남긴다. */
  role?: PovRole;
}

export interface PovSubmitResult {
  role: PovRole;
  filled: MatchPovRow["filled"];
  attached: number;
  /** 경기 전체가 잠겨 아무 칸도 채우지 않았다(review-lock.ts 의 match 모드). */
  locked: boolean;
  lock_reason: string | null;
  /** 비어 있지만 사람이 바꾼 칸이라 채우지 않은 수. */
  kept: number;
  /** 새 미해결 불일치 때문에 검수 완료를 풀었다. */
  reopened: boolean;
  summary: ReturnType<typeof summarizeComparison>;
  unmatched: string[];
}

/**
 * 시점 하나를 기록한다. 기존 경기에 더할 때(role added)는:
 *   1) 방송 주인 참가(본인 화면) · 시각 모순(대응 가능할 때만)을 검사하고 — 어긋나면 던진다(파일 전체 되돌림)
 *   2) 관측을 합치고(보낸 칸만, null 은 철회, 이력 남김)
 *   3) 경기 쪽 빈 칸만 채우고(사람이 바꾼 칸·전체 보호 경기는 안 채움 — review-lock.ts)
 *   4) 이 VOD 사진을 경기에 잇는다(사람이 고친 사진은 제외)
 */
export async function submitMatchPovInTx(tx: Tx, input: PovSubmitInput): Promise<PovSubmitResult> {
  const role = input.role ?? "added";
  const stored = await loadStoredMatchInTx(tx, input.match_id, true);
  if (!stored) throw new Error(`${input.match_id}: 그런 경기가 없다 — 시점을 더하려면 경기가 먼저 있어야 한다`);
  const owner = await leadOwnerInTx(tx, input.lead_id);

  if (role === "added") {
    if (!input.link_basis?.trim()) {
      throw new Error(`${input.match_id}: 기존 경기에 시점을 더하려면 pov.link_basis 가 필요하다 — 같은 경기라고 본 근거를 적을 것`);
    }
    if (input.source === "own" && owner && !stored.participants.some((p) => p.person_id === owner)) {
      throw new Error(`${input.match_id}: 본인 화면(source: own)인데 방송 주인이 이 경기 참가자에 없다 — `
        + "다른 경기이거나, 남의 방송을 띄운 화면이면 source: rebroadcast 로 낼 것");
    }
    // ★ 모순만 거부한다. ±30분 안이라는 건 같은 경기의 증명이 아니다(연속 판·단판이 30분 안에 여럿 있다).
    if (input.source === "own" && input.frame_times?.length && stored.game_creation_precision === "datetime") {
      const start = stored.game_creation.getTime() - POV_TIME_SLACK_SEC * 1000;
      const end = stored.game_creation.getTime() + ((stored.game_duration ?? 3600) + POV_TIME_SLACK_SEC) * 1000;
      const bad = input.frame_times.filter((t) => t.getTime() < start || t.getTime() > end);
      if (bad.length) {
        throw new Error(`${input.match_id}: 사진 시각 ${bad.map((t) => t.toISOString()).join(", ")} 이 경기 시각과 명백히 떨어져 있다 `
          + `(경기 ${stored.game_creation.toISOString()} ±30분 밖) — 다른 판이다. VOD 가 끊겨 시각을 믿을 수 없으면 pov.time_reliable: false`);
      }
    }
  }

  const [prev] = await tx<MatchPovRow[]>`
    SELECT * FROM match_pov WHERE match_id = ${input.match_id} AND lead_id = ${input.lead_id}::uuid`;
  const now = new Date().toISOString();
  const { observed, history } = mergeObserved(prev?.observed ?? {}, input.submission, now);

  // 빈 칸만 채운다. 검수 보호는 **칸 단위**다(review-lock.ts) — 사람이 바꾼 칸은 비어 있어도 안 채우고,
  // 사람 기록으로 칸을 가릴 수 없는 검수 경기·검수 완료 경기는 전체를 잠근다(이때 filled 는 비어 있다).
  const filled: MatchPovRow["filled"] = [];
  const lock = (await loadReviewLockInTx(tx, input.match_id))!;
  const locked = lock.mode === "match";
  let kept = 0;
  const cmp = comparePov(stored, observed);
  if (role === "added" && !locked) {
    const before = await affectedStreamers(tx, input.match_id);
    const auto: AutoChange[] = [];
    for (const f of fillPlan(cmp)) {
      const target = POV_FILL_COLUMNS[f.field];
      if (!target) continue;
      const cell = f.scope === "match" ? matchCell(input.match_id, target[0]) : participantCell(f.participant_id!, target[0]);
      // 비었는지는 fillPlan 이 이미 봤다(empty). 아래 UPDATE 의 조건이 경쟁까지 다시 막는다.
      if (autoFillVerdict(lock, cell, target, true) !== "write") { kept++; continue; }
      const [cur] = f.scope === "match"
        ? await tx<Record<string, unknown>[]>`SELECT game_duration, series_game_no FROM match WHERE match_id = ${input.match_id}`
        : await tx<Record<string, unknown>[]>`SELECT champion_id, champion_name, team_position, individual_position, kills, deaths, assists
                     FROM match_participant WHERE match_id = ${input.match_id} AND participant_id = ${f.participant_id}`;
      let next: Record<string, unknown> = {};
      let n = 0;
      if (f.scope === "match" && f.field === "duration") {
        next = { game_duration: f.value };
        n = (await tx`UPDATE match SET game_duration = ${f.value as number}
                       WHERE match_id = ${input.match_id} AND game_duration IS NULL`).count;
      } else if (f.scope === "match" && f.field === "series_game_no") {
        next = { series_game_no: f.value };
        n = (await tx`UPDATE match SET series_game_no = ${f.value as number}
                       WHERE match_id = ${input.match_id} AND series_game_no IS NULL AND series_id IS NOT NULL`).count;
      } else if (f.field === "champion_id") {
        const c = resolveChampion(f.value as number, null);
        next = { champion_id: c.champion_id, champion_name: c.champion_name };
        n = (await tx`UPDATE match_participant SET champion_id = ${c.champion_id}, champion_name = ${c.champion_name}
                       WHERE match_id = ${input.match_id} AND participant_id = ${f.participant_id} AND champion_id = 0`).count;
      } else if (f.field === "position") {
        const pos = String(f.value).toUpperCase();
        next = { team_position: pos, individual_position: cur?.individual_position ?? pos };
        n = (await tx`UPDATE match_participant SET team_position = ${pos},
                         individual_position = COALESCE(individual_position, ${pos})
                       WHERE match_id = ${input.match_id} AND participant_id = ${f.participant_id} AND team_position IS NULL`).count;
      } else if (f.field === "kills" || f.field === "deaths" || f.field === "assists") {
        next = { [f.field]: f.value };
        n = (await tx`UPDATE match_participant SET ${tx(f.field)} = ${f.value as number}
                       WHERE match_id = ${input.match_id} AND participant_id = ${f.participant_id}
                         AND ${tx(f.field)} IS NULL`).count;
      }
      // 실제로 바뀐 칸만 적는다. 경쟁으로 이미 채워졌으면 채운 게 아니다.
      if (n > 0) {
        filled.push({ ...f, at: now });
        for (const [field, after] of Object.entries(next)) {
          auto.push({ ...cell, field, match_id: input.match_id, lead_id: input.lead_id, before: cur?.[field] ?? null, after });
        }
      }
    }
    await recordAutoChangesInTx(tx, auto);
    if (filled.length) {
      await rederiveEncountersInTx(tx, input.match_id);
      const after = await affectedStreamers(tx, input.match_id);
      await recomputeChampionStatsInTx(tx, [...new Set([...before, ...after])]);
    }
  }

  // 이 VOD 의 사진만, 사람이 고치지 않은 것만 잇는다.
  // 새로 이어진 사진이 있는지 먼저 센다 — 같은 사진을 다시 보내는 것은 새 증거가 아니다(검수 버전 판단용).
  const newlyAttached = input.frame_ids.length === 0 ? 0 : (await tx<{ n: number }[]>`
    SELECT count(*)::int AS n FROM match_evidence_frame
     WHERE id = ANY(${input.frame_ids}::uuid[]) AND lead_id = ${input.lead_id}::uuid AND reviewed_at IS NULL
       AND match_id IS DISTINCT FROM ${input.match_id}`)[0].n;
  const attached = input.frame_ids.length === 0 ? 0 : (await tx`
    UPDATE match_evidence_frame SET match_id = ${input.match_id}
     WHERE id = ANY(${input.frame_ids}::uuid[]) AND lead_id = ${input.lead_id}::uuid AND reviewed_at IS NULL`).count;

  await tx`
    INSERT INTO match_pov (match_id, lead_id, streamer_id, role, source, observed, link_basis, filled, history, submitted_at)
    VALUES (${input.match_id}, ${input.lead_id}::uuid, ${owner}, ${role}, ${input.source},
            ${tx.json(observed as never)}, ${input.link_basis?.trim() || null},
            ${tx.json(filled as never)}, ${tx.json(history as never)}, now())
    ON CONFLICT (match_id, lead_id) DO UPDATE SET
      source       = EXCLUDED.source,
      observed     = EXCLUDED.observed,
      link_basis   = COALESCE(EXCLUDED.link_basis, match_pov.link_basis),
      filled       = match_pov.filled || EXCLUDED.filled,
      history      = match_pov.history || EXCLUDED.history,
      submitted_at = now()`;

  const current = (await loadStoredMatchInTx(tx, input.match_id))!;
  const final = comparePov(current, observed);
  const summary = summarizeComparison(final);
  // ★ 검수 완료 뒤 새 시점이 다른 값을 가져오면 **완료를 푼다.** 경기 값을 덮지 않으므로 값 변경으로
  //   풀리는 0043 트리거가 안 걸린다 — 그대로 두면 상세에는 "미해결" 인데 목록에는 "검수 완료" 로 남아
  //   사람이 새 오류를 못 본다. 풀면 미검수 목록에 다시 뜨고, 확인 후 다시 완료하면 "검수 완료된 불일치" 가 된다.
  let reopened = false;
  if (current.review_completed_at != null && summary.mismatch_open > 0) {
    await tx`UPDATE match SET review_completed_at = NULL, review_version = review_version + 1
              WHERE match_id = ${input.match_id}`;
    // ★ 완료가 풀린 사실을 남긴다. 안 남기면 "완료가 왜 풀렸나"를 기록으로 가릴 수 없다 —
    //   2026-10-02 에 puuid 교체로 풀린 442경기를 기록으로 복구할 때, 이 경로로 정당하게 풀린 1경기까지 되살렸다.
    await tx`INSERT INTO review_change (match_id, lead_id, entity, entity_key, field, before, after)
             VALUES (${input.match_id}, ${input.lead_id}, 'match', ${input.match_id}, 'review_completed', ${tx.json(true)}, ${tx.json(false)})`;
    reopened = true;
  }
  // ★ 검수 화면을 열어 둔 사이에 새 관측·새 사진이 들어오면 완료 클릭이 거부돼야 한다(setMatchReviewCompleted 가 review_version 을 본다).
  //   값이 안 바뀌는 새 시점(경기 값을 안 채움)은 0043 트리거가 안 걸려 버전이 그대로였고, 사람이 못 본 증거까지 "검수 완료"가 됐다.
  //   **실제로 내용이 달라졌을 때만** 올린다 — 같은 제출을 다시 보내는 것은 검수를 방해하지 않는다. 이미 위에서 올렸으면 또 올리지 않는다.
  const contentChanged = !prev || !isDeepStrictEqual(prev.observed, observed) || newlyAttached > 0;
  if (contentChanged && !reopened) {
    await tx`UPDATE match SET review_version = review_version + 1 WHERE match_id = ${input.match_id}`;
  }
  return { role: prev?.role ?? role, filled, attached, locked, lock_reason: lock.mode === "match" ? lock.reason : null, kept, reopened, summary, unmatched: final.unmatched };
}

/** 경기에 붙은 시점들. 경기를 만든 시점 → 먼저 붙은 순. */
export async function listMatchPovsInTx(tx: Tx | postgres.Sql, matchId: string): Promise<MatchPovRow[]> {
  return tx<MatchPovRow[]>`
    SELECT * FROM match_pov WHERE match_id = ${matchId}
     ORDER BY (role = 'created') DESC, created_at`;
}

export interface PovView extends MatchPovRow {
  streamer_name: string | null;
  lead_title: string;
  lead_url: string | null;
  lead_source_key: string;
  frames: Array<{ id: string; frame_path: string; at_sec: number | null; kind: string }>;
  comparison: ReturnType<typeof comparePov>;
  summary: ReturnType<typeof summarizeComparison>;
}

/** 검수 화면용 — 경기 하나에 붙은 모든 시점과 각자의 사진·비교. */
export async function getMatchPovViews(matchId: string): Promise<PovView[]> {
  const sql = db();
  const stored = await loadStoredMatchInTx(sql, matchId);
  if (!stored) return [];
  const povs = await sql<(MatchPovRow & { streamer_name: string | null; lead_title: string; lead_url: string | null; lead_source_key: string })[]>`
    SELECT p.*, s.display_name AS streamer_name, el.title AS lead_title, el.url AS lead_url, el.source_key AS lead_source_key
      FROM match_pov p
      JOIN event_lead el ON el.id = p.lead_id
      LEFT JOIN streamer s ON s.id = p.streamer_id
     WHERE p.match_id = ${matchId}
     ORDER BY (p.role = 'created') DESC, p.created_at`;
  const frames = await sql<{ id: string; lead_id: string; frame_path: string; at_sec: number | null; kind: string }[]>`
    SELECT id, lead_id, frame_path, at_sec, kind FROM match_evidence_frame
     WHERE match_id = ${matchId} ORDER BY at_sec NULLS LAST, frame_path`;
  return povs.map((p) => {
    const comparison = comparePov(stored, p.observed);
    return {
      ...p,
      frames: frames.filter((f) => f.lead_id === p.lead_id),
      comparison,
      summary: summarizeComparison(comparison),
    };
  });
}

export interface EventPovLead {
  lead_id: string;
  source_key: string;
  title: string;
  url: string | null;
  observed_at: Date;
  streamer_name: string | null;
  /** 이 VOD 에서 나온 이 대회 경기 수. */
  match_count: number;
  /** 이 VOD 가 만든 경기가 있나. 검수 화면을 처음 열 때 이 시점을 먼저 보여 준다. */
  creates: boolean;
  /** 이 시점이 읽은 값 중 경기 값과 다른 채 아직 사람이 안 본 칸 수(계산값). */
  mismatch_open: number;
}

/**
 * 대회 하나를 찍은 VOD 들 — 검수 화면 맨 위 시점 칩. 방송마다 시간축이 달라서, 칩을 고르면
 * 큐·프레임·미니맵이 그 VOD 기준으로 통째로 바뀐다. 한 방송이 VOD 둘로 나뉘면 칩도 둘이다.
 */
export async function listEventPovLeads(eventId: string): Promise<EventPovLead[]> {
  const sql = db();
  const leads = await sql<Omit<EventPovLead, "mismatch_open">[]>`
    SELECT el.id AS lead_id, el.source_key, el.title, el.url, el.observed_at,
           (SELECT s.display_name FROM streamer s
             WHERE s.id = COALESCE(el.streamer_id, (
               SELECT c.streamer_id FROM streamer_channel c
                WHERE c.channel_id = el.channel_id AND c.platform = 'soop'
                ORDER BY c.active_to IS NULL DESC LIMIT 1))) AS streamer_name,
           count(DISTINCT lm.match_id)::int AS match_count,
           COALESCE(bool_or(p.role = 'created'), false) AS creates
      FROM lead_match lm
      JOIN match m ON m.match_id = lm.match_id
      LEFT JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code
      JOIN event_lead el ON el.id = lm.lead_id
      LEFT JOIN match_pov p ON p.match_id = lm.match_id AND p.lead_id = lm.lead_id
     WHERE COALESCE(ms.event_id, m.event_id) = ${eventId}::uuid AND el.source_key LIKE 'vod:%'
     GROUP BY el.id
     ORDER BY el.observed_at, el.source_key`;
  const open = new Map<string, number>();
  const matchIds = (await sql<{ match_id: string }[]>`
    SELECT m.match_id FROM match m LEFT JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code
     WHERE COALESCE(ms.event_id, m.event_id) = ${eventId}::uuid`).map((r) => r.match_id);
  for (const id of matchIds) {
    for (const v of await getMatchPovViews(id)) open.set(v.lead_id, (open.get(v.lead_id) ?? 0) + v.summary.mismatch_open);
  }
  return leads.map((l) => ({ ...l, mismatch_open: open.get(l.lead_id) ?? 0 }));
}

/** 검수 화면의 "이 시점이 읽은 값과 다른 칸" — 경기별로. 일치한 칸은 싣지 않는다. */
export interface PovDiffRow {
  participant_id: number | null;
  who: string;
  field: string;
  stored: unknown;
  observed: unknown;
  status: "mismatch_open" | "mismatch_reviewed" | "pending" | "empty";
}

export async function povDiffsForLead(leadId: string, matchIds: string[]): Promise<Record<string, { compared: number; rows: PovDiffRow[] }>> {
  const out: Record<string, { compared: number; rows: PovDiffRow[] }> = {};
  for (const matchId of matchIds) {
    const view = (await getMatchPovViews(matchId)).find((v) => v.lead_id === leadId);
    if (!view) continue;
    out[matchId] = {
      compared: view.summary.compared,
      rows: view.comparison.items.filter((i) => i.status !== "agree").map((i) => ({
        participant_id: i.participant_id,
        who: i.scope === "match" ? "경기" : i.key,
        field: i.field,
        stored: i.stored,
        observed: i.observed,
        status: (i.status === "mismatch" ? (i.reviewed ? "mismatch_reviewed" : "mismatch_open") : i.status) as PovDiffRow["status"],
      })),
    };
  }
  return out;
}
