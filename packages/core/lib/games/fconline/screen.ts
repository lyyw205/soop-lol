/**
 * 넥슨 API 없이 VOD 결과 화면으로만 아는 FC 경기의 저장·합침 (docs/FCO-SCREEN-MATCH-DESIGN.md).
 *
 * ★ 이 파일은 API 경로(ingest.ts·sync.ts)를 건드리지 않는다. 화면 경기는 match.source='manual' + origin='vod_scan',
 *   처음엔 visibility='hidden'(검수 전)이다. fco_match_detail 행이 없고 ouid 가 NULL 이라 기존 공개 조회에는 구조상 안 나온다.
 * ★ 화면에서 못 읽은 값은 NULL 이다 — 스코어를 못 읽었으면 outcome 은 unknown, 같은 점수는 승부차기 가능성이 있어 unknown 이다.
 *
 * 규칙 (설계 §3.4)
 *   R1  API 가 줄 수 있는 경기는 만들지 않는다 — 이미 API 경기가 있으면 api_exists, 최근 30일 안이고 등록 계정이 있어
 *       곧 올 경기면 api_expected. 두 경우 모두 호출자가 맥락·근거를 API 경기에 붙인다.
 *   R2  나중에 API 경기가 들어오면 reconcileFcoScreenMatches() 가 합친다 — 참가자·종료 시각(±3분)·스코어가 **모두** 맞을 때만.
 *   R3  애매하면 합치지 않고 findFcoScreenSuspects() 에 올린다.
 */
import type postgres from "postgres";
import { db } from "../../db/client.ts";

/** 화면 시각의 오차 범위. 결과 화면이 뜬 시각 ≈ 경기 종료 시각이다(FCO-TIME-SAMPLES.md). */
export const SCREEN_TIME_TOLERANCE_SEC = 180;
/** 넥슨 목록이 주는 기간(한국 날짜 기준 최근 30일, FCO-TIME-SAMPLES.md). */
export const FCO_API_WINDOW_DAYS = 30;

export type FcoScreenBasis = "vod_owner" | "manual";
export interface FcoScreenSideInput {
  /** 화면에 보인 이름 그대로. */
  nickname: string;
  /** 화면 스코어. 못 읽었으면 null. */
  score: number | null;
  /** 화면에서 직접 본 결과(승부차기 등). 없으면 점수로 정하되 같은 점수는 unknown. */
  outcome?: "win" | "draw" | "loss";
  /** 사람을 아는 근거가 있으면 slug 와 근거. 등록 계정과 닉네임이 정확히 하나만 일치하면 도구가 알아서 붙인다(nickname_match). */
  streamerSlug?: string;
  basis?: FcoScreenBasis;
}
export interface FcoScreenEvidenceInput { observed: string; why?: string; frame_path?: string }
export interface FcoScreenMatchInput {
  vodTitleNo: number;
  /** 결과 화면의 VOD 전체 초(ck:probe 축 그대로). */
  atSec: number;
  /** 결과 화면이 뜬 실제 시각(VOD 시작 + atSec). ISO. */
  endedAt: string;
  channelId?: string | null;
  modeKey?: string | null;
  sides: [FcoScreenSideInput, FcoScreenSideInput];
  evidence?: FcoScreenEvidenceInput[];
}

export type FcoScreenResult =
  | { status: "created" | "updated"; match_id: string }
  | { status: "api_exists" | "api_expected" | "duplicate_screen"; match_id: string | null; reason: string }
  | { status: "protected"; match_id: string; reason: string };

export const normalizeName = (name: string) => name.normalize("NFKC").trim().replace(/\s+/g, "").toLowerCase();

/** 오늘(한국 날짜) 기준 API 가 주는 가장 오래된 시각 = (오늘 − 30일) 00:00 KST. */
export function fcoApiWindowStart(now: Date = new Date()): Date {
  const kst = new Date(now.getTime() + 9 * 3_600_000);
  const midnightKstAsUtc = Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate()) - 9 * 3_600_000;
  return new Date(midnightKstAsUtc - FCO_API_WINDOW_DAYS * 86_400_000);
}

export function screenMatchId(vodTitleNo: number, atSec: number): string {
  if (!Number.isInteger(vodTitleNo) || vodTitleNo <= 0 || !Number.isInteger(atSec) || atSec < 0) {
    throw new Error("vodTitleNo 와 atSec 는 양의 정수여야 한다");
  }
  return `fcs:${vodTitleNo}@${atSec}`;
}

/** 두 칸의 결과. 점수 둘을 다 읽었고 다르면 확정, 같거나 못 읽었으면 unknown(승부차기 가능). 직접 본 값이 우선이다. */
export function screenOutcomes(sides: FcoScreenMatchInput["sides"]): ["win" | "draw" | "loss" | "unknown", "win" | "draw" | "loss" | "unknown"] {
  const [a, b] = sides;
  if (a.outcome || b.outcome) {
    const flip = (o: "win" | "draw" | "loss") => (o === "win" ? "loss" : o === "loss" ? "win" : "draw");
    const first = a.outcome ?? (b.outcome ? flip(b.outcome) : "draw");
    const second = b.outcome ?? flip(first);
    if (a.outcome && b.outcome && flip(a.outcome) !== b.outcome) throw new Error("두 칸의 직접 본 결과가 서로 맞지 않는다");
    return [first, second];
  }
  if (a.score == null || b.score == null || a.score === b.score) return ["unknown", "unknown"];
  return a.score > b.score ? ["win", "loss"] : ["loss", "win"];
}

export interface SideSig { key: string; score: number | null }
export interface MatchSig { at: number; sides: [SideSig, SideSig] }

/**
 * 같은 경기인지 — 세 가지가 모두 맞아야 "same". 하나라도 모자라면 "maybe"(R3 — 사람이 본다), 어긋나면 "no".
 *   참가자: 두 칸의 키가 (순서 무관) 같다 · 시각: ±SCREEN_TIME_TOLERANCE_SEC · 스코어: 키별로 같다(둘 다 읽었을 때만 확인 가능)
 */
export function compareMatches(a: MatchSig, b: MatchSig): "same" | "maybe" | "no" {
  const ka = a.sides.map((s) => s.key).sort().join("|"), kb = b.sides.map((s) => s.key).sort().join("|");
  const gap = Math.abs(a.at - b.at) / 1000;
  if (ka !== kb || gap > SCREEN_TIME_TOLERANCE_SEC * 3) return "no";
  const scoreOf = (m: MatchSig, key: string) => m.sides.find((s) => s.key === key)?.score ?? null;
  let scoreKnown = true, scoreEqual = true;
  for (const s of a.sides) {
    const x = s.score, y = scoreOf(b, s.key);
    if (x == null || y == null) scoreKnown = false;
    else if (x !== y) scoreEqual = false;
  }
  if (!scoreEqual) return "no";
  return gap <= SCREEN_TIME_TOLERANCE_SEC && scoreKnown ? "same" : "maybe";
}

type Tx = postgres.TransactionSql | postgres.Sql;

interface ResolvedSide { nickname: string; streamerId: string | null; basis: "nickname_match" | FcoScreenBasis | null; key: string; score: number | null }

/** 닉네임이 등록 계정 하나와만 일치할 때만 사람을 붙인다 — 동명이면 붙이지 않는다(부계정 오노출 방지, CLAUDE.md 원칙 2). */
async function resolveSide(tx: Tx, side: FcoScreenSideInput): Promise<ResolvedSide> {
  const nickname = side.nickname.trim();
  if (!nickname) throw new Error("화면 닉네임이 비어 있다");
  let streamerId: string | null = null;
  let basis: ResolvedSide["basis"] = null;
  if (side.streamerSlug) {
    if (!side.basis) throw new Error(`streamerSlug(${side.streamerSlug})에는 basis(vod_owner|manual)가 필요하다 — 근거 없이 사람을 붙이지 않는다`);
    const rows = await tx<{ id: string }[]>`SELECT id FROM streamer WHERE slug = ${side.streamerSlug}`;
    if (!rows[0]) throw new Error(`없는 스트리머: ${side.streamerSlug}`);
    streamerId = rows[0].id; basis = side.basis;
  } else {
    const rows = await tx<{ streamer_id: string }[]>`
      SELECT DISTINCT link.streamer_id
        FROM fco_account a JOIN streamer_fco_account link ON link.ouid = a.ouid AND link.visibility = 'public'
       WHERE lower(regexp_replace(a.nickname, '[[:space:]]+', '', 'g')) = ${normalizeName(nickname)}
    `;
    if (rows.length === 1) { streamerId = rows[0].streamer_id; basis = "nickname_match"; }
  }
  return { nickname, streamerId, basis, key: streamerId ?? `name:${normalizeName(nickname)}`, score: side.score };
}

const sigOf = (at: Date | string, sides: { key: string; score: number | null }[]): MatchSig =>
  ({ at: new Date(at).getTime(), sides: [sides[0], sides[1]] });

/**
 * 화면에서 읽은 FC 경기 하나를 저장한다. 같은 (VOD, 초)는 같은 경기 ID 라 다시 불러도 한 번만 남는다(멱등).
 * 검수된(reviewed_at) 화면 경기는 덮어쓰지 않는다 — protected.
 */
export async function saveFcoScreenMatch(input: FcoScreenMatchInput): Promise<FcoScreenResult> {
  const matchId = screenMatchId(input.vodTitleNo, input.atSec);
  const endedAt = new Date(input.endedAt);
  if (Number.isNaN(endedAt.valueOf())) throw new Error(`endedAt 을 읽을 수 없다: ${input.endedAt}`);
  const outcomes = screenOutcomes(input.sides);
  const sql = db();
  return sql.begin(async (tx) => {
    const existing = await tx<{ reviewed_at: Date | null; source: string; game_code: string }[]>`
      SELECT reviewed_at, source, game_code FROM match WHERE match_id = ${matchId} FOR UPDATE`;
    if (existing[0] && (existing[0].game_code !== "fconline" || existing[0].source !== "manual")) {
      throw new Error(`${matchId} 는 화면 경기가 아니다`);
    }
    if (existing[0]?.reviewed_at) return { status: "protected", match_id: matchId, reason: "검수된 경기라 덮어쓰지 않는다" } as const;

    const sides = [await resolveSide(tx, input.sides[0]), await resolveSide(tx, input.sides[1])] as const;
    if (sides[0].key === sides[1].key) throw new Error("두 칸이 같은 사람이다 — 닉네임·slug 를 확인한다");
    const sig = sigOf(endedAt, [sides[0], sides[1]]);

    // R1 — API 경기가 이미 있나. 화면 경기가 이미 있으면(다른 VOD 가 같은 경기를 찍음) 거기에 합친다.
    const near = await tx<{ match_id: string; source: string; game_creation: Date }[]>`
      SELECT m.match_id, m.source, m.game_creation FROM match m
       WHERE m.game_code = 'fconline' AND m.match_id <> ${matchId}
         AND NOT EXISTS (SELECT 1 FROM fco_screen_link l WHERE l.screen_match_id = m.match_id)
         AND m.game_creation BETWEEN ${new Date(endedAt.getTime() - SCREEN_TIME_TOLERANCE_SEC * 3000)}
                                 AND ${new Date(endedAt.getTime() + SCREEN_TIME_TOLERANCE_SEC * 3000)}`;
    for (const cand of near) {
      const parts = await tx<{ nickname: string; streamer_id: string | null; ouid: string | null; score: number | null }[]>`
        SELECT nickname, streamer_id, ouid, coalesce(score_display, goals) AS score
          FROM fco_match_participant WHERE match_id = ${cand.match_id} ORDER BY side_no`;
      if (parts.length !== 2) continue;
      const candSig = sigOf(cand.game_creation, parts.map((p) => ({ key: p.streamer_id ?? `name:${normalizeName(p.nickname)}`, score: p.score })));
      const verdict = compareMatches(sig, candSig);
      if (verdict !== "same") continue; // maybe 는 R3: 합치지 않고 만든 뒤 의심 목록에 오른다
      return cand.source === "provider_api"
        ? { status: "api_exists", match_id: cand.match_id, reason: "같은 경기의 API 기록이 이미 있다 — 맥락·근거는 그 경기에 붙인다" } as const
        : { status: "duplicate_screen", match_id: cand.match_id, reason: "다른 VOD 가 같은 경기를 이미 기록했다 — 근거만 더한다" } as const;
    }
    // R1 — 곧 올 API 경기: 최근 30일 안이고 한쪽이라도 등록 계정이 있다(자동 수집이 받아 간다). 등록 계정이 없으면 API 가 못 준다 → 만든다.
    if (endedAt >= fcoApiWindowStart()) {
      const registered = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM streamer_fco_account
         WHERE streamer_id = ANY(${sides.map((s) => s.streamerId).filter((x): x is string => x !== null)}::uuid[]) AND visibility = 'public'`;
      if ((registered[0]?.n ?? 0) > 0) {
        return { status: "api_expected", match_id: null, reason: "최근 30일 안이고 등록 계정이 있다 — 자동 수집이 받아 온다. API 경기가 들어온 뒤 거기에 붙인다" } as const;
      }
    }

    await tx`
      INSERT INTO match (match_id, game_code, mode_key, game_creation, source, origin, source_url, visibility)
      VALUES (${matchId}, 'fconline', ${input.modeKey ?? null}, ${endedAt}, 'manual', 'vod_scan',
              ${`https://vod.sooplive.com/player/${input.vodTitleNo}`}, 'hidden')
      ON CONFLICT (match_id) DO UPDATE SET game_creation = EXCLUDED.game_creation, mode_key = EXCLUDED.mode_key`;
    await tx`DELETE FROM fco_match_participant WHERE match_id = ${matchId}`;
    for (const [i, s] of sides.entries()) {
      await tx`
        INSERT INTO fco_match_participant (match_id, side_no, ouid, nickname, streamer_id, identity_basis, outcome, goals, score_display)
        VALUES (${matchId}, ${i + 1}, NULL, ${s.nickname}, ${s.streamerId}, ${s.basis}, ${outcomes[i]}, NULL, ${s.score})`;
    }
    for (const [i, ev] of (input.evidence ?? []).entries()) {
      if (!ev.observed?.trim()) throw new Error("evidence.observed 는 비울 수 없다 — 본 것을 적는다");
      await tx`
        INSERT INTO fco_context_evidence (match_id, evidence_key, kind, vod_title_no, channel_id, at_sec, observed, why, frame_path, role, created_by)
        VALUES (${matchId}, ${`screen:${input.vodTitleNo}@${input.atSec}#${i}`}, 'vod_frame', ${input.vodTitleNo}, ${input.channelId ?? null},
                ${input.atSec}, ${ev.observed}, ${ev.why ?? null}, ${ev.frame_path ?? null}, 'result', 'auto')
        ON CONFLICT (match_id, evidence_key) DO UPDATE SET observed = EXCLUDED.observed, why = EXCLUDED.why, frame_path = EXCLUDED.frame_path`;
    }
    return { status: existing[0] ? "updated" : "created", match_id: matchId } as const;
  });
}

interface ScreenRow { match_id: string; game_creation: Date; parts: { nickname: string; streamer_id: string | null; ouid: string | null; score: number | null }[] }

async function loadScreenRows(tx: Tx, where: "pending" | "all"): Promise<ScreenRow[]> {
  return tx<ScreenRow[]>`
    SELECT m.match_id, m.game_creation,
           (SELECT json_agg(json_build_object('nickname', p.nickname, 'streamer_id', p.streamer_id, 'ouid', p.ouid,
                                              'score', coalesce(p.score_display, p.goals)) ORDER BY p.side_no)
              FROM fco_match_participant p WHERE p.match_id = m.match_id) AS parts
      FROM match m
     WHERE m.game_code = 'fconline' AND m.source = 'manual' AND m.origin = 'vod_scan'
       AND NOT EXISTS (SELECT 1 FROM fco_screen_link l WHERE l.screen_match_id = m.match_id)
       ${where === "pending" ? tx`AND m.reviewed_at IS NULL` : tx``}`;
}

const rowSig = (r: { game_creation: Date; parts: ScreenRow["parts"] }): MatchSig =>
  sigOf(r.game_creation, r.parts.map((p) => ({ key: p.streamer_id ?? `name:${normalizeName(p.nickname)}`, score: p.score })));

/**
 * R2 — API 경기가 들어온 뒤, 같은 경기인 화면 경기를 합친다(자동은 세 조건이 모두 맞을 때만). 여러 번 불러도 같다.
 * 합친 화면 경기는 지우지 않고 숨기고(fco_screen_link), 근거는 API 경기로 옮긴다. API 저장 경로(saveFcoMatch)에서 부르지 않고
 * 자동 수집이 끝난 뒤 따로 부른다 — API 경로를 안 건드리기 위해서다.
 */
export async function reconcileFcoScreenMatches(): Promise<{ linked: { screen: string; api: string }[]; suspects: number }> {
  const sql = db();
  return sql.begin(async (tx) => {
    const screens = await loadScreenRows(tx, "all");
    const linked: { screen: string; api: string }[] = [];
    let suspects = 0;
    for (const s of screens) {
      const sig = rowSig(s);
      const apis = await tx<ScreenRow[]>`
        SELECT m.match_id, m.game_creation,
               (SELECT json_agg(json_build_object('nickname', p.nickname, 'streamer_id', p.streamer_id, 'ouid', p.ouid,
                                                  'score', coalesce(p.score_display, p.goals)) ORDER BY p.side_no)
                  FROM fco_match_participant p WHERE p.match_id = m.match_id) AS parts
          FROM match m
         WHERE m.game_code = 'fconline' AND m.source = 'provider_api'
           AND m.game_creation BETWEEN ${new Date(sig.at - SCREEN_TIME_TOLERANCE_SEC * 3000)} AND ${new Date(sig.at + SCREEN_TIME_TOLERANCE_SEC * 3000)}`;
      const verdicts = apis.map((a) => ({ a, v: compareMatches(sig, rowSig(a)) })).filter((x) => x.v !== "no");
      const same = verdicts.filter((x) => x.v === "same");
      if (same.length === 1 && verdicts.length === 1) {
        const api = same[0].a;
        await tx`INSERT INTO fco_screen_link (screen_match_id, api_match_id, basis, decided_by)
                 VALUES (${s.match_id}, ${api.match_id},
                         ${tx.json({ participants: "same", time_gap_sec: Math.round(Math.abs(sig.at - rowSig(api).at) / 1000), score: "same" })}, 'auto')
                 ON CONFLICT (screen_match_id) DO NOTHING`;
        await tx`UPDATE match SET visibility = 'hidden' WHERE match_id = ${s.match_id}`;
        // 근거를 API 경기로 옮긴다 — 같은 키가 이미 있으면 건너뛴다.
        await tx`
          INSERT INTO fco_context_evidence (match_id, evidence_key, kind, vod_title_no, channel_id, at_sec, end_sec, url, observed, why, frame_path, role, created_by)
          SELECT ${api.match_id}, evidence_key, kind, vod_title_no, channel_id, at_sec, end_sec, url, observed, why, frame_path, role, created_by
            FROM fco_context_evidence WHERE match_id = ${s.match_id}
          ON CONFLICT (match_id, evidence_key) DO NOTHING`;
        linked.push({ screen: s.match_id, api: api.match_id });
      } else if (verdicts.length > 0) {
        suspects += 1; // R3: 후보가 둘 이상이거나 조건 하나가 모자란다 — 합치지 않고 사람에게 남긴다
      }
    }
    return { linked, suspects };
  });
}

export interface FcoScreenSuspect { screen_match_id: string; other_match_id: string; other_source: string; verdict: "maybe" }

/** R3 — 합치지 않았지만 같은 경기일 수 있는 쌍(API·화면 모두). 검수 화면이 읽는다. */
export async function findFcoScreenSuspects(): Promise<FcoScreenSuspect[]> {
  const sql = db();
  const screens = await loadScreenRows(sql, "all");
  const out: FcoScreenSuspect[] = [];
  for (const s of screens) {
    const sig = rowSig(s);
    const others = await sql<(ScreenRow & { source: string })[]>`
      SELECT m.match_id, m.game_creation, m.source,
             (SELECT json_agg(json_build_object('nickname', p.nickname, 'streamer_id', p.streamer_id, 'ouid', p.ouid,
                                                'score', coalesce(p.score_display, p.goals)) ORDER BY p.side_no)
                FROM fco_match_participant p WHERE p.match_id = m.match_id) AS parts
        FROM match m
       WHERE m.game_code = 'fconline' AND m.match_id <> ${s.match_id}
         AND m.game_creation BETWEEN ${new Date(sig.at - SCREEN_TIME_TOLERANCE_SEC * 3000)} AND ${new Date(sig.at + SCREEN_TIME_TOLERANCE_SEC * 3000)}`;
    for (const o of others) {
      if (!o.parts || o.parts.length !== 2) continue;
      if (compareMatches(sig, rowSig(o)) === "maybe") out.push({ screen_match_id: s.match_id, other_match_id: o.match_id, other_source: o.source, verdict: "maybe" });
    }
  }
  return out;
}
