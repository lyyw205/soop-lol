/**
 * 공개 화면 질의.
 *
 * ★ 전부 `core_public` 뷰만 읽는다. 원본 테이블을 쓰지 않는다.
 *   관리자 화면(`streamers.ts`)은 원본을 보지만, 공개 화면은 숨김 처리를
 *   **질의마다 기억해서** 지키는 게 아니라 뷰가 대신 지키게 한다.
 *   `WHERE visibility = 'public'` 을 한 군데라도 빠뜨리면 그게 사고다.
 *
 * 모듈이 쓰는 `lib/contract` 와 같은 면을 본다 — 공개 화면도 결국 모듈과
 * 같은 자격으로 core 를 읽는 소비자다.
 */

import { db } from "./client.ts";
import { expandCategory, type MatchCategoryFilter } from "../metrics/category.ts";
import { PLACEMENT_BUCKETS, placementBucket } from "../metrics/placement.ts";

// ── 목록 ─────────────────────────────────────────────────────────────

export interface StreamerCard {
  streamer_id: string;
  slug: string;
  display_name: string;
  aliases: string[];
  is_pro: boolean;
  team_name: string | null;
  channel_id: string | null;
  channel_url: string | null;
  platform: string | null;
  tier: string | null;
  division: string | null;
  league_points: number | null;
  lp_absolute: number | null;
  matches: number;
  encounters: number;
}

export async function listStreamerCards(opts: { q?: string } = {}): Promise<StreamerCard[]> {
  const sql = db();
  const q = opts.q?.trim();
  return sql<StreamerCard[]>`
    SELECT s.streamer_id, s.slug, s.display_name, s.aliases, s.is_pro, s.team_name,
           ch.channel_id, ch.channel_url, ch.platform,
           r.tier, r.division, r.league_points, r.lp_absolute,
           coalesce(mc.n, 0)::int AS matches,
           coalesce(ec.n, 0)::int AS encounters
      FROM core_public.streamer s
      LEFT JOIN LATERAL (
             SELECT platform, channel_id, channel_url FROM core_public.streamer_channel
              WHERE streamer_id = s.streamer_id ORDER BY is_primary DESC LIMIT 1
           ) ch ON true
      -- 계정이 여러 개면 **가장 높은 계정**으로 대표한다. 부계정이 따로 뜨면 같은 사람이 두 줄이 된다.
      LEFT JOIN LATERAL (
             SELECT tier, division, league_points, lp_absolute
               FROM core_public.rank_snapshot
              WHERE streamer_id = s.streamer_id AND queue_type = 'RANKED_SOLO_5x5'
                AND snapshot_date = (SELECT max(snapshot_date) FROM core_public.rank_snapshot
                                      WHERE streamer_id = s.streamer_id AND queue_type = 'RANKED_SOLO_5x5')
              ORDER BY lp_absolute DESC NULLS LAST LIMIT 1
           ) r ON true
      LEFT JOIN LATERAL (
             SELECT count(*) AS n FROM core_public.match_participant WHERE streamer_id = s.streamer_id
           ) mc ON true
      LEFT JOIN LATERAL (
             SELECT count(*) AS n FROM core_public.streamer_encounter
              WHERE streamer_a_id = s.streamer_id OR streamer_b_id = s.streamer_id
           ) ec ON true
     WHERE ${q
       ? sql`(s.display_name ILIKE ${"%" + q + "%"}
              OR s.slug ILIKE ${"%" + q + "%"}
              OR EXISTS (SELECT 1 FROM unnest(s.aliases) a WHERE a ILIKE ${"%" + q + "%"})
              OR EXISTS (SELECT 1 FROM core_public.streamer_channel c
                          WHERE c.streamer_id = s.streamer_id AND c.channel_id ILIKE ${"%" + q + "%"}))`
       : sql`true`}
     ORDER BY r.lp_absolute DESC NULLS LAST, s.display_name
  `;
}

/** 선택기용 최소 목록. 카드 질의(listStreamerCards)는 티어·판수까지 붙여서 무겁다. */
export async function listStreamerOptions(): Promise<{ slug: string; display_name: string }[]> {
  const sql = db();
  return sql`
    SELECT slug, display_name FROM core_public.streamer ORDER BY display_name
  `;
}

export interface TopPair {
  a_slug: string; a_name: string;
  b_slug: string; b_name: string;
  sets: number;
  /** 상대편으로 만난 세트. 같은 팀이었던 건 뺀다 — 이 사이트가 묻는 건 맞대결이다. */
  vs_sets: number;
  lane_sets: number;
  last_met: Date;
}

/**
 * 많이 붙은 쌍. `/vs` 첫 화면이 빈 선택기만 있으면 볼 게 없어서 같이 보여준다.
 *
 * ★ 정렬은 **맞대결 세트 수**다. 총 조우가 아니라. 같은 팀으로만 30판 만난 쌍이
 *   맞대결 20판 쌍보다 위에 오면, 이 사이트가 무엇을 세는 곳인지 첫 화면부터 어긋난다.
 */
export async function listTopPairs(limit = 20): Promise<TopPair[]> {
  const sql = db();
  return sql<TopPair[]>`
    SELECT a.slug AS a_slug, a.display_name AS a_name,
           b.slug AS b_slug, b.display_name AS b_name,
           count(*)::int                                            AS sets,
           count(*) FILTER (WHERE e.relation = 'opponent')::int      AS vs_sets,
           count(*) FILTER (WHERE e.is_lane_matchup)::int            AS lane_sets,
           max(e.game_creation)                                      AS last_met
      FROM core_public.streamer_encounter e
      JOIN core_public.streamer a ON a.streamer_id = e.streamer_a_id
      JOIN core_public.streamer b ON b.streamer_id = e.streamer_b_id
     GROUP BY 1, 2, 3, 4
    HAVING count(*) FILTER (WHERE e.relation = 'opponent') > 0
     ORDER BY vs_sets DESC, sets DESC
     LIMIT ${limit}
  `;
}

// ── 프로필 ───────────────────────────────────────────────────────────

export interface ProfileAccount {
  puuid: string;
  game_name: string | null;
  tag_line: string | null;
  label: string | null;
  is_main: boolean;
  tier: string | null;
  division: string | null;
  league_points: number | null;
  lp_absolute: number | null;
  wins: number | null;
  losses: number | null;
}

export interface ChampionRow {
  champion_id: number;
  champion_name: string | null;
  games: number;
  wins: number;
  kills: number;
  deaths: number;
  assists: number;
  cs: number;
  seconds_played: number;
}

export interface RecentGame {
  match_id: string;
  game_creation: Date;
  game_duration: number | null;
  queue_id: number;
  /** 경기 분류 (solo/scrim/tournament …). 화면이 뱃지를 달 때 쓴다. */
  category: string;
  champion_id: number;
  champion_name: string | null;
  team_position: string | null;
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
  cs: number | null;
}

/**
 * 상대전적. **세트와 매치를 나눠서** 준다.
 *
 * 3판 2선승을 2:1 로 이기면 세트로는 2승 1패, 매치로는 1승 0패다.
 * 둘은 다른 사실이라 하나로 뭉치면 둘 다 틀린다 — 세트만 세면 다전제 승리가
 * 단판 두 번과 같아지고, 매치만 세면 진 쪽이 딴 세트가 사라진다.
 *
 * 단판(공개 큐)은 자기 자신이 곧 시리즈라 `sets` 와 `matches` 가 같다.
 */
export interface OpponentRow {
  streamer_id: string;
  slug: string;
  display_name: string;
  /** 세트(판) 단위 */
  vs_sets: number;
  vs_set_wins: number;
  ally_sets: number;
  ally_set_wins: number;
  lane_sets: number;
  lane_set_wins: number;
  /** 매치(경기) 단위 — 다전제 한 판이 1로 센다 */
  vs_matches: number;
  vs_match_wins: number;
  vs_match_draws: number;
  ally_matches: number;
  ally_match_wins: number;
  ally_match_draws: number;
  lane_matches: number;
  lane_match_wins: number;
  lane_match_draws: number;
  last_met: Date;
}

export async function getStreamerBySlug(slug: string) {
  const sql = db();
  const rows = await sql<
    { streamer_id: string; slug: string; display_name: string; aliases: string[]; is_pro: boolean; team_name: string | null; profile_image_url: string | null }[]
  >`
    SELECT streamer_id, slug, display_name, aliases, is_pro, team_name, profile_image_url
      FROM core_public.streamer WHERE slug = ${slug} LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function listPublicChannels(
  streamerId: string,
): Promise<{ platform: string; channel_id: string; channel_url: string | null; label: string | null; is_primary: boolean }[]> {
  const sql = db();
  return sql`
    SELECT platform, channel_id, channel_url, label, is_primary
      FROM core_public.streamer_channel
     WHERE streamer_id = ${streamerId}::uuid
     ORDER BY is_primary DESC, platform
  `;
}

export async function listProfileAccounts(streamerId: string): Promise<ProfileAccount[]> {
  const sql = db();
  return sql<ProfileAccount[]>`
    SELECT a.puuid, a.game_name, a.tag_line, a.label, a.is_main,
           r.tier, r.division, r.league_points, r.lp_absolute, r.wins, r.losses
      FROM core_public.streamer_account a
      LEFT JOIN LATERAL (
             SELECT tier, division, league_points, lp_absolute, wins, losses
               FROM core_public.rank_snapshot
              WHERE puuid = a.puuid AND queue_type = 'RANKED_SOLO_5x5'
              ORDER BY snapshot_date DESC LIMIT 1
           ) r ON true
     WHERE a.streamer_id = ${streamerId}::uuid
     ORDER BY a.is_main DESC, r.lp_absolute DESC NULLS LAST
  `;
}

export async function listChampions(
  streamerId: string,
  limit = 8,
  /**
   * 분류 필터. 없으면 전부 합친다.
   * ★ 합친 값이 기본인 건 "이 사람이 뭘 잘 하나" 를 묻는 칸이라서다. 다만 화면은
   *   **무엇을 합쳤는지 말해야 한다** — 솔랭 1판과 내전 3판이 아무 표시 없이
   *   한 줄에 있으면 §11-7 이 막으려던 바로 그 상태가 된다.
   */
  category?: MatchCategoryFilter,
): Promise<ChampionRow[]> {
  const sql = db();
  return sql<ChampionRow[]>`
    SELECT cs.champion_id,
           (SELECT mp.champion_name FROM core_public.match_participant mp
             WHERE mp.champion_id = cs.champion_id AND mp.champion_name IS NOT NULL LIMIT 1) AS champion_name,
           sum(cs.games)::int AS games, sum(cs.wins)::int AS wins,
           sum(cs.kills)::int AS kills, sum(cs.deaths)::int AS deaths, sum(cs.assists)::int AS assists,
           sum(cs.cs)::bigint AS cs, sum(cs.seconds_played)::bigint AS seconds_played
      FROM core_public.champion_stat cs
     WHERE cs.streamer_id = ${streamerId}::uuid AND cs.season = 'ALL'
       AND (${expandCategory(category)}::text[] IS NULL
            OR cs.category = ANY(${expandCategory(category)}::text[]))
     GROUP BY cs.champion_id
     ORDER BY sum(cs.games) DESC
     LIMIT ${limit}
  `;
}

export async function listRecentGames(
  streamerId: string,
  limit = 20,
  /**
   * 기본은 **공개 큐 묶음**이다(§11-7) — 화면도 "공개 큐만" 이라고 써 놨다.
   * 'scrim' 을 주면 내전 목록이 되고, 'all' 은 말 그대로 전부다.
   */
  category: MatchCategoryFilter = "public_queue",
): Promise<RecentGame[]> {
  const sql = db();
  return sql<RecentGame[]>`
    SELECT mp.match_id, m.game_creation, m.game_duration, m.queue_id, m.category,
           mp.champion_id, mp.champion_name, mp.team_position, mp.win,
           mp.kills, mp.deaths, mp.assists, mp.cs
      FROM core_public.match_participant mp
      JOIN core_public.match m ON m.match_id = mp.match_id
     WHERE mp.streamer_id = ${streamerId}::uuid
       -- ★ 아무 것도 안 주면 **공개 큐만**이다(§11-7). 화면이 이 목록에 "공개 큐만"
       --   이라고 써 두는데 거르지 않으면 그 말이 거짓이 된다. 실제로 그랬다 —
       --   내전을 처음 넣자마자 수기 경기 5건이 최근 경기 맨 위를 차지했고,
       --   챔피언을 모르니 '챔피언 0' 으로 떴다.
       AND (${expandCategory(category)}::text[] IS NULL
            OR m.category = ANY(${expandCategory(category)}::text[]))
     ORDER BY m.game_creation DESC
     LIMIT ${limit}
  `;
}

/**
 * 상대 전적 — 이 프로필의 훅이다.
 *
 * 상대편으로 만난 것과 같은 팀으로 만난 것을 **섞지 않는다.**
 * 같은 팀 승리를 상대전적에 넣으면 "이겼다"의 뜻이 달라진다.
 *
 * ★ `limit` 은 **화면에 몇 명 보일지가 아니라 안전 상한**이다.
 *   정렬(판수·최신·승률)은 `metrics/opponents.ts` 가 TS 에서 한다 — 승률 정렬이
 *   베이지안 축소를 거쳐야 하고 그 계산은 `affinity.ts` 한 곳에만 두기로 했기 때문이다.
 *   여기서 20 명으로 잘라 버리면 "가장 많이 만난 20명을 승률로 정렬한 것" 이 되어
 *   정렬이 조용히 거짓말을 한다. 그래서 넉넉히 받아 가고, 자르는 건 정렬 뒤에 한다.
 *   (상한에 걸릴 만큼 상대가 많으면 많이 만난 쪽부터 남는다 — 아래 ORDER BY)
 */
export async function listOpponents(
  streamerId: string,
  opts: { limit?: number; year?: number } = {},
): Promise<OpponentRow[]> {
  const { limit = 300, year } = opts;
  const sql = db();
  return sql<OpponentRow[]>`
    WITH e AS (
      SELECT CASE WHEN streamer_a_id = ${streamerId}::uuid THEN streamer_b_id ELSE streamer_a_id END AS other_id,
             CASE WHEN streamer_a_id = ${streamerId}::uuid THEN a_win ELSE b_win END AS me_win,
             relation, is_lane_matchup, game_creation, series_key
        FROM core_public.streamer_encounter
       WHERE (streamer_a_id = ${streamerId}::uuid OR streamer_b_id = ${streamerId}::uuid)
         AND (${year ?? null}::int IS NULL OR EXTRACT(YEAR FROM game_creation) = ${year ?? null}::int)
    ),
    -- 시리즈로 접는다. 다전제는 세트 과반을 이긴 쪽이 그 매치의 승자다.
    per_series AS (
      SELECT other_id, relation, series_key,
             count(*)::int                       AS sets,
             count(*) FILTER (WHERE me_win)::int AS my_sets,
             -- 한 시리즈의 모든 세트가 맞라인이면 그 경기를 맞라인 경기로 본다.
             -- 세트마다 라인을 바꿔 붙은 경우까지 맞라인이라 부르면 뜻이 흐려진다.
             bool_and(is_lane_matchup)           AS all_lane
        FROM e GROUP BY other_id, relation, series_key
    ),
    by_set AS (
      SELECT other_id,
             count(*) FILTER (WHERE relation = 'opponent')::int              AS vs_sets,
             count(*) FILTER (WHERE relation = 'opponent' AND me_win)::int   AS vs_set_wins,
             count(*) FILTER (WHERE relation = 'ally')::int                  AS ally_sets,
             count(*) FILTER (WHERE relation = 'ally' AND me_win)::int       AS ally_set_wins,
             count(*) FILTER (WHERE is_lane_matchup)::int                    AS lane_sets,
             count(*) FILTER (WHERE is_lane_matchup AND me_win)::int         AS lane_set_wins,
             max(game_creation)                                             AS last_met
        FROM e GROUP BY other_id
    ),
    by_match AS (
      SELECT other_id,
             -- ★ 2세트제 조별리그(2014~2017)는 1:1 무승부가 있다. 진 게 아니므로
             --    패로 세지 않고 따로 센다. my_sets * 2 = sets 이면 무승부다.
             count(*) FILTER (WHERE relation = 'opponent')::int                          AS vs_matches,
             count(*) FILTER (WHERE relation = 'opponent' AND my_sets * 2 > sets)::int    AS vs_match_wins,
             count(*) FILTER (WHERE relation = 'opponent' AND my_sets * 2 = sets)::int    AS vs_match_draws,
             count(*) FILTER (WHERE relation = 'ally')::int                               AS ally_matches,
             count(*) FILTER (WHERE relation = 'ally' AND my_sets * 2 > sets)::int        AS ally_match_wins,
             count(*) FILTER (WHERE relation = 'ally' AND my_sets * 2 = sets)::int         AS ally_match_draws,
             count(*) FILTER (WHERE all_lane)::int                                        AS lane_matches,
             count(*) FILTER (WHERE all_lane AND my_sets * 2 > sets)::int                 AS lane_match_wins,
             count(*) FILTER (WHERE all_lane AND my_sets * 2 = sets)::int                 AS lane_match_draws
        FROM per_series GROUP BY other_id
    )
    SELECT s.streamer_id, s.slug, s.display_name,
           b.vs_sets, b.vs_set_wins, b.ally_sets, b.ally_set_wins,
           b.lane_sets, b.lane_set_wins, b.last_met,
           m.vs_matches, m.vs_match_wins, m.vs_match_draws,
           m.ally_matches, m.ally_match_wins, m.ally_match_draws,
           m.lane_matches, m.lane_match_wins, m.lane_match_draws
      FROM by_set b
      JOIN by_match m ON m.other_id = b.other_id
      JOIN core_public.streamer s ON s.streamer_id = b.other_id
     ORDER BY (b.vs_sets + b.ally_sets) DESC, b.last_met DESC
     LIMIT ${limit}
  `;
}


// ── 대회 ─────────────────────────────────────────────────────────────

export interface EventRecord {
  event_slug: string;
  event_name: string;
  starts_at: Date;
  team_name: string | null;
  position: string | null;
  /** 출처가 쓴 그대로의 순위 표기. 모르면 null — 지어내지 않는다. */
  placement: string | null;
  placement_rank: number | null;
  matches: number;
  match_wins: number;
  /** 무승부. 2세트제 조별리그가 1:1 로 끝난 경기 (2014~2017). */
  match_draws: number;
  sets: number;
  set_wins: number;
}

/**
 * 이 스트리머가 나간 대회와 그 성적. 최신순.
 *
 * 세트와 매치를 나눠 준다 — 다전제 2:1 은 세트 2승 1패, 매치 1승 0패다.
 * 팀명은 event_team 에서 온다(대회 단위 소속). 계정이 없어 경기에 못 들어간
 * 사람도 팀 명단에는 있으므로 `matches` 가 0인 줄이 나올 수 있다 —
 * "나갔지만 우리가 전적을 못 붙였다" 는 사실이라 지우지 않는다.
 */
export async function listStreamerEvents(streamerId: string, year?: number): Promise<EventRecord[]> {
  const sql = db();
  return sql<EventRecord[]>`
    WITH mine AS (
      SELECT m.match_id,
             COALESCE(m.series_id, m.match_id) AS series_key,
             m.event_id,
             mp.win
        FROM core_public.match_participant mp
        JOIN core_public.match m ON m.match_id = mp.match_id
       WHERE mp.streamer_id = ${streamerId}::uuid AND m.source = 'manual'
    ),
    per_series AS (
      SELECT event_id, series_key,
             count(*)::int                    AS sets,
             count(*) FILTER (WHERE win)::int AS set_wins
        FROM mine GROUP BY event_id, series_key
    ),
    agg AS (
      SELECT event_id,
             count(*)::int                                        AS matches,
             count(*) FILTER (WHERE set_wins * 2 > sets)::int      AS match_wins,
             count(*) FILTER (WHERE set_wins * 2 = sets)::int      AS match_draws,
             sum(sets)::int                                        AS sets,
             sum(set_wins)::int                                    AS set_wins
        FROM per_series GROUP BY event_id
    )
    SELECT e.slug AS event_slug, e.name AS event_name, e.starts_at,
           t.name AS team_name, tm.position, t.placement, t.placement_rank,
           COALESCE(a.matches, 0)     AS matches,
           COALESCE(a.match_wins, 0)  AS match_wins,
           COALESCE(a.match_draws, 0) AS match_draws,
           COALESCE(a.sets, 0)       AS sets,
           COALESCE(a.set_wins, 0)   AS set_wins
      FROM core_public.event_team_member tm
      JOIN core_public.event_team t ON t.event_team_id = tm.event_team_id
      JOIN core_public.event e ON e.event_id = tm.event_id
      LEFT JOIN agg a ON a.event_id = tm.event_id
     WHERE tm.streamer_id = ${streamerId}::uuid
       AND (${year ?? null}::int IS NULL OR EXTRACT(YEAR FROM e.starts_at) = ${year ?? null}::int)
     ORDER BY e.starts_at DESC
  `;
}

/** 이 스트리머의 기록이 있는 연도들 (필터 UI 용). 최신순. */
export async function listStreamerYears(streamerId: string): Promise<number[]> {
  const sql = db();
  const rows = await sql<{ y: number }[]>`
    SELECT DISTINCT EXTRACT(YEAR FROM game_creation)::int AS y
      FROM core_public.streamer_encounter
     WHERE streamer_a_id = ${streamerId}::uuid OR streamer_b_id = ${streamerId}::uuid
     ORDER BY y DESC
  `;
  return rows.map((r) => r.y);
}


export interface OpponentGame {
  other_id: string;
  match_id: string;
  series_key: string;
  series_game_no: number | null;
  relation: "opponent" | "ally";
  source: string;
  event_name: string | null;
  played_at: Date;
  me_win: boolean;
  is_lane_matchup: boolean;
}

/**
 * 상대 전적 카드를 펼쳤을 때 보여줄 경기 목록. **세트 한 판이 한 줄**이다.
 *
 * 매치 단위 목록은 화면에서 series_key 로 접어 만든다 — 여기서 미리 접어 버리면
 * '세트로 보기' 탭에서 다시 펼칠 수가 없다. 한 번 가져와 두 가지로 보여준다.
 *
 * 승률 숫자만으로는 "언제 붙은 건데?" 를 답할 수 없다. 2020년 한 판과
 * 2026년 열 판이 같은 줄에 뭉쳐 있으면 뜻이 흐려진다.
 */
export async function listOpponentGames(
  streamerId: string,
  year?: number,
  /**
   * 경기 분류 필터 (`solo` · `scrim` · `tournament` …). 'all' 이거나 없으면 전부.
   * 분류 규칙은 core 의 matchCategory() 하나이고, 여기서는 이미 계산돼 저장된
   * `category` 컬럼만 본다 — 질의마다 다시 판정하면 규칙이 두 벌이 된다.
   */
  category?: MatchCategoryFilter,
): Promise<OpponentGame[]> {
  const sql = db();
  return sql<OpponentGame[]>`
    SELECT CASE WHEN se.streamer_a_id = ${streamerId}::uuid THEN se.streamer_b_id
                ELSE se.streamer_a_id END                       AS other_id,
           se.match_id, se.series_key, se.series_game_no,
           se.relation, se.source, se.category, se.is_lane_matchup,
           se.game_creation                                     AS played_at,
           CASE WHEN se.streamer_a_id = ${streamerId}::uuid THEN se.a_win
                ELSE se.b_win END                               AS me_win,
           ev.name                                              AS event_name
      FROM core_public.streamer_encounter se
      JOIN core_public.match m ON m.match_id = se.match_id
      LEFT JOIN core_public.event ev ON ev.event_id = m.event_id
     WHERE (se.streamer_a_id = ${streamerId}::uuid OR se.streamer_b_id = ${streamerId}::uuid)
       AND (${year ?? null}::int IS NULL
            OR EXTRACT(YEAR FROM se.game_creation) = ${year ?? null}::int)
       AND (${expandCategory(category)}::text[] IS NULL
            OR se.category = ANY(${expandCategory(category)}::text[]))
     ORDER BY se.game_creation DESC, se.series_game_no DESC
  `;
}


export interface PlacementTally {
  key: string;
  label: string;
  count: number;
}

/** 순위 요약 한 덩어리. 화면 쪽에서 프로퍼티로 받으려면 이름이 있어야 한다. */
export interface PlacementSummary {
  buckets: PlacementTally[];
  unknown: number;
  total: number;
}

/**
 * 순위별 횟수. 프로필 맨 위 요약 카드에 쓴다.
 *
 * 순위를 모르는 대회는 세지 않고 `unknown` 으로 따로 돌려준다 —
 * 합계에 슬쩍 섞으면 "우승 2회" 옆의 숫자들이 무슨 뜻인지 알 수 없게 된다.
 */
export async function summarizePlacements(
  streamerId: string,
  year?: number,
): Promise<PlacementSummary> {
  const sql = db();
  const rows = await sql<{ placement_rank: number | null }[]>`
    SELECT t.placement_rank
      FROM core_public.event_team_member tm
      JOIN core_public.event_team t ON t.event_team_id = tm.event_team_id
      JOIN core_public.event e ON e.event_id = tm.event_id
     WHERE tm.streamer_id = ${streamerId}::uuid
       AND (${year ?? null}::int IS NULL OR EXTRACT(YEAR FROM e.starts_at) = ${year ?? null}::int)
  `;
  const buckets = PLACEMENT_BUCKETS.map((b) => ({
    key: b.key as string,
    label: b.label as string,
    count: rows.filter((r) => r.placement_rank != null && b.match(r.placement_rank)).length,
  }));
  return {
    buckets,
    unknown: rows.filter((r) => placementBucket(r.placement_rank) === null).length,
    total: rows.length,
  };
}

// ── 홈 ───────────────────────────────────────────────────────────────

export interface RecentEncounter {
  match_id: string;
  a_slug: string; a_name: string; a_win: boolean;
  b_slug: string; b_name: string; b_win: boolean;
  relation: "opponent" | "ally";
  is_lane_matchup: boolean;
  queue_id: number;
  game_creation: Date;
}

/** 홈의 훅. "누가 누구를 만났나" 가 이 사이트의 첫 화면이어야 한다. */
export async function listRecentEncounters(limit = 10): Promise<RecentEncounter[]> {
  const sql = db();
  return sql<RecentEncounter[]>`
    SELECT e.match_id, e.relation, e.is_lane_matchup, e.queue_id, e.game_creation,
           a.slug AS a_slug, a.display_name AS a_name, e.a_win,
           b.slug AS b_slug, b.display_name AS b_name, e.b_win
      FROM core_public.streamer_encounter e
      JOIN core_public.streamer a ON a.streamer_id = e.streamer_a_id
      JOIN core_public.streamer b ON b.streamer_id = e.streamer_b_id
     -- ★ 첫 화면도 "공개 큐만" 이라고 써 둔다(§11-7). 내전 한 판을 넣는 순간
     --   최신순 첫 화면이 통째로 내전으로 덮인다 — 수기 기록은 한 방송에서
     --   5~10건이 한꺼번에 들어오기 때문이다.
     WHERE e.source = 'public_queue'
     ORDER BY e.game_creation DESC
     LIMIT ${limit}
  `;
}

export async function countPublic(): Promise<{ streamers: number; matches: number; encounters: number }> {
  const sql = db();
  const rows = await sql<{ streamers: number; matches: number; encounters: number }[]>`
    SELECT (SELECT count(*)::int FROM core_public.streamer)           AS streamers,
           (SELECT count(*)::int FROM core_public.match)              AS matches,
           (SELECT count(*)::int FROM core_public.streamer_encounter) AS encounters
  `;
  return rows[0];
}

// ── 상대전적 ─────────────────────────────────────────────────────────

export interface VersusGame {
  match_id: string;
  /** 같은 다전제에 속한 세트를 묶는 키. 단판이면 match_id 와 같다. */
  series_key: string;
  /** 다전제 안에서 몇 번째 세트인가. 단판이면 null. */
  series_game_no: number | null;
  source: string;
  game_creation: Date;
  game_duration: number | null;
  queue_id: number;
  relation: "opponent" | "ally";
  is_lane_matchup: boolean;
  a_win: boolean;
  b_win: boolean;
  a_position: string | null;
  b_position: string | null;
  a_champion_id: number | null;
  b_champion_id: number | null;
  a_kills: number | null; a_deaths: number | null; a_assists: number | null;
  a_cs: number | null; a_gold: number | null;
  b_kills: number | null; b_deaths: number | null; b_assists: number | null;
  b_cs: number | null; b_gold: number | null;
}

/**
 * 두 스트리머 사이의 모든 조우. **쌍 정규화(a < b)는 여기서 흡수한다** —
 * 화면은 "내가 x, 상대가 y" 로만 생각하면 된다.
 *
 * `flip` 이 true 면 저장된 a/b 가 요청한 x/y 와 반대라는 뜻이다.
 */
export async function getVersus(xId: string, yId: string): Promise<{ flip: boolean; games: VersusGame[] }> {
  const sql = db();
  const [a, b] = [xId, yId].sort();
  const flip = a !== xId;
  const games = await sql<VersusGame[]>`
    SELECT match_id, series_key, series_game_no, source,
           game_creation, game_duration, queue_id, relation, is_lane_matchup,
           a_win, b_win, a_position, b_position, a_champion_id, b_champion_id,
           a_kills, a_deaths, a_assists, a_cs, a_gold,
           b_kills, b_deaths, b_assists, b_cs, b_gold
      FROM core_public.streamer_encounter
     WHERE streamer_a_id = ${a}::uuid AND streamer_b_id = ${b}::uuid
     ORDER BY game_creation DESC, series_game_no DESC
  `;
  return { flip, games };
}
