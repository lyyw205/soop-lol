/**
 * **이미 저장된 공개 수기 LoL 경기 중 같은 판으로 보이는 쌍** — 저장을 막지 않고 의심만 보여 준다.
 *
 * ★ 왜 조회 시점에 계산하나 (2026-10-09)
 *   저장 검사(`assertNotDuplicateGameInTx`)는 새 경기 ID 를 만들 때 한 번만 돈다. 그런데 먼저 저장된 쪽이
 *   이름만 있는 뼈대(KDA·챔피언·길이 비어 있음)였다가 나중에 자동 판독이 채운 경우, 저장 순간엔 비교할 값이
 *   없어 통과했다 — 확정 중복 14쌍 중 11쌍이 이 경우였다. 값이 바뀌는 쓰기 경로마다 재검사를 다는 대신
 *   지금 값으로 그때그때 계산한다. 경로를 하나 빠뜨려 다시 새는 일이 없다.
 * ★ 판정은 저장 검사와 같은 함수다(`metrics/ck-duplicate.ts` — 시간 범위·사람 대응·이름 무관 일치).
 * ★ 사람이 "다른 판" 이라고 확인한 쌍(`distinct_from`, review_change 에 남는다)은 다시 띄우지 않는다.
 * ★ 숨긴 경기는 보지 않는다 — 중복으로 정리된 쪽이다. 단 **숨기기만 하고 근거(프레임·시점)가 남은 경기**는
 *   공개 쪽과 짝지어 따로 띄운다(`hidden`). 10/04·10/07·10/09 에 숨기기만 한 59경기의 근거가 숨긴 경기에 남아
 *   공개 경기 검수 화면에서 그 시점이 안 보였다. 합치면(mergeDuplicateMatch) 근거가 옮겨지고 목록에서 빠진다.
 */
import type postgres from "postgres";

import { db } from "./client.ts";
import { applyMatchReviewInTx, lockCkMatchWritesInTx, recordReviewChanges } from "./ck.ts";
import {
  blindOverlap, BLIND_MIN, duplicateParticipantCounts, isDuplicateGame, kdaOverlap, withinDuplicateWindow, type DuplicateParticipant,
} from "../metrics/ck-duplicate.ts";

export interface DuplicateSuspect {
  a: string;
  b: string;
  /** a 의 시작 시각(KST 표시는 화면이 한다). */
  played_at: Date;
  kda: number;
  champ: number;
  blind: number;
  duration_a: number | null;
  duration_b: number | null;
  /** 이미 숨긴 쪽(a 또는 b) — 숨기기만 하고 근거가 남은 경우. null 이면 둘 다 공개. */
  hidden: string | null;
}

interface Row {
  match_id: string;
  game_duration: number | null;
  game_creation: Date;
  game_creation_precision: string;
  public: boolean;
  participants: DuplicateParticipant[];
}

type Tx = postgres.TransactionSql;

/** 같은 날짜 판정이 24시간을 넘지 않으므로 그 안에서만 짝을 본다(시각 순서로 — 경기 ID 순서가 아니다). */
const PAIR_HORIZON_MS = 26 * 3600_000;

export async function listDuplicateSuspects(): Promise<DuplicateSuspect[]> {
  const sql = db();
  const rows = await sql<Row[]>`
    SELECT m.match_id, m.game_duration, m.game_creation, m.game_creation_precision, m.visibility = 'public' AS public,
           jsonb_agg(jsonb_build_object(
             'person_id', COALESCE(sa.streamer_id, p.streamer_id),
             'puuid', p.puuid, 'observed_name', p.observed_name,
             'win', CASE WHEN p.outcome IN ('win', 'loss') THEN p.outcome = 'win' ELSE NULL END,
             'champion_id', p.champion_id, 'kills', p.kills, 'deaths', p.deaths, 'assists', p.assists
           ) ORDER BY p.participant_id) AS participants
      FROM match m JOIN match_participant p ON p.match_id = m.match_id
      LEFT JOIN streamer_account sa ON sa.puuid = p.puuid AND sa.active_to IS NULL
     WHERE m.game_code = 'lol' AND m.source = 'manual'
       AND (m.visibility = 'public'
         OR ((EXISTS (SELECT 1 FROM match_evidence_frame f WHERE f.match_id = m.match_id)
              OR EXISTS (SELECT 1 FROM match_pov v WHERE v.match_id = m.match_id))
             AND NOT EXISTS (SELECT 1 FROM review_change c WHERE c.match_id = m.match_id AND c.field = 'merged_into')))
     GROUP BY m.match_id, m.game_duration, m.game_creation, m.game_creation_precision, m.visibility
     ORDER BY m.game_creation, m.match_id`;
  const distinct = await sql<{ match_id: string; other: string }[]>`
    SELECT match_id, jsonb_array_elements_text(after) AS other
      FROM review_change WHERE field = 'distinct_from' AND jsonb_typeof(after) = 'array'`;
  const confirmedDifferent = new Set(distinct.flatMap((d) => [`${d.match_id}|${d.other}`, `${d.other}|${d.match_id}`]));
  const out: DuplicateSuspect[] = [];
  for (let i = 0; i < rows.length; i++) {
    const a = rows[i];
    for (let j = i + 1; j < rows.length; j++) {
      const b = rows[j];
      if (b.game_creation.getTime() - a.game_creation.getTime() > PAIR_HORIZON_MS) break;
      if (!a.public && !b.public) continue;
      if (confirmedDifferent.has(`${a.match_id}|${b.match_id}`)) continue;
      if (!withinDuplicateWindow({ at: a.game_creation, precision: a.game_creation_precision },
        { at: b.game_creation, precision: b.game_creation_precision })) continue;
      const counts = { ...duplicateParticipantCounts(a.participants, b.participants), blind: blindOverlap(a.participants, b.participants) };
      if (!isDuplicateGame(a.game_duration, b.game_duration, counts)) continue;
      out.push({ a: a.match_id, b: b.match_id, played_at: a.game_creation, ...counts, duration_a: a.game_duration, duration_b: b.game_duration,
        hidden: a.public ? (b.public ? null : b.match_id) : a.match_id });
    }
  }
  return out;
}

/**
 * 두 경기를 대조해 **다른 판**이라고 확인했을 때 남긴다 — 의심 목록에 다시 뜨지 않고, 합치기도 거부된다.
 * 저장 때의 `distinct_from` 과 같은 이력(review_change, 숨긴 쪽이 아니라 b 에 a 를 적는다)이다. 이미 있으면 할 일이 없다.
 */
export async function markDistinctMatches(a: string, b: string, opts: { apply: boolean }): Promise<{ already: boolean }> {
  if (a === b) throw new Error("같은 경기다.");
  const sql = db();
  const found = await sql<{ match_id: string }[]>`SELECT match_id FROM match WHERE match_id IN (${a}, ${b})`;
  if (found.length !== 2) throw new Error(`경기가 없다: ${[a, b].filter((id) => !found.some((f) => f.match_id === id)).join(", ")}`);
  const [existing] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM review_change
     WHERE field = 'distinct_from' AND jsonb_typeof(after) = 'array'
       AND ((match_id = ${a} AND after ? ${b}) OR (match_id = ${b} AND after ? ${a}))`;
  if (existing.n > 0) return { already: true };
  if (opts.apply) {
    await sql.begin((tx) => recordReviewChanges(tx, [{ match_id: b, entity: "match", entity_key: b, field: "distinct_from", before: null, after: [a] }]));
  }
  return { already: false };
}

// ── 확정된 같은 판 정리 ─────────────────────────────────────────────

export interface DuplicateMergeInput {
  /** 남길 경기 — 공개 경기여야 한다. */
  keep: string;
  /** 숨길 경기. 이미 숨긴 경기도 받는다(앞서 손으로 숨기고 근거만 남은 경우를 마저 옮긴다). */
  drop: string;
  /** 같은 판이라고 확인한 근거(두 결과창을 무엇으로 대조했나). 비우면 거부한다. */
  evidence: string;
}

export interface DuplicateMergePlan {
  keep: string;
  drop: string;
  /** 이미 정리된 쌍 — 옮길 것이 없고 숨김도 끝났다. */
  already: boolean;
  frames_moved: number;
  povs_moved: string[];
  /** 같은 방송의 시점 기록이 양쪽에 있어 옮기지 않은 것 — 숨긴 쪽에 그대로 남는다. */
  povs_kept_on_drop: string[];
  /** 경기에 붙는 판독 메모는 최종 근거(경기당 하나)뿐이다. 남길 쪽에 없으면 옮긴다. */
  final_evidence_moved: boolean;
  /** 양쪽 모두 최종 근거가 있으면 남길 쪽 것이 기준이고, 숨긴 쪽 것은 숨긴 쪽에 남는다. */
  final_evidence_kept_on_drop: boolean;
  candidates_relinked: number;
  hidden: boolean;
  /** 양쪽 다 읽었는데 값이 어긋나는 자리(한쪽이 못 읽은 칸은 차이가 아니다). 값은 고치지 않고 보고만 한다. */
  value_differences: string[];
  /** 숨길 쪽에만 있던 묶음 정보(시리즈·대회). 근거 없이 옮기지 않는다. */
  drop_grouping: { series_id: string | null; event_id: string | null };
}

class DryRun extends Error {
  readonly plan: DuplicateMergePlan;
  constructor(plan: DuplicateMergePlan) { super("dry-run"); this.plan = plan; }
}

/**
 * 사진으로 같은 판이라고 확인한 두 경기를 하나로 합친다. 한 트랜잭션이다 — 중간에 실패하면 아무것도 안 바뀐다.
 *
 * ★ 지우지 않는다. 숨길 쪽은 공개에서 빼고(통계·상대전적 재계산), 근거(프레임)·시점 기록·최종 근거·VOD 후보 연결을
 *   남길 쪽으로 옮긴다. 옮길 수 없는 것(같은 방송의 시점 기록이 양쪽에 있음, 경기당 하나인 최종 근거)은 숨긴 쪽에
 *   그대로 남겨 이력이 끊기지 않게 한다.
 * ★ 값은 고치지 않는다. 두 경기의 값이 다르면 차이만 돌려준다 — 어느 쪽이 맞는지는 사람이 화면으로 정한다.
 * ★ 값으로도 같은 판 후보가 아니면 거부한다(사진 대조를 대신하지 않고, 잘못된 쌍을 합치는 것만 막는다).
 *   후보 판정(isDuplicateGame) 또는 승패·KDA 묶음 8명 일치(kdaOverlap — 챔피언을 못 읽은 기록용).
 *   사람이 다른 판이라고 확인한 쌍(distinct_from)도 거부한다.
 * 다시 실행하면 이미 정리된 쌍으로 끝난다.
 */
export async function mergeDuplicateMatch(input: DuplicateMergeInput, opts: { apply: boolean }): Promise<DuplicateMergePlan> {
  try {
    return await db().begin(async (tx) => {
      const plan = await mergeDuplicateMatchInTx(tx, input);
      if (!opts.apply) throw new DryRun(plan);
      return plan;
    }) as DuplicateMergePlan;
  } catch (e) {
    if (e instanceof DryRun) return e.plan;
    throw e;
  }
}

export async function mergeDuplicateMatchInTx(tx: Tx, input: DuplicateMergeInput): Promise<DuplicateMergePlan> {
  const { keep, drop } = input;
  if (!input.evidence?.trim()) throw new Error("같은 판이라고 확인한 근거(evidence)가 필요하다.");
  if (keep === drop) throw new Error("남길 경기와 숨길 경기가 같다.");
  await lockCkMatchWritesInTx(tx);
  const rows = await tx<{ match_id: string; visibility: string; game_code: string; source: string; series_id: string | null; event_id: string | null }[]>`
    SELECT match_id, visibility, game_code, source, series_id, event_id FROM match
     WHERE match_id IN (${keep}, ${drop}) ORDER BY match_id FOR UPDATE`;
  const K = rows.find((r) => r.match_id === keep), D = rows.find((r) => r.match_id === drop);
  if (!K || !D) throw new Error(`경기가 없다: ${!K ? keep : drop}`);
  for (const r of [K, D]) if (r.game_code !== "lol" || r.source !== "manual") throw new Error(`${r.match_id}: 수기 LoL 경기만 합친다.`);
  if (K.visibility !== "public") throw new Error(`${keep}: 남길 경기는 공개 경기여야 한다.`);

  // 값으로도 같은 판 후보인지 — 저장 검사·후보 조회와 같은 판정이다.
  const [a, b] = await Promise.all([keep, drop].map((id) => loadForDuplicate(tx, id)));
  const counts = { ...duplicateParticipantCounts(b.participants, a.participants), blind: blindOverlap(b.participants, a.participants) };
  // 사진 대조는 이미 끝났다 — 여기선 잘못된 경기 ID 만 막는다. 챔피언을 못 읽은 기록도 있어 승패·KDA 일치도 받는다.
  const kda = kdaOverlap(b.participants, a.participants);
  if (!(isDuplicateGame(b.game_duration, a.game_duration, counts) || kda >= BLIND_MIN)
    || !withinDuplicateWindow({ at: a.game_creation, precision: a.game_creation_precision }, { at: b.game_creation, precision: b.game_creation_precision })) {
    throw new Error(`${drop} → ${keep}: 값으로는 같은 판 후보가 아니다(이름 무관 ${counts.blind}·승패+KDA ${kda}·사람별 KDA ${counts.kda}·챔피언 ${counts.champ}명 일치) — 합치지 않는다.`);
  }
  const [distinct] = await tx<{ n: number }[]>`
    SELECT count(*)::int AS n FROM review_change
     WHERE field = 'distinct_from' AND jsonb_typeof(after) = 'array'
       AND ((match_id = ${keep} AND after ? ${drop}) OR (match_id = ${drop} AND after ? ${keep}))`;
  if (distinct.n > 0) throw new Error(`${drop} ↔ ${keep}: 다른 판이라고 확인된 쌍이다(distinct_from) — 합치지 않는다.`);

  const frames = await tx`UPDATE match_evidence_frame SET match_id = ${keep} WHERE match_id = ${drop} RETURNING id`;
  const povConflicts = await tx<{ lead_id: string }[]>`
    SELECT d.lead_id FROM match_pov d WHERE d.match_id = ${drop}
       AND EXISTS (SELECT 1 FROM match_pov k WHERE k.match_id = ${keep} AND k.lead_id = d.lead_id)`;
  const povs = await tx<{ lead_id: string }[]>`
    UPDATE match_pov d SET match_id = ${keep}, role = 'added'
     WHERE d.match_id = ${drop}
       AND NOT EXISTS (SELECT 1 FROM match_pov k WHERE k.match_id = ${keep} AND k.lead_id = d.lead_id)
    RETURNING lead_id`;
  const finals = await tx`
    UPDATE review_record SET match_id = ${keep} WHERE match_id = ${drop} AND type = 'final_evidence'
       AND NOT EXISTS (SELECT 1 FROM review_record k WHERE k.match_id = ${keep} AND k.type = 'final_evidence')
    RETURNING id`;
  const [finalOnDrop] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM review_record WHERE match_id = ${drop} AND type = 'final_evidence'`;
  // VOD 후보가 가리키는 경기 ID 를 남길 쪽으로 — VOD↔경기 관계(lead_match)가 숨긴 경기에 머물지 않게.
  const relinked = await tx<{ id: string }[]>`
    UPDATE event_lead el SET raw = jsonb_set(el.raw, '{candidates}', (
      SELECT jsonb_agg(CASE WHEN c->>'match_id' = ${drop} THEN jsonb_set(c, '{match_id}', to_jsonb(${keep}::text)) ELSE c END ORDER BY o)
        FROM jsonb_array_elements(el.raw->'candidates') WITH ORDINALITY AS t(c, o)))
     WHERE jsonb_typeof(el.raw->'candidates') = 'array'
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(el.raw->'candidates') c WHERE c->>'match_id' = ${drop})
    RETURNING el.id`;
  const hidden = D.visibility !== "hidden";
  if (hidden) await applyMatchReviewInTx(tx, drop, { visibility: "hidden" });

  // 양쪽 다 읽은 값끼리 어긋나는 자리만 — 한쪽이 못 읽은 칸(챔피언 0·KDA 빈칸)은 차이가 아니다.
  const agrees = (x: Shown, y: Shown) => x.win === y.win
    && (!(x.champion_id > 0) || !(y.champion_id > 0) || x.champion_id === y.champion_id)
    && (["kills", "deaths", "assists"] as const).every((f) => x[f] === null || y[f] === null || x[f] === y[f]);
  const show = (p: Shown) => `${p.win ? "승" : "패"} 챔피언 ${p.champion_id || "?"} ${p.kills ?? "?"}/${p.deaths ?? "?"}/${p.assists ?? "?"}`;
  const unmatched = [...a.participants];
  const differences: string[] = [];
  for (const p of b.participants) {
    const i = unmatched.findIndex((q) => samePlayer(p, q) && agrees(p, q));
    const j = i >= 0 ? i : unmatched.findIndex((q) => agrees(p, q));
    if (j >= 0) { unmatched.splice(j, 1); continue; }
    const twin = unmatched.find((q) => samePlayer(p, q));
    differences.push(`${p.name ?? "?"}: 숨길 쪽 ${show(p)}${twin ? ` / 남길 쪽 ${show(twin)}` : ""}`);
  }

  const plan: DuplicateMergePlan = {
    keep, drop,
    already: !hidden && frames.length === 0 && povs.length === 0 && finals.length === 0 && relinked.length === 0,
    frames_moved: frames.length, povs_moved: povs.map((p) => p.lead_id), povs_kept_on_drop: povConflicts.map((p) => p.lead_id),
    final_evidence_moved: finals.length > 0, final_evidence_kept_on_drop: finalOnDrop.n > 0, candidates_relinked: relinked.length, hidden,
    value_differences: differences, drop_grouping: { series_id: D.series_id, event_id: D.event_id },
  };
  if (!plan.already) {
    await recordReviewChanges(tx, [
      { match_id: drop, entity: "match", entity_key: drop, field: "merged_into", before: null, after: { keep, evidence: input.evidence.trim() } },
      { match_id: keep, entity: "match", entity_key: keep, field: "merged_from", before: null,
        after: { drop, evidence: input.evidence.trim(), frames: frames.length, povs: povs.length, final_evidence: finals.length, candidates: relinked.length } },
    ]);
  }
  return plan;
}

type Shown = DuplicateParticipant & { name: string | null };
const samePlayer = (x: Shown, y: Shown) => (x.person_id !== null && x.person_id === y.person_id) || (x.name !== null && x.name === y.name);

async function loadForDuplicate(tx: Tx, matchId: string) {
  const [row] = await tx<{ game_duration: number | null; game_creation: Date; game_creation_precision: string; participants: Shown[] }[]>`
    SELECT m.game_duration, m.game_creation, m.game_creation_precision,
           jsonb_agg(jsonb_build_object(
             'name', COALESCE(st.display_name, p.observed_name),
             'person_id', COALESCE(sa.streamer_id, p.streamer_id), 'puuid', p.puuid, 'observed_name', p.observed_name,
             'win', CASE WHEN p.outcome IN ('win', 'loss') THEN p.outcome = 'win' ELSE NULL END,
             'champion_id', p.champion_id, 'kills', p.kills, 'deaths', p.deaths, 'assists', p.assists
           ) ORDER BY p.participant_id) AS participants
      FROM match m JOIN match_participant p ON p.match_id = m.match_id
      LEFT JOIN streamer_account sa ON sa.puuid = p.puuid AND sa.active_to IS NULL
      LEFT JOIN streamer st ON st.id = COALESCE(sa.streamer_id, p.streamer_id)
     WHERE m.match_id = ${matchId}
     GROUP BY m.game_duration, m.game_creation, m.game_creation_precision`;
  if (!row) throw new Error(`${matchId}: 참가자가 없다.`);
  return row;
}
