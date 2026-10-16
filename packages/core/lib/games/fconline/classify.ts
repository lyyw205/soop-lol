/**
 * FC 경기의 **분류 자리** — 판이 어느 진행 방식의 행사에 속하나(docs/CLASSIFICATION-REDESIGN-PLAN.md §3, §10 결정 3·4).
 *
 * 분류를 정하는 쓰기는 core 의 classification.ts 하나가 한다. 여기는 FC 쪽에서 그 함수들을 **어떤 판에 어떻게 부를지**만 정한다:
 *   - 공개 연결된 스트리머 두 사람(서로 다름)의 판 = 내전 세트 → (두 사람, KST 날짜) 자동 미분류 묶음의 한 판짜리 시리즈.
 *   - 한쪽만 스트리머인 판 = 개인 기록(scope personal). 내전 집계에 들어가지 않는다(§10 결정 3).
 *   - 친선(friendly)은 사람이 확인해 정하는 실제 행사다. 자동 경로는 친선을 정하지 못한다(사용자 결정 5-A·7 "확인된 것만 라벨").
 *
 * ★ 맥락 상태(행사 > 판단 메모 > 미조사)는 fcoContextStatus 하나로만 계산한다. 옛 구조에서는 이 규칙이 일곱 군데에 복사돼 있었다.
 */
import type postgres from "postgres";

import {
  ensureAutoBucketInTx, ensureEventInTx, fcPairBucketSlug, moveSeriesInTx, placeSingleSetInTx, singleSetSeriesId, type Actor,
} from "../../db/classification.ts";
import type { Format } from "../../metrics/format.ts";
import { kstDateString } from "../../time.ts";

type Tx = postgres.TransactionSql;

/**
 * 판단 메모가 남는 자리 — review_change(entity 'classification', 이 field). 0089 가 옛 fco_match_context 의 메모를 같은 field 로
 * 옮겼다(after = {judgment, note}). 새 메모도 같은 field 에 쌓아 이력이 한 줄로 읽힌다.
 * ★ 메모는 분류가 아니다 — "아직 행사를 못 정했고 이것이 남은 질문이다"일 뿐이다. 옛 casual 메모도 여기 있지만 친선으로 읽지 않는다(§10 결정 4).
 */
export const FCO_CONTEXT_NOTE_FIELD = "fco_match_context";

/** 맥락 상태 — 실제 행사에 있다 > 판단 메모가 있다 > 아무것도 없다. */
export type FcoContextStatus = "event" | "unresolved" | "uninvestigated";

/** 판이 놓인 행사(시리즈 경유). 자동 묶음이면 auto_bucket true. 개인 기록 판이면 행사가 없다(null). */
export interface FcoPlacement { event_id: string | null; auto_bucket: boolean | null }

/** 맥락 상태의 단일 출처. 자동 묶음은 "행사"가 아니다 — 아직 분류 전 그릇이다. */
export function fcoContextStatus(placement: FcoPlacement, note: string | null | undefined): FcoContextStatus {
  if (placement.event_id && placement.auto_bucket === false) return "event";
  return note ? "unresolved" : "uninvestigated";
}

/** 실제 행사(자동 묶음 아님)에 있나 — 상태 계산과 같은 판정을 SQL 에서 쓸 때. e 는 시리즈 경유로 이은 event. */
export const FCO_IN_REAL_EVENT_SQL = "(e.id IS NOT NULL AND NOT e.auto_bucket)";

/**
 * 판 하나의 최신 판단 메모(lateral). m 은 match. 고른 칸: note_judgment·note·note_by·note_at.
 * 화면·CLI·큐가 같은 조각을 써서 "최신 메모"의 뜻이 갈라지지 않게 한다.
 */
export const FCO_LATEST_NOTE_LATERAL = `LEFT JOIN LATERAL (
    SELECT rc.after->>'judgment' AS note_judgment, rc.after->>'note' AS note, rc.actor AS note_by, rc.changed_at AS note_at
      FROM review_change rc
     WHERE rc.match_id = m.match_id AND rc.entity = 'classification' AND rc.field = '${FCO_CONTEXT_NOTE_FIELD}'
     ORDER BY rc.changed_at DESC, rc.id DESC LIMIT 1) ctx ON true`;

/** 판의 행사(시리즈 경유 한 길). 개인 기록 판은 ms·e 가 NULL 이다. */
export const FCO_PLACEMENT_JOIN = `LEFT JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code
    LEFT JOIN event e ON e.id = ms.event_id`;

// ── 두 사람 판 ────────────────────────────────────────────────────────────────

export interface FcoPair { played_at: Date; a: { id: string; name: string }; b: { id: string; name: string } }

/**
 * 이 판이 스트리머 두 사람(서로 다름)의 판인가. 두 칸 모두 사람이 정해졌을 때만 — 0089 이관과 같은 규칙이다
 * (side 1·2 의 streamer_id 가 모두 있고 다르다). 사람 순서는 id 정렬(묶음 키와 같다).
 */
export async function fcoPairOf(tx: Tx | postgres.Sql, matchId: string): Promise<FcoPair | null> {
  const rows = await tx<{ played_at: Date; side_no: number; streamer_id: string | null; name: string | null }[]>`
    SELECT m.game_creation AS played_at, p.side_no, p.streamer_id, s.display_name AS name
      FROM match m JOIN fco_match_participant p ON p.match_id = m.match_id
      LEFT JOIN streamer s ON s.id = p.streamer_id
     WHERE m.match_id = ${matchId} AND m.game_code = 'fconline' ORDER BY p.side_no`;
  const one = rows.find((r) => r.side_no === 1), two = rows.find((r) => r.side_no === 2);
  if (!one?.streamer_id || !two?.streamer_id || one.streamer_id === two.streamer_id) return null;
  const [a, b] = [one, two].sort((x, y) => (x.streamer_id! < y.streamer_id! ? -1 : 1));
  return { played_at: one.played_at, a: { id: a.streamer_id!, name: a.name ?? "?" }, b: { id: b.streamer_id!, name: b.name ?? "?" } };
}

/** (두 사람, KST 날짜) 자동 미분류 묶음 — 이름은 0089 이관과 같은 모양("날짜 A vs B"). */
export function ensureFcoPairBucketInTx(tx: Tx, pair: FcoPair): Promise<string> {
  return ensureAutoBucketInTx(tx, {
    game_code: "fconline", day: pair.played_at,
    slug: fcPairBucketSlug(pair.played_at, pair.a.id, pair.b.id),
    name: `${kstDateString(pair.played_at)} ${pair.a.name} vs ${pair.b.name}`,
  });
}

/**
 * 자동 수집이 판을 분류 자리에 둔다(넥슨 수집·화면 판독·계정 연결·화면 값 수정 뒤). 하는 일은 둘뿐이다:
 *   1. 아직 시리즈 밖(개인 기록)이고 두 사람 판이면 그 묶음의 한 판짜리 시리즈로 옮긴다.
 *   2. 자동 묶음의 한 판짜리 시리즈에 있는데 두 사람이 바뀌었으면(화면 이름을 다시 읽거나 고친 경우) 맞는 묶음으로 옮긴다 —
 *      묶음은 판의 사실(두 사람·날짜)에서만 정해지는 그릇이라, 사실이 바뀌면 그릇도 바뀐다.
 * ★ 실제 행사(auto_bucket 아님)·여러 판 시리즈에 있는 판은 **절대 옮기지 않는다** — 재수집·재판독이 사람이나 조사가 정한 자리를 되돌리면 안 된다.
 * ★ 묶음 키가 판 자체에서 정해지므로 몇 번을 다시 불러도, 어느 순서로 들어와도 같은 묶음이다.
 * ★ 두 사람 판이 아니게 된 묶음 판은 그대로 둔다 — 시리즈 밖(개인 기록)으로 되돌리는 쓰기는 classification.ts 에 아직 없다.
 * @returns 지금 scope
 */
export async function placeFcoMatchAutoInTx(tx: Tx, matchId: string): Promise<"versus" | "personal"> {
  const [m] = await tx<{ series_id: string | null; scope: "versus" | "personal"; bucket_slug: string | null; single: boolean }[]>`
    SELECT m.series_id, m.scope, CASE WHEN e.auto_bucket THEN e.slug END AS bucket_slug,
           (m.series_id = ${singleSetSeriesId(matchId)}) AS single
      FROM match m LEFT JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code
      LEFT JOIN event e ON e.id = ms.event_id
     WHERE m.match_id = ${matchId} AND m.game_code = 'fconline' FOR UPDATE OF m`;
  if (!m) throw new Error(`경기 ${matchId} 가 없다.`);
  if (m.series_id && !(m.bucket_slug && m.single)) return m.scope;
  const pair = await fcoPairOf(tx, matchId);
  if (!pair) return m.scope;
  if (m.bucket_slug === fcPairBucketSlug(pair.played_at, pair.a.id, pair.b.id)) return m.scope;
  const bucket = await ensureFcoPairBucketInTx(tx, pair);
  if (m.series_id) await moveSeriesInTx(tx, { series_id: m.series_id, event_id: bucket, actor: "auto" });
  else await placeSingleSetInTx(tx, { match_id: matchId, game_code: "fconline", event_id: bucket, actor: "auto" });
  return "versus";
}

// ── 친선 — 사람만 ─────────────────────────────────────────────────────────────

/** 친선 행사의 키 — (두 사람, KST 날짜). 자동 묶음과 같은 모양이지만 사람이 확인한 실제 행사다. */
export function fcFriendlyEventSlug(playedAt: Date, a: string, b: string): string {
  const [s1, s2] = [a, b].sort();
  return `fc-friendly-${kstDateString(playedAt)}-${s1}-${s2}`;
}

/**
 * 친선 행사를 찾거나 만든다. ★ 사람(admin)만 — 자동 조사는 친선을 정하지 못한다(거부).
 * "단서 없음"은 친선의 근거가 아니다(옛 casual 149건이 부재 근거뿐이었다). 친선은 사람이 방송을 보고 확인한 것만이다.
 */
export async function ensureFcoFriendlyEventInTx(tx: Tx, pair: FcoPair, actor: Actor): Promise<{ id: string; slug: string }> {
  if (actor !== "admin") throw new Error("친선(friendly)은 사람이 확인해 정한다 — 자동 조사는 친선을 결론으로 낼 수 없다(미해결 메모로 남긴다).");
  const slug = fcFriendlyEventSlug(pair.played_at, pair.a.id, pair.b.id);
  const id = await ensureEventInTx(tx, {
    game_code: "fconline", slug, format: "friendly",
    name: `${kstDateString(pair.played_at)} ${pair.a.name} vs ${pair.b.name} 친선`,
  });
  return { id, slug };
}

/** 자동 조사가 결론으로 낼 수 있는 진행 방식 — 근거(URL)와 함께 행사를 만드는 것. 친선·미분류는 여기 없다. */
export const FCO_EVENT_CONCLUSION_FORMATS = ["ck", "tournament", "concept"] as const satisfies readonly Format[];
export type FcoEventConclusionFormat = (typeof FCO_EVENT_CONCLUSION_FORMATS)[number];
