/**
 * 넥슨 API 없이 VOD 결과 화면으로만 아는 FC 경기의 저장·합침 (docs/FCO-SCREEN-MATCH-DESIGN.md).
 *
 * ★ 이 파일은 API 경로(ingest.ts·sync.ts)를 건드리지 않는다. 화면 경기는 match.source='manual' + origin='vod_scan',
 *   처음엔 visibility='hidden'(검수 전)이다. fco_match_detail 행이 없고 ouid 가 NULL 이라 기존 공개 조회에는 구조상 안 나온다.
 * ★ 화면에서 못 읽은 값은 NULL 이다 — 스코어를 못 읽었으면 outcome 은 unknown, 같은 점수는 승부차기 가능성이 있어 unknown 이다.
 *
 * 규칙 (설계 §3.4, Codex 검토로 R1 을 바꿨다 — 설계 §12)
 *   ★ 읽은 관측은 **항상 먼저 숨긴 채로 저장한다.** "API 가 곧 가져올 것"이라는 예측으로 저장 없이 돌려보내지 않는다 —
 *     API 가 끝내 못 가져오면(등록 계정의 기록에서 빠진 대회 경기 등) 관측이 영구히 사라진다. 숨긴 상태라 이중 집계도 없다.
 *   R1  저장 뒤 같은 경기의 API 경기·다른 화면 경기가 이미 있으면 **연결**한다(근거도 그쪽으로 옮긴다) — 세 조건이 모두 맞고 후보가 하나일 때만.
 *   R2  나중에 API 경기가 들어오면 reconcileFcoScreenMatches() 가 같은 규칙으로 연결한다.
 *   R3  애매하면(조건 하나 부족·후보 둘 이상) 연결하지 않고 needs_review 로 두고 findFcoScreenSuspects() 에 올린다 — 먼저 찾은 것을 고르지 않는다.
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
  /** expect_api: 최근 30일 안이고 등록 계정이 있어 자동 수집이 곧 같은 경기를 가져올 수 있다(오면 reconcile 이 연결한다). */
  | { status: "created" | "updated"; match_id: string; expect_api: boolean }
  /** 같은 경기의 기존 기록(API 또는 다른 화면 경기)에 연결했다. 이 화면 경기는 숨긴 채 남고 근거는 그쪽으로 복사됐다. */
  | { status: "linked"; match_id: string; link_to: string; link_to_source: string }
  /** 후보가 둘 이상이거나 조건 하나가 모자라 연결하지 않았다. 검수 대기. */
  | { status: "needs_review"; match_id: string; candidates: string[] }
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

/** name: 화면·원본에 적힌 닉네임(정규화 전). 사람 키가 다를 때 오독 가능성을 보는 데만 쓴다. */
export interface SideSig { key: string; score: number | null; name?: string }
export interface MatchSig { at: number; sides: [SideSig, SideSig] }

/**
 * 같은 경기인지 — 세 가지가 모두 맞아야 "same". 하나라도 모자라면 "maybe"(R3 — 사람이 본다), 어긋나면 "no".
 *   참가자: 두 칸의 키가 (순서 무관) 같다 · 시각: ±SCREEN_TIME_TOLERANCE_SEC · 스코어: 키별로 같다(둘 다 읽었을 때만 확인 가능)
 */
/** 두 문자열의 편집 거리(삽입·삭제·바꾸기). 짧은 닉네임용. */
export function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/**
 * 같은 경기인지 — 세 가지가 모두 맞아야 "same". 하나라도 모자라면 "maybe"(R3 — 사람이 본다), 어긋나면 "no".
 *   참가자: 두 칸의 키가 (순서 무관) 같다 · 시각: ±SCREEN_TIME_TOLERANCE_SEC · 스코어: 키별로 같다(둘 다 읽었을 때만 확인 가능)
 * ★ 닉네임 오독(5단계 검증 2026-10-01: 뀨뀨rr→꾸꾸rr·걍하리→강하리·잉유진→임유진, 27경기 중 11경기)은 사람 키가 달라져
 *   "다른 경기"가 됐다 — API 경기와 연결되지 않고 숨긴 중복이 남는다. 그래서 키가 달라도 **두 닉네임이 각각 오독 범위 안이고
 *   시각·스코어가 맞으면 "maybe"**(검수 대기)로 올린다(자모 단위 비교 — nearName). 이름으로 사람을 단정하지 않는다 — 자동 연결("same")은 하지 않는다.
 */
export function compareMatches(a: MatchSig, b: MatchSig): "same" | "maybe" | "no" {
  const ka = a.sides.map((s) => s.key).sort().join("|"), kb = b.sides.map((s) => s.key).sort().join("|");
  const gap = Math.abs(a.at - b.at) / 1000;
  if (gap > SCREEN_TIME_TOLERANCE_SEC * 3) return "no";
  if (ka !== kb) return nearNames(a, b) ? "maybe" : "no";
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

/** 한글 음절을 자모(초·중·종성)로 편다 — 오독은 글자가 아니라 자모 하나에서 난다(ㅠ↔ㅜ·ㅑ↔ㅏ·ㅇ↔ㅁ). 나머지 글자는 그대로. */
export function toJamo(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0)! - 0xac00;
    if (c < 0 || c > 11171) { out += ch; continue; }
    out += String.fromCodePoint(0x1100 + Math.floor(c / 588), 0x1161 + Math.floor((c % 588) / 28));
    if (c % 28) out += String.fromCodePoint(0x11a7 + (c % 28));
  }
  return out;
}

/** 닉네임 오독 허용 — 자모 편집 거리가 1 이하, 또는 자모 길이의 1/3 이하(뀨뀨rr→꾸꾸rr 은 자모 6개 중 2개). */
export function nearName(a: string, b: string): boolean {
  const p = toJamo(normalizeName(a)), q = toJamo(normalizeName(b));
  const d = editDistance(p, q);
  return d <= Math.max(1, Math.floor(Math.max(p.length, q.length) / 3));
}

/** 키는 달라도 두 닉네임이 짝지어 오독 범위 안이고, 시각 ±3분·스코어(둘 다 읽음)가 짝지어 같은가. */
function nearNames(a: MatchSig, b: MatchSig): boolean {
  if (Math.abs(a.at - b.at) / 1000 > SCREEN_TIME_TOLERANCE_SEC) return false;
  const fits = (x: SideSig, y: SideSig) =>
    x.name != null && y.name != null && nearName(x.name, y.name) && x.score != null && x.score === y.score;
  const [a0, a1] = a.sides, [b0, b1] = b.sides;
  return (fits(a0, b0) && fits(a1, b1)) || (fits(a0, b1) && fits(a1, b0));
}

export type Tx = postgres.TransactionSql | postgres.Sql;

export interface ResolvedSide { nickname: string; streamerId: string | null; basis: "nickname_match" | FcoScreenBasis | null; key: string; score: number | null }

/** 닉네임이 등록 계정 하나와만 일치할 때만 사람을 붙인다 — 동명이면 붙이지 않는다(부계정 오노출 방지, CLAUDE.md 원칙 2). */
export async function resolveSide(tx: Tx, side: FcoScreenSideInput): Promise<ResolvedSide> {
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

const sigOf = (at: Date | string, sides: { key: string; score: number | null; name?: string }[]): MatchSig =>
  ({ at: new Date(at).getTime(), sides: [sides[0], sides[1]] });

/** 화면 경기 → 같은 경기의 기존 기록 연결. 숨기고(지우지 않는다), 근거를 그쪽으로 복사한다. 이미 연결돼 있으면 아무것도 안 한다. */
export async function linkScreenTo(tx: Tx, screenId: string, targetId: string, basis: Record<string, unknown>, decidedBy: "auto" | "admin"): Promise<void> {
  await tx`INSERT INTO fco_screen_link (screen_match_id, api_match_id, basis, decided_by)
           VALUES (${screenId}, ${targetId}, ${tx.json(basis as postgres.JSONValue)}, ${decidedBy})
           ON CONFLICT (screen_match_id) DO NOTHING`;
  await tx`UPDATE match SET visibility = 'hidden' WHERE match_id = ${screenId}`;
  await tx`
    INSERT INTO fco_context_evidence (match_id, evidence_key, kind, vod_title_no, channel_id, at_sec, end_sec, url, observed, why, frame_path, role, created_by)
    SELECT ${targetId}, evidence_key, kind, vod_title_no, channel_id, at_sec, end_sec, url, observed, why, frame_path, role, created_by
      FROM fco_context_evidence WHERE match_id = ${screenId}
    ON CONFLICT (match_id, evidence_key) DO NOTHING`;
}

/**
 * 화면에서 읽은 FC 경기 하나를 저장한다. 같은 (VOD, 초)는 같은 경기 ID 라 다시 불러도 한 번만 남는다(멱등).
 * 검수된(reviewed_at) 화면 경기는 덮어쓰지 않는다 — protected.
 * 순서: ① 숨긴 채 저장(관측 보존) → ② 같은 경기 후보 비교 → ③ 유일하고 충돌 없으면 연결, 애매하면 검수 대기.
 */
export async function saveFcoScreenMatch(input: FcoScreenMatchInput): Promise<FcoScreenResult> {
  const matchId = screenMatchId(input.vodTitleNo, input.atSec);
  const endedAt = new Date(input.endedAt);
  if (Number.isNaN(endedAt.valueOf())) throw new Error(`endedAt 을 읽을 수 없다: ${input.endedAt}`);
  const outcomes = screenOutcomes(input.sides);
  const sql = db();
  return sql.begin(async (tx): Promise<FcoScreenResult> => {
    const existing = await tx<{ reviewed_at: Date | null; source: string; game_code: string }[]>`
      SELECT reviewed_at, source, game_code FROM match WHERE match_id = ${matchId} FOR UPDATE`;
    if (existing[0] && (existing[0].game_code !== "fconline" || existing[0].source !== "manual")) {
      throw new Error(`${matchId} 는 화면 경기가 아니다`);
    }
    if (existing[0]?.reviewed_at) return { status: "protected", match_id: matchId, reason: "검수된 경기라 덮어쓰지 않는다" };

    const sides = [await resolveSide(tx, input.sides[0]), await resolveSide(tx, input.sides[1])] as const;
    if (sides[0].key === sides[1].key) throw new Error("두 칸이 같은 사람이다 — 닉네임·slug 를 확인한다");
    const sig = sigOf(endedAt, sides.map((x) => ({ key: x.key, score: x.score, name: x.nickname })));

    // ① 관측 보존 — 무엇이 이미 있든 먼저 숨긴 채 저장한다.
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

    // ② 같은 경기 후보 — API 경기와 (이미 연결돼 사라진 것을 뺀) 다른 화면 경기.
    const linkedAlready = await tx<{ api_match_id: string }[]>`SELECT api_match_id FROM fco_screen_link WHERE screen_match_id = ${matchId}`;
    if (linkedAlready[0]) {
      // 다시 불러도 같다 — 새 근거만 연결 대상으로 복사한다.
      await linkScreenTo(tx, matchId, linkedAlready[0].api_match_id, {}, "auto");
      const src = (await tx<{ source: string }[]>`SELECT source FROM match WHERE match_id = ${linkedAlready[0].api_match_id}`)[0]?.source ?? "?";
      return { status: "linked", match_id: matchId, link_to: linkedAlready[0].api_match_id, link_to_source: src };
    }
    const near = await tx<{ match_id: string; source: string; game_creation: Date }[]>`
      SELECT m.match_id, m.source, m.game_creation FROM match m
       WHERE m.game_code = 'fconline' AND m.match_id <> ${matchId}
         AND NOT EXISTS (SELECT 1 FROM fco_screen_link l WHERE l.screen_match_id = m.match_id)
         AND m.game_creation BETWEEN ${new Date(endedAt.getTime() - SCREEN_TIME_TOLERANCE_SEC * 3000)}
                                 AND ${new Date(endedAt.getTime() + SCREEN_TIME_TOLERANCE_SEC * 3000)}`;
    const verdicts: { id: string; source: string; v: "same" | "maybe"; at: number }[] = [];
    for (const cand of near) {
      const parts = await tx<{ nickname: string; streamer_id: string | null; ouid: string | null; score: number | null }[]>`
        SELECT nickname, streamer_id, ouid, coalesce(score_display, goals) AS score
          FROM fco_match_participant WHERE match_id = ${cand.match_id} ORDER BY side_no`;
      if (parts.length !== 2) continue;
      const candSig = sigOf(cand.game_creation, parts.map((p) => ({ key: p.streamer_id ?? `name:${normalizeName(p.nickname)}`, score: p.score, name: p.nickname })));
      const v = compareMatches(sig, candSig);
      if (v !== "no") verdicts.push({ id: cand.match_id, source: cand.source, v, at: candSig.at });
    }

    // ③ 후보가 정확히 하나이고 세 조건이 모두 맞을 때만 연결. 그 밖에는 먼저 찾은 것을 고르지 않고 검수 대기.
    if (verdicts.length === 1 && verdicts[0].v === "same") {
      const t = verdicts[0];
      await linkScreenTo(tx, matchId, t.id, { participants: "same", time_gap_sec: Math.round(Math.abs(sig.at - t.at) / 1000), score: "same" }, "auto");
      return { status: "linked", match_id: matchId, link_to: t.id, link_to_source: t.source };
    }
    if (verdicts.length > 0) return { status: "needs_review", match_id: matchId, candidates: verdicts.map((x) => x.id) };

    // 후보 없음 — 최근 30일 안이고 한쪽이라도 등록 계정이 있으면 자동 수집이 곧 가져올 수 있다(오면 reconcile 이 연결). 알려 줄 뿐 저장은 이미 했다.
    let expectApi = false;
    if (endedAt >= fcoApiWindowStart()) {
      const ids = sides.map((s) => s.streamerId).filter((x): x is string => x !== null);
      if (ids.length) {
        const registered = await tx<{ n: number }[]>`
          SELECT count(*)::int AS n FROM streamer_fco_account WHERE streamer_id = ANY(${ids}::uuid[]) AND visibility = 'public'`;
        expectApi = (registered[0]?.n ?? 0) > 0;
      }
    }
    return { status: existing[0] ? "updated" : "created", match_id: matchId, expect_api: expectApi };
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
  sigOf(r.game_creation, r.parts.map((p) => ({ key: p.streamer_id ?? `name:${normalizeName(p.nickname)}`, score: p.score, name: p.nickname })));

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
    // ★ 사람이 연결을 푼 화면 경기는 자동으로 다시 잇지 않는다 — 그 판단을 다음 수집이 조용히 뒤집으면 안 된다.
    //   (연결 풀기는 review_change 에 screen_link → null 로 남는다. screen-review.ts unlinkScreenByAdmin)
    const unlinkedByHuman = new Set((await tx<{ match_id: string }[]>`
      SELECT DISTINCT match_id FROM review_change WHERE field = 'screen_link' AND "after" IS NULL AND match_id IS NOT NULL`).map((r) => r.match_id));
    for (const s of screens) {
      if (unlinkedByHuman.has(s.match_id)) continue;
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
        await linkScreenTo(tx, s.match_id, api.match_id,
          { participants: "same", time_gap_sec: Math.round(Math.abs(sig.at - rowSig(api).at) / 1000), score: "same" }, "auto");
        linked.push({ screen: s.match_id, api: api.match_id });
      } else if (verdicts.length > 0) {
        suspects += 1; // R3: 후보가 둘 이상이거나 조건 하나가 모자란다 — 합치지 않고 사람에게 남긴다
      }
    }
    return { linked, suspects };
  });
}

export interface FcoScreenSuspect { screen_match_id: string; other_match_id: string; other_source: string; verdict: "maybe" | "ambiguous" }

/**
 * R3 — 합치지 않았지만 같은 경기일 수 있는 쌍(API·화면 모두). 검수 화면이 읽는다.
 *   maybe      조건 하나가 모자란다(스코어를 못 읽음·시각이 3분 밖)
 *   ambiguous  세 조건이 맞는 후보가 둘 이상이라 하나를 고를 수 없다 — 둘 다 보여 준다
 */
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
         AND NOT EXISTS (SELECT 1 FROM fco_screen_link l WHERE l.screen_match_id = m.match_id)
         AND m.game_creation BETWEEN ${new Date(sig.at - SCREEN_TIME_TOLERANCE_SEC * 3000)} AND ${new Date(sig.at + SCREEN_TIME_TOLERANCE_SEC * 3000)}`;
    const hits = others.filter((o) => o.parts?.length === 2).map((o) => ({ o, v: compareMatches(sig, rowSig(o)) })).filter((x) => x.v !== "no");
    for (const { o, v } of hits) {
      if (v === "same" && hits.length === 1) continue; // 하나뿐인 same 은 연결 대상이지 의심이 아니다
      out.push({ screen_match_id: s.match_id, other_match_id: o.match_id, other_source: o.source, verdict: v === "same" ? "ambiguous" : "maybe" });
    }
  }
  return out;
}
