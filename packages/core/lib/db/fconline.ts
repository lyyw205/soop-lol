import { listedInTournaments } from "../metrics/event.ts";
import { readRecordCursor } from "../metrics/record-cursor.ts";
import type { FcoStatLine } from "../games/fconline/view.ts";
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
  outcome: "win" | "draw" | "loss" | "unknown";
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
  provider_id: string;
  played_at: string;
  mode_key: string | null;
  event_id: string | null;
  event_name: string | null;
  event_slug: string | null;
  event_kind: string | null;
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
  kind: string;
  organizer: string | null;
  starts_at: string | null;
  ends_at: string | null;
  /** 등록 일정 우선, 없으면 공개 경기 기간. 목록 정렬·표시·연도 분류의 공통 기준. */
  effective_starts_at: Date | null;
  effective_ends_at: Date | null;
  source_url: string | null;
  game_count: number;
}

type GameRow = Omit<FcoGame, "participants"> & { participants: FcoParticipant[] | null };

function games(rows: GameRow[]): FcoGame[] {
  return rows.map((row) => ({ ...row, participants: row.participants ?? [] }));
}

/**
 * 공개 FC 경기의 조건. 경기 목록과 집계(countFcoPublic)가 같은 조건을 쓴다 — 두 벌이면 숫자와 목록이 어긋난다.
 * 공개 경기이고, 공개 연결된 공개 스트리머가 한 명 이상 있다.
 */
const PUBLIC_FCO_MATCH = `m.game_code = 'fconline' AND m.visibility = 'public'
    AND EXISTS (SELECT 1 FROM fco_match_participant visible
      JOIN streamer_fco_account visible_link ON visible_link.ouid = visible.ouid
        AND visible_link.visibility = 'public'
      JOIN streamer visible_streamer ON visible_streamer.id = visible_link.streamer_id
        AND visible_streamer.visibility = 'public'
      WHERE visible.match_id = m.match_id)`;

const selectGame = (detail = true) => `
  m.match_id AS id, d.provider_match_id AS provider_id, m.game_creation AS played_at,
  m.mode_key, COALESCE(ms.event_id, m.event_id) AS event_id,
  e.name AS event_name, e.slug AS event_slug, e.kind AS event_kind, m.series_id, m.series_game_no, ms.best_of,
  (SELECT jsonb_agg(jsonb_build_object(
      'ouid', CASE WHEN s.id IS NOT NULL THEN p.ouid ELSE 'unlinked:' || p.side_no END,
      'nickname', CASE WHEN s.id IS NOT NULL THEN p.nickname ELSE '상대' END,
      'streamer_id', s.id,
      'streamer_slug', s.slug, 'streamer_name', s.display_name,
      'side_no', p.side_no, 'outcome', p.outcome, 'goals', p.goals,
      'score_display', p.score_display,
      'division', p.division,
      'match_info', (SELECT COALESCE(jsonb_object_agg(info.key, info.value), '{}'::jsonb)
                       FROM jsonb_each(p.match_info) AS info
                      WHERE info.key IN (${FCO_PUBLIC_MATCH_INFO_KEYS.filter(key => detail || !["player", "shootDetail"].includes(key)).map((key) => `'${key}'`).join(", ")}))
    ) ORDER BY p.side_no)
   FROM fco_match_participant p
   LEFT JOIN streamer_fco_account link ON link.ouid = p.ouid AND link.visibility = 'public'
   LEFT JOIN streamer s ON s.id = p.streamer_id AND s.id = link.streamer_id
                       AND s.visibility = 'public'
   WHERE p.match_id = m.match_id) AS participants
  FROM match m
  JOIN fco_match_detail d ON d.match_id = m.match_id
  LEFT JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = 'fconline'
  LEFT JOIN event e ON e.id = COALESCE(ms.event_id, m.event_id) AND e.game_code = 'fconline'
  WHERE ${PUBLIC_FCO_MATCH}`;

const gameSelect = selectGame();

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

/** 로비의 FC 카드 숫자. 경기는 공개 FC 경기 수, 사람은 FC 기록 화면이 있는 스트리머 수(listFcoPeople 과 같은 조건). */
export async function countFcoPublic(): Promise<{ people: number; matches: number }> {
  const rows = await db().unsafe<{ people: number; matches: number }[]>(`
    SELECT (SELECT count(DISTINCT s.id)::int
              FROM streamer s
              JOIN streamer_fco_account link ON link.streamer_id = s.id AND link.visibility = 'public'
             WHERE s.visibility = 'public') AS people,
           (SELECT count(*)::int FROM match m WHERE ${PUBLIC_FCO_MATCH}) AS matches
  `);
  return rows[0];
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

export interface FcoRecordFilter { mode?: string; from?: string; to?: string }

/** 필터 옵션은 현재 페이지의 경기 제한과 무관하게 전체 공개 기록에서 구한다. */
export async function listFcoModesForPerson(streamerId: string): Promise<string[]> {
  const rows = await db().unsafe<{ mode_key: string }[]>(`
    SELECT DISTINCT m.mode_key
      FROM match m
      JOIN fco_match_participant mine ON mine.match_id = m.match_id AND mine.streamer_id = $1
      JOIN streamer_fco_account link ON link.ouid = mine.ouid
        AND link.streamer_id = mine.streamer_id AND link.visibility = 'public'
     WHERE m.game_code = 'fconline' AND m.visibility = 'public' AND m.mode_key IS NOT NULL
     ORDER BY m.mode_key
  `, [streamerId]);
  return rows.map((row) => row.mode_key);
}

/** 다전제의 첫 공개 경기일로 기간을 고른다. 목록과 모든 요약에서 이 SQL만 사용한다. */
const personGamesScope = `
  AND ($2::text IS NULL OR m.mode_key = $2)
  AND ($3::date IS NULL OR (COALESCE((SELECT min(g.game_creation) FROM match g WHERE g.series_id = m.series_id
       AND g.visibility = 'public'), m.game_creation) AT TIME ZONE 'Asia/Seoul')::date >= $3::date)
  AND ($4::date IS NULL OR (COALESCE((SELECT min(g.game_creation) FROM match g WHERE g.series_id = m.series_id
       AND g.visibility = 'public'), m.game_creation) AT TIME ZONE 'Asia/Seoul')::date <= $4::date)
  AND EXISTS (SELECT 1 FROM fco_match_participant mine
    JOIN streamer_fco_account link ON link.ouid = mine.ouid AND link.streamer_id = mine.streamer_id AND link.visibility = 'public'
    WHERE mine.match_id = m.match_id AND mine.streamer_id = $1)`;
const scopeValues = (id: string, filter: FcoRecordFilter) => [id, filter.mode ?? null, filter.from ?? null, filter.to ?? null];

export async function listFcoGamesForPerson(streamerId: string, limit: number | null = 60, filter: FcoRecordFilter = {}, detail = true): Promise<FcoGame[]> {
  return games(await db().unsafe<GameRow[]>(`SELECT ${selectGame(detail)} ${personGamesScope}
    ORDER BY m.game_creation DESC, m.match_id DESC LIMIT $5`, [...scopeValues(streamerId, filter), limit]));
}

/** 커서는 묶음 단위다. limit은 다전제 수이며 어느 페이지도 다전제를 중간에서 끊지 않는다. */
export async function listFcoStreamerGamesForPerson(streamerId: string, limit: number | null = 200, filter: FcoRecordFilter = {}, cursorValue?: string): Promise<FcoGame[]> {
  const cursor = readRecordCursor(cursorValue);
  return games(await db().unsafe<GameRow[]>(`
    WITH scoped AS (SELECT ${selectGame(false)} ${personGamesScope}
      AND EXISTS (SELECT 1 FROM fco_match_participant opponent
        JOIN streamer_fco_account l ON l.ouid = opponent.ouid AND l.streamer_id = opponent.streamer_id AND l.visibility = 'public'
        JOIN streamer s ON s.id = l.streamer_id AND s.visibility = 'public'
        WHERE opponent.match_id = m.match_id AND opponent.streamer_id <> $1)
    ), grouped AS (
      SELECT COALESCE(series_id, id) AS key, min(played_at) AS at FROM scoped GROUP BY COALESCE(series_id, id)
    ), page AS (
      SELECT * FROM grouped WHERE ($6::timestamptz IS NULL OR at < $6 OR (at = $6 AND key > $7))
      ORDER BY at DESC, key LIMIT $5
    ) SELECT s.* FROM scoped s JOIN page p ON p.key = COALESCE(s.series_id, s.id)
      ORDER BY p.at DESC, p.key, s.played_at DESC, s.id DESC`,
    [...scopeValues(streamerId, filter), limit, cursor?.at ?? null, cursor?.id ?? null]));
}
export interface FcoProfileEventRecord {
  slug: string; name: string; kind: string; games: number; wins: number; draws: number; losses: number; unknown: number;
  firstPlayed: string; lastPlayed: string;
}
export async function getFcoPersonalSummary(streamerId: string, filter: FcoRecordFilter = {}): Promise<FcoStatLine & {lastPlayed: string | null}> {
  const rows = await db().unsafe<(FcoStatLine & {lastPlayed: string | null})[]>(`
    WITH scoped AS (SELECT ${selectGame(false)} ${personGamesScope}), mine AS (
      SELECT played_at, p FROM scoped CROSS JOIN LATERAL jsonb_array_elements(participants) p WHERE p->>'streamer_id' = $1::text
    ) SELECT count(*)::int AS games, count(*) FILTER (WHERE p->>'outcome' = 'win')::int AS wins,
      count(*) FILTER (WHERE p->>'outcome' = 'draw')::int AS draws, count(*) FILTER (WHERE p->>'outcome' = 'loss')::int AS losses,
      COALESCE(sum((p->>'goals')::int),0)::int AS goals,
      COALESCE(sum((p#>>'{match_info,shoot,shootTotal}')::numeric),0)::float8 AS shots,
      COALESCE(sum((p#>>'{match_info,shoot,effectiveShootTotal}')::numeric),0)::float8 AS "shotsOnTarget",
      COALESCE(sum((p#>>'{match_info,pass,passTry}')::numeric),0)::float8 AS "passTry",
      COALESCE(sum((p#>>'{match_info,pass,passSuccess}')::numeric),0)::float8 AS "passSuccess",
      COALESCE(sum((p#>>'{match_info,defence,tackleSuccess}')::numeric),0)::float8 AS tackles,
      COALESCE(sum((p#>>'{match_info,matchDetail,possession}')::numeric),0)::float8 AS "possessionTotal",
      max(played_at)::text AS "lastPlayed" FROM mine`, scopeValues(streamerId, filter));
  return rows[0];
}
export async function listFcoPersonalEvents(streamerId: string, filter: FcoRecordFilter = {}): Promise<FcoProfileEventRecord[]> {
  return db().unsafe<FcoProfileEventRecord[]>(`
    WITH scoped AS (SELECT ${selectGame(false)} ${personGamesScope})
    SELECT event_slug AS slug, min(event_name) AS name, min(event_kind) AS kind,
      count(*)::int AS games, count(*) FILTER (WHERE p->>'outcome' = 'win')::int AS wins,
      count(*) FILTER (WHERE p->>'outcome' = 'draw')::int AS draws,
      count(*) FILTER (WHERE p->>'outcome' = 'loss')::int AS losses,
      count(*) FILTER (WHERE p->>'outcome' = 'unknown')::int AS unknown,
      min(played_at)::text AS "firstPlayed", max(played_at)::text AS "lastPlayed"
    FROM scoped CROSS JOIN LATERAL jsonb_array_elements(participants) p
    WHERE p->>'streamer_id' = $1::text AND event_slug IS NOT NULL
    GROUP BY event_slug ORDER BY max(played_at) DESC, event_slug`, scopeValues(streamerId, filter));
}

export async function listFcoVersus(aId: string, bId: string): Promise<FcoGame[]> {
  const rows = await db().unsafe<GameRow[]>(`
    SELECT ${gameSelect}
      AND EXISTS (SELECT 1 FROM fco_match_participant a
                   JOIN streamer_fco_account la ON la.ouid = a.ouid AND la.streamer_id = a.streamer_id AND la.visibility = 'public'
                   WHERE a.match_id = m.match_id AND a.streamer_id = $1)
      AND EXISTS (SELECT 1 FROM fco_match_participant b
                   JOIN streamer_fco_account lb ON lb.ouid = b.ouid AND lb.streamer_id = b.streamer_id AND lb.visibility = 'public'
                   WHERE b.match_id = m.match_id AND b.streamer_id = $2)
     ORDER BY m.game_creation DESC, m.match_id DESC
  `, [aId, bId]);
  return games(rows);
}

export interface FcoTopPair {
  a_id: string;
  b_id: string;
  games: number;
  a_wins: number;
  b_wins: number;
  draws: number;
}

/** 공개 계정이 확인된 스트리머끼리의 경기만 집계한다. */
export async function listFcoTopPairs(limit = 8, streamerId?: string): Promise<FcoTopPair[]> {
  return db().unsafe<FcoTopPair[]>(`
    SELECT LEAST(a.streamer_id, b.streamer_id) AS a_id,
           GREATEST(a.streamer_id, b.streamer_id) AS b_id,
           count(*)::int AS games,
           count(*) FILTER (WHERE (CASE WHEN a.streamer_id < b.streamer_id THEN a.outcome ELSE b.outcome END) = 'win')::int AS a_wins,
           count(*) FILTER (WHERE (CASE WHEN a.streamer_id < b.streamer_id THEN b.outcome ELSE a.outcome END) = 'win')::int AS b_wins,
           count(*) FILTER (WHERE a.outcome = 'draw' OR b.outcome = 'draw')::int AS draws
      FROM fco_match_participant a
      JOIN fco_match_participant b ON b.match_id = a.match_id AND b.side_no > a.side_no
      JOIN match m ON m.match_id = a.match_id AND m.game_code = 'fconline' AND m.visibility = 'public'
      JOIN streamer_fco_account la ON la.ouid = a.ouid AND la.streamer_id = a.streamer_id AND la.visibility = 'public'
      JOIN streamer_fco_account lb ON lb.ouid = b.ouid AND lb.streamer_id = b.streamer_id AND lb.visibility = 'public'
      JOIN streamer sa ON sa.id = a.streamer_id AND sa.visibility = 'public'
      JOIN streamer sb ON sb.id = b.streamer_id AND sb.visibility = 'public'
     WHERE a.streamer_id IS NOT NULL AND b.streamer_id IS NOT NULL AND a.streamer_id <> b.streamer_id
       AND ($2::uuid IS NULL OR a.streamer_id = $2::uuid OR b.streamer_id = $2::uuid)
     GROUP BY LEAST(a.streamer_id, b.streamer_id), GREATEST(a.streamer_id, b.streamer_id)
     ORDER BY games DESC, a_id, b_id
     LIMIT $1
  `, [limit, streamerId ?? null]);
}

/** 전적 검색 첫 화면에서 보여 줄, 실제 맞대결이 가장 많은 공개 스트리머 쌍. */
export async function getFeaturedFcoPair(): Promise<{ aId: string; bId: string } | null> {
  const rows = await db()<{ a_id: string; b_id: string }[]>`
    SELECT LEAST(a.streamer_id, b.streamer_id) AS a_id,
           GREATEST(a.streamer_id, b.streamer_id) AS b_id
      FROM fco_match_participant a
      JOIN fco_match_participant b ON b.match_id = a.match_id AND b.side_no > a.side_no
      JOIN match m ON m.match_id = a.match_id AND m.game_code = 'fconline' AND m.visibility = 'public'
      JOIN streamer_fco_account la ON la.ouid = a.ouid AND la.streamer_id = a.streamer_id AND la.visibility = 'public'
      JOIN streamer_fco_account lb ON lb.ouid = b.ouid AND lb.streamer_id = b.streamer_id AND lb.visibility = 'public'
      JOIN streamer sa ON sa.id = a.streamer_id AND sa.visibility = 'public'
      JOIN streamer sb ON sb.id = b.streamer_id AND sb.visibility = 'public'
     WHERE a.streamer_id IS NOT NULL AND b.streamer_id IS NOT NULL AND a.streamer_id <> b.streamer_id
     GROUP BY LEAST(a.streamer_id, b.streamer_id), GREATEST(a.streamer_id, b.streamer_id)
     ORDER BY count(*) DESC, a_id, b_id
     LIMIT 1
  `;
  return rows[0] ? { aId: rows[0].a_id, bId: rows[0].b_id } : null;
}

export async function getFcoGame(providerId: string): Promise<FcoGame | null> {
  const rows = await db().unsafe<GameRow[]>(`
    SELECT ${gameSelect} AND d.provider_match_id = $1
      AND EXISTS (SELECT 1 FROM fco_match_participant p
                   JOIN streamer_fco_account link ON link.ouid = p.ouid AND link.visibility = 'public'
                   JOIN streamer s ON s.id = link.streamer_id AND s.visibility = 'public'
                   WHERE p.match_id = m.match_id)
     LIMIT 1
  `, [providerId]);
  return games(rows)[0] ?? null;
}

/** 목록·상세·메인이 같은 공개 경기 집계와 보완 날짜를 읽는다.
 * 경기 귀속과 공개 조건은 listFcoEventGames와 동일하다. 직접/시리즈 연결을 중복 집계하지 않는다.
 * 등록 일정 원본은 보존하고, 조회 결과에만 effective_*를 만든다. */
const fcoDatedEvents = `
  WITH event_games AS (
    SELECT COALESCE(ms.event_id, m.event_id) AS event_id, count(*)::int AS game_count,
           min(m.game_creation) AS first_played_at, max(m.game_creation) AS last_played_at,
           (array_agg(d.provider_match_id ORDER BY m.game_creation DESC, m.match_id DESC))[1] AS latest_provider_id
      FROM match m
      JOIN fco_match_detail d ON d.match_id = m.match_id
      LEFT JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = 'fconline'
     WHERE ${PUBLIC_FCO_MATCH} AND COALESCE(ms.event_id, m.event_id) IS NOT NULL
     GROUP BY COALESCE(ms.event_id, m.event_id)
  ), dated_events AS (
    SELECT e.id, e.slug, e.name, e.kind, e.organizer, e.starts_at, e.ends_at, e.source_url,
           COALESCE(e.starts_at, g.first_played_at) AS effective_starts_at,
           COALESCE(e.ends_at, g.last_played_at) AS effective_ends_at,
           COALESCE(g.game_count, 0)::int AS game_count, g.last_played_at, g.latest_provider_id
      FROM event e LEFT JOIN event_games g ON g.event_id = e.id
     WHERE e.game_code = 'fconline' AND e.slug IS NOT NULL
  )`;

const fcoEventColumns = `id, slug, name, kind, organizer, starts_at, ends_at, source_url,
  effective_starts_at, effective_ends_at, game_count`;

/** 상세가 열리는 행사 집합. 대회 목록 정책과 독립적이다. */
export async function listFcoDetailEvents(ids?: string[]): Promise<FcoEvent[]> {
  return db().unsafe<FcoEvent[]>(`${fcoDatedEvents}
    SELECT ${fcoEventColumns} FROM dated_events
     WHERE ($1::uuid[] IS NULL OR id = ANY($1::uuid[]))
     ORDER BY effective_starts_at DESC NULLS LAST, slug
  `, [ids ?? null]);
}

export async function listFcoEvents(): Promise<FcoEvent[]> {
  return (await listFcoDetailEvents()).filter(event => listedInTournaments(event.kind));
}

export interface FcoRecentEvent extends FcoEvent {
  last_played_at: string;
  latest_provider_id: string;
}

/** 메인의 짧은 히스토리. 일정이 비어 있는 CK도 실제 공개 경기 시각으로 정렬한다.
 * 선수 통계 원본은 읽지 않고, 같은 경기를 event/series 양쪽에서 중복 집계하지 않는다. */
export async function listFcoRecentEvents(limit = 3): Promise<FcoRecentEvent[]> {
  return db().unsafe<FcoRecentEvent[]>(`${fcoDatedEvents}
    SELECT ${fcoEventColumns}, last_played_at, latest_provider_id FROM dated_events
     WHERE last_played_at IS NOT NULL AND kind IN ('ck', 'tournament', 'showmatch', 'scrim')
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

export async function listFcoEventGames(eventId: string): Promise<FcoGame[]> {
  const rows = await db().unsafe<GameRow[]>(`
    SELECT ${gameSelect} AND COALESCE(ms.event_id, m.event_id) = $1
     ORDER BY m.game_creation, m.series_id, m.series_game_no
  `, [eventId]);
  return games(rows);
}

