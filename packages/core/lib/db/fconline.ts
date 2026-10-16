/**
 * FC 온라인 공개 조회 — docs/CLASSIFICATION-REDESIGN-PLAN.md §5.
 *
 * ★ 내전 집계(요약·매치 히스토리·상대 전적·상대전적 화면·대회)는 **core_public.fc_versus_set / versus_pair_set 만** 고른다.
 *   공개 규칙(누구로 확인됐나 — 계정·스트리머 공개)은 그 뷰 한 곳에 있고, 세는 규칙은 metrics/tally.ts 하나다(세트·시리즈 항상 같이).
 *   예전엔 요약 카드와 탭이 다른 조건으로 골라 숫자가 달랐다(623경기 vs 254경기) — 이제 같은 행에서 센다.
 * ★ 한쪽만 스트리머인 판은 개인 기록(scope personal)이다. 내전 집계에 넣지 않고 listFcoPersonalRecords 로만 따로 보인다(§10 결정 3).
 * ★ 경기 상세의 스코어보드·슛·패스는 판 하나의 사실이라 원본 표를 읽는다 — 신원은 뷰와 **같은 규칙**(PUBLIC_STREAMER_SQL)으로만 내보낸다.
 * ★ 진행 방식 라벨은 확인된 것만 단다. 자동 묶음(분류 전)의 행사 이름은 공개하지 않는다 — "일반 경기" 같은 지어낸 라벨을 쓰지 않는다.
 */
import type { Format } from "../metrics/format.ts";
import { readRecordCursor } from "../metrics/record-cursor.ts";
import { pairSetOutcome, tally, type Counts, type Outcome, type Tally } from "../metrics/tally.ts";
import { addFcoStats, EMPTY_FCO_STATS, type FcoStatLine } from "../games/fconline/view.ts";
import { db } from "./client.ts";
export { addFcoStats, EMPTY_FCO_STATS, fcoNumber, FCO_MODE_LABEL } from "../games/fconline/view.ts";
export type { FcoStatLine } from "../games/fconline/view.ts";

export interface FcoPerson {
  id: string;
  slug: string;
  name: string;
  image: string | null;
  channel_id: string | null;
  nickname: string;
}

export interface FcoParticipant {
  ouid: string;
  nickname: string;
  streamer_id: string | null;
  streamer_slug: string | null;
  streamer_name: string | null;
  side_no: number;
  outcome: Outcome;
  goals: number | null;
  score_display: number | null;
  division: number | null;
  /** 넥슨 원본 중 FCO_PUBLIC_MATCH_INFO_KEYS 에 든 통계 키만 온다. 신원(ouid·nickname)은 위 칸으로만 나간다. */
  match_info: Record<string, unknown>;
}

/**
 * 공개 조회가 내보내는 match_info 의 키. **허용 목록**이다.
 * ★ 원본 최상위의 ouid·nickname 은 숨긴 계정·미등록 상대의 신원이다. 위 칸에서만 가려
 *   내보내면 원본 JSON 에 그대로 남아, 그걸 클라이언트에 넘기는 화면 하나가 그대로 노출한다.
 *   넥슨이 키를 새로 붙여도 여기 적기 전에는 나가지 않는다.
 */
export const FCO_PUBLIC_MATCH_INFO_KEYS = ["matchDetail", "shoot", "shootDetail", "pass", "defence", "player"] as const;

export interface FcoGame {
  id: string;
  /** 경기 주소의 키 — 넥슨 경기 번호, 화면 판독 판은 내부 id(fcs:…). */
  provider_id: string;
  played_at: string;
  mode_key: string | null;
  /** 실제 행사일 때만. 자동 미분류 묶음·개인 기록이면 null(지어낸 행사 이름을 내보내지 않는다). */
  event_id: string | null;
  event_name: string | null;
  event_slug: string | null;
  /** 진행 방식 — 내전 세트면 행사의 format(자동 묶음은 unclassified), 개인 기록 판이면 null(내전이 아니다). */
  format: Format | null;
  scope: "versus" | "personal";
  series_id: string | null;
  series_game_no: number | null;
  /** 다전제의 예정 세트 수. 근거와 함께 확정한 값만 있다 — 모르면 null(0027). */
  best_of: number | null;
  participants: FcoParticipant[];
}

export interface FcoEvent {
  id: string;
  slug: string;
  name: string;
  format: Format;
  organizer: string | null;
  starts_at: string | null;
  ends_at: string | null;
  /** 등록 일정 우선, 없으면 공개 경기 기간. 목록 정렬·표시·연도 분류의 공통 기준. */
  effective_starts_at: Date | null;
  effective_ends_at: Date | null;
  source_url: string | null;
  /** 공개 본게임 세트 수(fc_versus_set). */
  game_count: number;
}

type GameRow = Omit<FcoGame, "participants"> & { participants: FcoParticipant[] | null };

function games(rows: GameRow[]): FcoGame[] {
  return rows.map((row) => ({ ...row, participants: row.participants ?? [] }));
}

/**
 * 참가자 한 칸이 공개로 누구인가 — core_public.fc_versus_set 과 **같은 규칙**이다(0089):
 *   계정으로 확인된 칸(넥슨 ouid 가 연결 계정) → 그 연결이 공개일 때 그 스트리머 / 계정 없이 사람만 확인된 칸(화면 판독) → 그 스트리머.
 * 스트리머 공개 여부는 아래 JOIN 이 건다. ★ 규칙이 둘이 되지 않게 verify:fco 가 내전 판에서 이 값과 뷰의 값을 대조한다.
 */
const PUBLIC_STREAMER_SQL = `CASE WHEN link.ouid IS NOT NULL THEN CASE WHEN link.visibility = 'public' THEN link.streamer_id END ELSE p.streamer_id END`;

/** 공개 경기 하나의 조건 — 공개 경기이고, 공개로 확인된 스트리머가 한 칸 이상 있다(경기 상세·개인 기록이 쓴다). */
const PUBLIC_FCO_MATCH = `m.game_code = 'fconline' AND m.visibility = 'public'
    AND EXISTS (SELECT 1 FROM fco_match_participant p
      LEFT JOIN streamer_fco_account link ON link.ouid = p.ouid
      JOIN streamer visible ON visible.visibility = 'public' AND visible.id = ${PUBLIC_STREAMER_SQL}
      WHERE p.match_id = m.match_id)`;

const selectGame = (detail = true) => `
  m.match_id AS id, COALESCE(d.provider_match_id, m.match_id) AS provider_id, m.game_creation AS played_at,
  m.mode_key, CASE WHEN NOT e.auto_bucket THEN e.id END AS event_id,
  CASE WHEN NOT e.auto_bucket THEN e.name END AS event_name, CASE WHEN NOT e.auto_bucket THEN e.slug END AS event_slug,
  e.format, m.scope, m.series_id, m.series_game_no, ms.best_of,
  (SELECT jsonb_agg(jsonb_build_object(
      'ouid', CASE WHEN s.id IS NOT NULL THEN COALESCE(p.ouid, 'screen:' || p.side_no) ELSE 'unlinked:' || p.side_no END,
      'nickname', CASE WHEN s.id IS NOT NULL THEN p.nickname ELSE '상대' END,
      'streamer_id', s.id,
      'streamer_slug', s.slug, 'streamer_name', s.display_name,
      'side_no', p.side_no, 'outcome', p.outcome, 'goals', p.goals,
      'score_display', p.score_display,
      'division', p.division,
      'match_info', (SELECT COALESCE(jsonb_object_agg(info.key, info.value), '{}'::jsonb)
                       FROM jsonb_each(COALESCE(p.match_info, '{}'::jsonb)) AS info
                      WHERE info.key IN (${FCO_PUBLIC_MATCH_INFO_KEYS.filter(key => detail || !["player", "shootDetail"].includes(key)).map((key) => `'${key}'`).join(", ")}))
    ) ORDER BY p.side_no)
   FROM fco_match_participant p
   LEFT JOIN streamer_fco_account link ON link.ouid = p.ouid
   LEFT JOIN streamer s ON s.visibility = 'public' AND s.id = ${PUBLIC_STREAMER_SQL}
   WHERE p.match_id = m.match_id) AS participants
  FROM match m
  LEFT JOIN fco_match_detail d ON d.match_id = m.match_id
  LEFT JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = 'fconline'
  LEFT JOIN event e ON e.id = ms.event_id AND e.game_code = 'fconline'
  WHERE m.game_code = 'fconline'`;

export async function listFcoPeople(): Promise<FcoPerson[]> {
  return db()<FcoPerson[]>`
    SELECT s.id, s.slug, s.display_name AS name,
           s.profile_image_url AS image,
           (SELECT c.channel_id FROM core_public.streamer_channel c
             WHERE c.streamer_id = s.id AND c.platform = 'soop'
             ORDER BY c.is_primary DESC LIMIT 1) AS channel_id,
           string_agg(a.nickname, ', ' ORDER BY a.nickname) AS nickname
      FROM streamer s
      JOIN streamer_fco_account link ON link.streamer_id = s.id AND link.visibility = 'public'
      JOIN fco_account a ON a.ouid = link.ouid
     WHERE s.visibility = 'public'
     GROUP BY s.id
     ORDER BY name
  `;
}

export async function getFcoPerson(slug: string): Promise<FcoPerson | null> {
  const rows = await db()<FcoPerson[]>`
    SELECT s.id, s.slug, s.display_name AS name, s.profile_image_url AS image,
           (SELECT c.channel_id FROM core_public.streamer_channel c
             WHERE c.streamer_id = s.id AND c.platform = 'soop'
             ORDER BY c.is_primary DESC LIMIT 1) AS channel_id,
           string_agg(a.nickname, ', ' ORDER BY a.nickname) AS nickname
      FROM streamer s
      JOIN streamer_fco_account link ON link.streamer_id = s.id AND link.visibility = 'public'
      JOIN fco_account a ON a.ouid = link.ouid
     WHERE s.slug = ${slug} AND s.visibility = 'public'
     GROUP BY s.id
  `;
  return rows[0] ?? null;
}

/** 내전 집계의 범위. 경기 모드는 보조 필터, 진행 방식(format)이 기본 축이다. 기간은 시리즈 첫 공개 본게임의 KST 날짜. */
export interface FcoRecordFilter { mode?: string; from?: string; to?: string; format?: Format }

/**
 * 한 사람의 공개 내전 세트(fc_versus_set) 중 범위 안의 것 — 목록·요약·대회 성적이 **이 조건 하나**를 쓴다.
 * $1 사람 · $2 모드 · $3·$4 기간 · $5 진행 방식.
 */
const PERSON_SETS = `SELECT v.match_id FROM core_public.fc_versus_set v
   WHERE v.streamer_id = $1
     AND ($2::text IS NULL OR v.mode_key = $2)
     AND ($3::date IS NULL OR v.series_started_on >= $3::date)
     AND ($4::date IS NULL OR v.series_started_on <= $4::date)
     AND ($5::text IS NULL OR v.format = $5)`;
const scopeValues = (id: string, filter: FcoRecordFilter) =>
  [id, filter.mode ?? null, filter.from ?? null, filter.to ?? null, filter.format ?? null];

/** 경기 모드 선택지 — 그 사람의 공개 내전 세트 전체에서(현재 페이지와 무관하게). */
export async function listFcoModesForPerson(streamerId: string): Promise<string[]> {
  const rows = await db().unsafe<{ mode_key: string }[]>(`
    SELECT DISTINCT v.mode_key FROM core_public.fc_versus_set v
     WHERE v.streamer_id = $1 AND v.mode_key IS NOT NULL ORDER BY v.mode_key
  `, [streamerId]);
  return rows.map((row) => row.mode_key);
}

/** 한 사람의 공개 내전 세트 — 최근 순. 스쿼드·지표처럼 범위 전체를 한 번에 쓰는 화면. */
export async function listFcoGamesForPerson(streamerId: string, limit: number | null = 60, filter: FcoRecordFilter = {}, detail = true): Promise<FcoGame[]> {
  return games(await db().unsafe<GameRow[]>(`SELECT ${selectGame(detail)} AND m.match_id IN (${PERSON_SETS})
    ORDER BY m.game_creation DESC, m.match_id DESC LIMIT $6`, [...scopeValues(streamerId, filter), limit]));
}

/** 매치 히스토리 — 같은 범위를 시리즈 묶음 단위로 이어 본다. limit 은 시리즈 수이며 어느 페이지도 시리즈를 중간에서 끊지 않는다. */
export async function listFcoStreamerGamesForPerson(streamerId: string, limit: number | null = 200, filter: FcoRecordFilter = {}, cursorValue?: string): Promise<FcoGame[]> {
  const cursor = readRecordCursor(cursorValue);
  return games(await db().unsafe<GameRow[]>(`
    WITH scoped AS (SELECT ${selectGame(false)} AND m.match_id IN (${PERSON_SETS})
    ), grouped AS (
      SELECT COALESCE(series_id, id) AS key, min(played_at) AS at FROM scoped GROUP BY COALESCE(series_id, id)
    ), page AS (
      SELECT * FROM grouped WHERE ($7::timestamptz IS NULL OR at < $7 OR (at = $7 AND key > $8))
      ORDER BY at DESC, key LIMIT $6
    ) SELECT s.* FROM scoped s JOIN page p ON p.key = COALESCE(s.series_id, s.id)
      ORDER BY p.at DESC, p.key, s.played_at DESC, s.id DESC`,
    [...scopeValues(streamerId, filter), limit, cursor?.at ?? null, cursor?.id ?? null]));
}

/** 요약 카드 — 세트·시리즈 기록(tally)과 경기 지표. 목록과 같은 행(PERSON_SETS)에서 센다. */
export interface FcoPersonalSummary extends FcoStatLine { record: Tally; lastPlayed: string | null }

export async function getFcoPersonalSummary(streamerId: string, filter: FcoRecordFilter = {}): Promise<FcoPersonalSummary> {
  const rows = await db().unsafe<{ series_id: string; outcome: Outcome; played_at: Date; participant: FcoParticipant }[]>(`
    SELECT v.series_id, v.outcome, v.played_at,
           jsonb_build_object('outcome', p.outcome, 'goals', p.goals, 'match_info', jsonb_build_object(
             'shoot', p.match_info->'shoot', 'pass', p.match_info->'pass',
             'defence', p.match_info->'defence', 'matchDetail', p.match_info->'matchDetail')) AS participant
      FROM core_public.fc_versus_set v
      JOIN fco_match_participant p ON p.match_id = v.match_id AND p.side_no = v.side
     WHERE v.match_id IN (${PERSON_SETS}) AND v.streamer_id = $1`, scopeValues(streamerId, filter));
  const stats = rows.reduce((line, r) => addFcoStats(line, r.participant), EMPTY_FCO_STATS);
  const last = rows.reduce<Date | null>((at, r) => (!at || r.played_at > at ? r.played_at : at), null);
  return { ...stats, record: tally(rows), lastPlayed: last ? last.toISOString() : null };
}

/** 참가 행사별 성적 — 실제 행사만(자동 묶음은 행사가 아니다). 같은 범위·같은 세기. */
export interface FcoProfileEventRecord {
  slug: string; name: string; format: Format; games: number; record: Tally; firstPlayed: string; lastPlayed: string;
}
export async function listFcoPersonalEvents(streamerId: string, filter: FcoRecordFilter = {}): Promise<FcoProfileEventRecord[]> {
  const rows = await db().unsafe<{ slug: string; name: string; format: Format; series_id: string; outcome: Outcome; played_at: Date }[]>(`
    SELECT e.slug, e.name, e.format, v.series_id, v.outcome, v.played_at
      FROM core_public.fc_versus_set v JOIN event e ON e.id = v.event_id
     WHERE v.match_id IN (${PERSON_SETS}) AND v.streamer_id = $1 AND NOT v.auto_bucket AND e.slug IS NOT NULL`,
    scopeValues(streamerId, filter));
  type Row = (typeof rows)[number];
  const byEvent = new Map<string, Row[]>();
  for (const r of rows) (byEvent.get(r.slug) ?? byEvent.set(r.slug, []).get(r.slug)!).push(r);
  return [...byEvent.values()].map((list) => {
    const times = list.map((r) => r.played_at.getTime());
    return {
      slug: list[0].slug, name: list[0].name, format: list[0].format, games: list.length, record: tally(list),
      firstPlayed: new Date(Math.min(...times)).toISOString(), lastPlayed: new Date(Math.max(...times)).toISOString(),
    };
  }).sort((a, b) => b.lastPlayed.localeCompare(a.lastPlayed) || a.slug.localeCompare(b.slug));
}

/**
 * 개인 기록 — 한쪽만 스트리머인 공개 판(scope personal). 내전 집계에 넣지 않는 판을 **따로, 최소한으로** 보인다.
 * 세기는 본인 결과 그대로다(양쪽 몰수면 각자 패 — 상대전적의 짝 규칙을 쓰지 않는다). 시리즈가 없으므로 세트만 센다.
 * ⚠ FC 개인 기록의 core_public 뷰가 아직 없다(personal_game 은 롤만) — 여기서 뷰와 같은 신원 규칙으로 원본을 읽는다.
 */
export async function listFcoPersonalRecords(streamerId: string, filter: Omit<FcoRecordFilter, "format"> = {}, limit = 30): Promise<{
  games: FcoGame[]; total: number; sets: Counts;
}> {
  const mine = `SELECT m.match_id FROM match m
      JOIN fco_match_participant p ON p.match_id = m.match_id
      LEFT JOIN streamer_fco_account link ON link.ouid = p.ouid
      JOIN streamer me ON me.visibility = 'public' AND me.id = ${PUBLIC_STREAMER_SQL}
     WHERE m.game_code = 'fconline' AND m.visibility = 'public' AND m.scope = 'personal' AND me.id = $1
       AND ($2::text IS NULL OR m.mode_key = $2)
       AND ($3::date IS NULL OR (m.game_creation AT TIME ZONE 'Asia/Seoul')::date >= $3::date)
       AND ($4::date IS NULL OR (m.game_creation AT TIME ZONE 'Asia/Seoul')::date <= $4::date)`;
  const values = [streamerId, filter.mode ?? null, filter.from ?? null, filter.to ?? null];
  const [rows, outcomes] = await Promise.all([
    db().unsafe<GameRow[]>(`SELECT ${selectGame(false)} AND m.match_id IN (${mine})
      ORDER BY m.game_creation DESC, m.match_id DESC LIMIT $5`, [...values, limit]),
    db().unsafe<{ match_id: string; outcome: Outcome }[]>(`
      SELECT p.match_id, p.outcome FROM fco_match_participant p
        LEFT JOIN streamer_fco_account link ON link.ouid = p.ouid
       WHERE p.match_id IN (${mine}) AND ${PUBLIC_STREAMER_SQL} = $1`, values),
  ]);
  return { games: games(rows), total: outcomes.length, sets: tally(outcomes.map((r) => ({ series_id: r.match_id, outcome: r.outcome }))).sets };
}

/** 두 사람이 상대편으로 만난 공개 내전 세트(versus_pair_set). 기록은 pairSetOutcome 으로 센다 — A 의 기록과 B 의 기록은 언제나 거울이다. */
export async function listFcoVersus(aId: string, bId: string): Promise<FcoGame[]> {
  const rows = await db().unsafe<GameRow[]>(`
    SELECT ${selectGame()}
      AND m.match_id IN (SELECT ps.match_id FROM core_public.versus_pair_set ps
                          WHERE ps.game_code = 'fconline' AND ps.relation = 'opponent'
                            AND ps.a_streamer_id = $1 AND ps.b_streamer_id = $2)
     ORDER BY m.game_creation DESC, m.match_id DESC
  `, [aId, bId]);
  return games(rows);
}

/** 자주 만난 매치업. a 기준 기록(세트·시리즈). streamerId 를 주면 a 가 언제나 그 사람이다(부르는 쪽이 뒤집지 않는다). */
export interface FcoTopPair {
  a_id: string;
  b_id: string;
  /** 맞대결 세트 수 */
  games: number;
  record: Tally;
}

interface PairRow { a: string; b: string; series_id: string; a_outcome: Outcome; b_outcome: Outcome }
async function fcoPairRows(streamerId?: string): Promise<PairRow[]> {
  // 한 사람 기준이면 상대전적 뷰를 그 사람의 판 번호로 따라간다(빠른 길).
  if (streamerId) return db().unsafe<PairRow[]>(`
    SELECT ps.a_streamer_id AS a, ps.b_streamer_id AS b, ps.series_id, ps.a_outcome, ps.b_outcome
      FROM core_public.versus_pair_set ps
     WHERE ps.game_code = 'fconline' AND ps.relation = 'opponent' AND ps.a_streamer_id = $1::uuid
  `, [streamerId]);
  // ★ 전체 순위는 공개 세트에서 판 단위로 바로 짝을 짓는다 — FC 내전 판은 1대1이라 판 하나가 곧 짝 하나다.
  //   상대전적 뷰는 사람 기준 판 번호 조회에 맞춰져 있어 전체를 훑으면 느리다(운영 복사본 0.39초).
  return db().unsafe<PairRow[]>(`
    SELECT min(v.streamer_id::text) AS a, max(v.streamer_id::text) AS b, v.series_id,
           (array_agg(v.outcome ORDER BY v.streamer_id::text))[1] AS a_outcome,
           (array_agg(v.outcome ORDER BY v.streamer_id::text))[2] AS b_outcome
      FROM core_public.fc_versus_set v
     GROUP BY v.match_id, v.series_id
    HAVING count(DISTINCT v.streamer_id) = 2 AND count(DISTINCT v.side) = 2
  `);
}

/** 공개로 확인된 스트리머끼리의 맞대결만 센다. 세트 수가 많은 순, 같으면 id 순. */
export async function listFcoTopPairs(limit = 8, streamerId?: string): Promise<FcoTopPair[]> {
  const rows = await fcoPairRows(streamerId);
  const byPair = new Map<string, PairRow[]>();
  for (const r of rows) (byPair.get(`${r.a}|${r.b}`) ?? byPair.set(`${r.a}|${r.b}`, []).get(`${r.a}|${r.b}`)!).push(r);
  return [...byPair.values()].map((list): FcoTopPair => ({
    a_id: list[0].a, b_id: list[0].b, games: list.length,
    record: tally(list.map((r) => ({ series_id: r.series_id, outcome: pairSetOutcome(r.a_outcome, r.b_outcome) }))),
  })).sort((x, y) => y.games - x.games || x.a_id.localeCompare(y.a_id) || x.b_id.localeCompare(y.b_id)).slice(0, limit);
}

/** 전적 검색 첫 화면에서 보여 줄, 실제 맞대결이 가장 많은 공개 스트리머 쌍. */
export async function getFeaturedFcoPair(): Promise<{ aId: string; bId: string } | null> {
  const [top] = await listFcoTopPairs(1);
  return top ? { aId: top.a_id, bId: top.b_id } : null;
}

/** 경기 하나 — 넥슨 경기 번호 또는 내부 id. 공개 경기이고 공개로 확인된 스트리머가 한 칸 이상 있어야 열린다(개인 기록 판 포함). */
export async function getFcoGame(ref: string): Promise<FcoGame | null> {
  const rows = await db().unsafe<GameRow[]>(`
    SELECT ${selectGame()} AND (d.provider_match_id = $1 OR m.match_id = $1)
      AND ${PUBLIC_FCO_MATCH}
     LIMIT 1
  `, [ref]);
  return games(rows)[0] ?? null;
}

/** 목록·상세·메인이 같은 공개 경기 집계와 보완 날짜를 읽는다.
 * 경기 귀속은 시리즈 경유 한 길이고 공개 조건은 fc_versus_set 이다(listFcoEventGames 와 같다).
 * 등록 일정 원본은 보존하고, 조회 결과에만 effective_*를 만든다. 자동 묶음은 행사 목록에 없다. */
const fcoDatedEvents = `
  WITH event_games AS (
    SELECT v.event_id, count(DISTINCT v.match_id)::int AS game_count,
           min(v.played_at) AS first_played_at, max(v.played_at) AS last_played_at,
           (array_agg(COALESCE(d.provider_match_id, v.match_id) ORDER BY v.played_at DESC, v.match_id DESC))[1] AS latest_provider_id
      FROM core_public.fc_versus_set v
      LEFT JOIN fco_match_detail d ON d.match_id = v.match_id
     WHERE NOT v.auto_bucket
     GROUP BY v.event_id
  ), dated_events AS (
    SELECT e.id, e.slug, e.name, e.format, e.organizer, e.starts_at, e.ends_at, e.source_url,
           COALESCE(e.starts_at, g.first_played_at) AS effective_starts_at,
           COALESCE(e.ends_at, g.last_played_at) AS effective_ends_at,
           COALESCE(g.game_count, 0)::int AS game_count, g.last_played_at, g.latest_provider_id
      FROM event e LEFT JOIN event_games g ON g.event_id = e.id
     WHERE e.game_code = 'fconline' AND NOT e.auto_bucket AND e.slug IS NOT NULL
  )`;

const fcoEventColumns = `id, slug, name, format, organizer, starts_at, ends_at, source_url,
  effective_starts_at, effective_ends_at, game_count`;

/** 상세가 열리는 행사 집합. 대회 목록 정책과 독립적이다. */
export async function listFcoDetailEvents(ids?: string[]): Promise<FcoEvent[]> {
  return db().unsafe<FcoEvent[]>(`${fcoDatedEvents}
    SELECT ${fcoEventColumns} FROM dated_events
     WHERE ($1::uuid[] IS NULL OR id = ANY($1::uuid[]))
     ORDER BY effective_starts_at DESC NULLS LAST, slug
  `, [ids ?? null]);
}

/** 대회 목록 — 진행 방식이 대회인 행사만. CK·컨셉·친선은 상세만 열린다. */
export async function listFcoEvents(): Promise<FcoEvent[]> {
  return (await listFcoDetailEvents()).filter(event => event.format === "tournament");
}

export interface FcoRecentEvent extends FcoEvent {
  last_played_at: string;
  latest_provider_id: string;
}

/** 메인의 "최근 CK · 대회" — 확인된 진행 방식(대회·CK·컨셉)만. 친선·분류 전은 행사 소개 대상이 아니다.
 * 일정이 비어 있는 CK도 실제 공개 경기 시각으로 정렬한다. */
export async function listFcoRecentEvents(limit = 3): Promise<FcoRecentEvent[]> {
  return db().unsafe<FcoRecentEvent[]>(`${fcoDatedEvents}
    SELECT ${fcoEventColumns}, last_played_at, latest_provider_id FROM dated_events
     WHERE last_played_at IS NOT NULL AND format IN ('ck', 'tournament', 'concept')
     ORDER BY last_played_at DESC, id
     LIMIT $1
  `, [Math.min(12, Math.max(1, Math.trunc(limit) || 3))]);
}

export async function getFcoEvent(slug: string): Promise<FcoEvent | null> {
  const rows = await db().unsafe<FcoEvent[]>(`${fcoDatedEvents}
    SELECT ${fcoEventColumns} FROM dated_events WHERE slug = $1
  `, [slug]);
  return rows[0] ?? null;
}

/** 행사의 공개 내전 세트. */
export async function listFcoEventGames(eventId: string): Promise<FcoGame[]> {
  const rows = await db().unsafe<GameRow[]>(`
    SELECT ${selectGame()} AND m.match_id IN (SELECT v.match_id FROM core_public.fc_versus_set v WHERE v.event_id = $1::uuid)
     ORDER BY m.game_creation, m.series_id, m.series_game_no
  `, [eventId]);
  return games(rows);
}
