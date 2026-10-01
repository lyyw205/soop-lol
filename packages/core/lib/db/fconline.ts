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

const gameSelect = `
  m.match_id AS id, d.provider_match_id AS provider_id, m.game_creation AS played_at,
  m.mode_key, COALESCE(ms.event_id, m.event_id) AS event_id,
  e.name AS event_name, e.slug AS event_slug, m.series_id, m.series_game_no, ms.best_of,
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
                      WHERE info.key IN (${FCO_PUBLIC_MATCH_INFO_KEYS.map((key) => `'${key}'`).join(", ")}))
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

export async function listFcoGamesForPerson(streamerId: string, limit = 60, filter: FcoRecordFilter = {}): Promise<FcoGame[]> {
  const rows = await db().unsafe<GameRow[]>(`
    SELECT ${gameSelect}
      AND ($3::text IS NULL OR m.mode_key = $3)
      AND ($4::text IS NULL OR (m.game_creation AT TIME ZONE 'Asia/Seoul')::date >= $4::date)
      AND ($5::text IS NULL OR (m.game_creation AT TIME ZONE 'Asia/Seoul')::date <= $5::date)
      AND EXISTS (SELECT 1 FROM fco_match_participant mine
                   JOIN streamer_fco_account link ON link.ouid = mine.ouid
                                                AND link.streamer_id = mine.streamer_id
                                                AND link.visibility = 'public'
                   WHERE mine.match_id = m.match_id AND mine.streamer_id = $1)
     ORDER BY m.game_creation DESC LIMIT $2
  `, [streamerId, limit, filter.mode ?? null, filter.from ?? null, filter.to ?? null]);
  return games(rows);
}

/** 공개 계정으로 확인된 다른 스트리머와의 경기만 매치 히스토리에 노출한다. */
export async function listFcoStreamerGamesForPerson(streamerId: string, limit = 200, filter: FcoRecordFilter = {}): Promise<FcoGame[]> {
  const rows = await db().unsafe<GameRow[]>(`
    SELECT ${gameSelect}
      AND ($3::text IS NULL OR m.mode_key = $3)
      AND ($4::text IS NULL OR (m.game_creation AT TIME ZONE 'Asia/Seoul')::date >= $4::date)
      AND ($5::text IS NULL OR (m.game_creation AT TIME ZONE 'Asia/Seoul')::date <= $5::date)
      AND EXISTS (SELECT 1 FROM fco_match_participant mine
                   JOIN streamer_fco_account own_link ON own_link.ouid = mine.ouid
                     AND own_link.streamer_id = mine.streamer_id AND own_link.visibility = 'public'
                   WHERE mine.match_id = m.match_id AND mine.streamer_id = $1)
      AND EXISTS (SELECT 1 FROM fco_match_participant opponent
                   JOIN streamer_fco_account opponent_link ON opponent_link.ouid = opponent.ouid
                     AND opponent_link.streamer_id = opponent.streamer_id AND opponent_link.visibility = 'public'
                   JOIN streamer opponent_streamer ON opponent_streamer.id = opponent_link.streamer_id
                     AND opponent_streamer.visibility = 'public'
                   WHERE opponent.match_id = m.match_id AND opponent.streamer_id <> $1)
     ORDER BY m.game_creation DESC LIMIT $2
  `, [streamerId, limit, filter.mode ?? null, filter.from ?? null, filter.to ?? null]);
  return games(rows);
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
     ORDER BY m.game_creation DESC LIMIT 200
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
export async function listFcoTopPairs(limit = 8): Promise<FcoTopPair[]> {
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
     GROUP BY LEAST(a.streamer_id, b.streamer_id), GREATEST(a.streamer_id, b.streamer_id)
     ORDER BY games DESC, a_id, b_id
     LIMIT $1
  `, [limit]);
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

export async function listFcoEvents(): Promise<FcoEvent[]> {
  return db()<FcoEvent[]>`
    SELECT e.id, e.slug, e.name, e.kind, e.organizer, e.starts_at, e.ends_at,
           e.source_url, (count(DISTINCT m.match_id) + count(DISTINCT series_match.match_id))::int AS game_count
      FROM event e
      LEFT JOIN match m ON m.game_code = 'fconline' AND m.visibility = 'public'
                       AND m.event_id = e.id
      LEFT JOIN match_series ms ON ms.event_id = e.id AND ms.game_code = 'fconline'
      LEFT JOIN match series_match ON series_match.series_id = ms.id
                                  AND series_match.game_code = 'fconline'
                                  AND series_match.visibility = 'public'
     WHERE e.game_code = 'fconline' AND e.slug IS NOT NULL
     GROUP BY e.id
     ORDER BY e.starts_at DESC NULLS LAST, e.created_at DESC
  `;
}

export async function getFcoEvent(slug: string): Promise<FcoEvent | null> {
  const rows = await db()<FcoEvent[]>`
    SELECT e.id, e.slug, e.name, e.kind, e.organizer, e.starts_at, e.ends_at,
           e.source_url, (count(DISTINCT m.match_id) + count(DISTINCT series_match.match_id))::int AS game_count
      FROM event e
      LEFT JOIN match m ON m.game_code = 'fconline' AND m.visibility = 'public'
                       AND m.event_id = e.id
      LEFT JOIN match_series ms ON ms.event_id = e.id AND ms.game_code = 'fconline'
      LEFT JOIN match series_match ON series_match.series_id = ms.id
                                  AND series_match.game_code = 'fconline'
                                  AND series_match.visibility = 'public'
     WHERE e.game_code = 'fconline' AND e.slug = ${slug}
     GROUP BY e.id
  `;
  return rows[0] ?? null;
}

export async function listFcoEventGames(eventId: string): Promise<FcoGame[]> {
  const rows = await db().unsafe<GameRow[]>(`
    SELECT ${gameSelect} AND COALESCE(ms.event_id, m.event_id) = $1
     ORDER BY m.game_creation, m.series_id, m.series_game_no
  `, [eventId]);
  return games(rows);
}

export interface FcoRankRow extends FcoPerson {
  games: number;
  wins: number;
  draws: number;
  losses: number;
  goals: number;
}

export async function listFcoLeaderboard(): Promise<FcoRankRow[]> {
  return db()<FcoRankRow[]>`
    SELECT s.id, s.slug, s.display_name AS name, s.profile_image_url AS image,
           min(a.nickname) AS nickname,
           count(*)::int AS games,
           count(*) FILTER (WHERE p.outcome = 'win')::int AS wins,
           count(*) FILTER (WHERE p.outcome = 'draw')::int AS draws,
           count(*) FILTER (WHERE p.outcome = 'loss')::int AS losses,
           coalesce(sum(p.goals), 0)::int AS goals
      FROM fco_match_participant p
      JOIN match m ON m.match_id = p.match_id AND m.game_code = 'fconline'
                  AND m.visibility = 'public'
      JOIN streamer s ON s.id = p.streamer_id AND s.visibility = 'public'
      JOIN streamer_fco_account link ON link.streamer_id = s.id
                                     AND link.ouid = p.ouid AND link.visibility = 'public'
      JOIN fco_account a ON a.ouid = link.ouid
     GROUP BY s.id
     -- 순위 정책(무엇이 먼저인가)은 리더보드 모듈의 것이다. 여기는 집계만 한다.
     ORDER BY name
  `;
}
