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
import type { MatchOutcome } from "./types.ts";
import { expandCategory, type MatchCategoryFilter } from "../metrics/category.ts";
import { PLACEMENT_BUCKETS, placementBucket } from "../metrics/placement.ts";

// ── 목록 ─────────────────────────────────────────────────────────────

export interface StreamerCard {
  profile_image_url: string | null;
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
  /** 대표 게임 계정(본계 우선)의 인게임 이름. 붙인 계정이 없으면 null. */
  account_name: string | null;
  account_tag: string | null;
  /** 붙어 있는 계정 수. 2 이상이면 화면에 `외 N` 을 붙인다. */
  account_count: number;
  /** 대회 우승 횟수(팀 순위 1위). 순위를 모르는 대회는 세지 않는다. */
  titles: number;
}

export async function listStreamerCards(opts: { q?: string } = {}): Promise<StreamerCard[]> {
  const sql = db();
  const q = opts.q?.trim();
  // ★ 화면이 쓰는 칸만 읽는다. 예전엔 경기 수·조우 수도 사람마다 셌는데 목록 화면은 둘 다 쓰지 않았다(카드 시절의 흔적).
  //   게다가 core_public.match_participant 의 streamer_id 는 COALESCE 계산값이라 인덱스를 못 탄다 — 한 명 세는 데 9.6초,
  //   공개 큐 1.6만 경기가 처음 들어온 날(2026-10-02) 820명분이 문장 시간 제한에 걸려 목록이 500 이었다.
  return sql<StreamerCard[]>`
    SELECT s.streamer_id, s.slug, s.display_name, s.aliases, s.is_pro, s.team_name, s.profile_image_url,
           ch.channel_id, ch.channel_url, ch.platform,
           r.tier, r.division, r.league_points, r.lp_absolute,
           acc.game_name AS account_name, acc.tag_line AS account_tag,
           coalesce(acc.total, 0)::int AS account_count,
           coalesce(tt.n, 0)::int AS titles
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
      -- ★ 순위를 **모르는** 대회는 세지 않는다. 우승 옆의 숫자가 무슨 뜻인지 흐려진다.
      LEFT JOIN LATERAL (
             SELECT count(*) AS n
               FROM core_public.event_team_member tm
               JOIN core_public.event_team t ON t.event_team_id = tm.event_team_id
               JOIN core_public.event e ON e.event_id = tm.event_id AND e.game_code = 'lol'
              WHERE tm.streamer_id = s.streamer_id AND t.placement_rank = 1
           ) tt ON true
      -- 대표 계정은 **본계 우선**이다. 부계정이 대표로 뜨면 같은 사람을 못 알아본다.
      LEFT JOIN LATERAL (
             SELECT a.game_name, a.tag_line,
                    (SELECT count(*) FROM core_public.streamer_account
                      WHERE streamer_id = s.streamer_id) AS total
               FROM core_public.streamer_account a
              WHERE a.streamer_id = s.streamer_id
              ORDER BY a.is_main DESC, a.game_name LIMIT 1
           ) acc ON true
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
  /**
   * ★ KDA 평균의 분모. `games` 가 아니다 — 방송에서 승패만 읽은 판은 KDA 가 NULL 이고
   *   합에서 빠지므로, `games` 로 나누면 평균이 묽어진다(0020 ⑧). 0 이면 평균을 내지 않는다.
   */
  kda_games: number;
  cs: number;
  seconds_played: number;
}

/** 한 챔피언으로 맞라인에서 만난 상대 챔피언 한 줄. */
export interface ChampionMatchup {
  champion_id: number;
  champion_name: string | null;
  games: number;
  wins: number;
  kills: number;
  deaths: number;
  assists: number;
  kda_games: number;
}

export interface ChampionRecord extends ChampionRow {
  /** 맞라인 상대 챔피언별 전적. 경기 많은 순. */
  matchups: ChampionMatchup[];
}

export interface ChampionScope {
  category?: MatchCategoryFilter;
  /** KST 달력 날짜(`YYYY-MM-DD`). 경기 하나 단위로 자른다. */
  from?: string;
  to?: string;
}

/**
 * 챔피언 탭이 쓰는 집계. **`champion_stat` 이 아니라 원본 참가 기록에서 센다.**
 *
 * ★ 왜 파생 테이블을 안 쓰나
 *   `champion_stat` 은 (스트리머 × 챔피언 × 큐 × 시즌) 으로 이미 접힌 표라
 *   **기간으로 자를 수가 없다.** 날짜 필터를 붙이려면 경기 단위로 되돌아가야 한다.
 *   프로필 카드의 '통산 모스트' 는 기간 개념이 없으므로 그대로 `listChampions` 를 쓴다.
 *
 * ★ 맞라인 = 같은 경기 · 다른 팀 · **같은 포지션**
 *   `core_public.match_participant` 는 `individual_position` 을 내보내지 않으므로
 *   여기서는 `team_position` 만 본다. 포지션이 비어 있으면(판독 실패) 아무것도 세지 않는다
 *   — 틀린 맞라인 전적은 없느니만 못하다(CLAUDE.md 원칙 10).
 *
 * ⚠ 한 포지션에 상대가 둘로 읽힌 경기(방송 판독 실패)는 두 줄로 각각 세어진다.
 *   그래서 맞라인 줄의 경기 수 합이 그 챔피언의 경기 수보다 클 수 있다.
 */
export async function listChampionRecords(
  streamerId: string,
  limit = 20,
  { category, from, to }: ChampionScope = {},
): Promise<ChampionRecord[]> {
  const sql = db();
  const cats = expandCategory(category);
  return sql<ChampionRecord[]>`
    WITH mine AS (
      SELECT mp.match_id, mp.team_id, mp.team_position, mp.champion_id, mp.champion_name,
             mp.outcome, mp.kills, mp.deaths, mp.assists, mp.cs, m.game_duration,
             -- ★ 분자와 분모가 같은 판을 센다. 셋을 다 읽은 판만 평균에 넣는다(0020 ⑧).
             (mp.kills IS NOT NULL AND mp.deaths IS NOT NULL AND mp.assists IS NOT NULL) AS kda_read
        -- 사람으로 찾을 땐 streamer_match 에서 출발한다 — 참가자 뷰의 streamer_id 는 계산값이라 직접 거르면 표 전체를 훑는다(0075).
        FROM core_public.streamer_match sm
        JOIN core_public.match_participant mp ON mp.match_id = sm.match_id AND mp.participant_id = sm.participant_id
        JOIN core_public.match m ON m.match_id = mp.match_id
       WHERE sm.streamer_id = ${streamerId}::uuid
         AND (${cats}::text[] IS NULL OR m.category = ANY(${cats}::text[]))
         AND (${from ?? null}::date IS NULL
              OR (m.game_creation AT TIME ZONE 'Asia/Seoul')::date >= ${from ?? null}::date)
         AND (${to ?? null}::date IS NULL
              OR (m.game_creation AT TIME ZONE 'Asia/Seoul')::date <= ${to ?? null}::date)
    ),
    totals AS (
      SELECT champion_id,
             min(champion_name) FILTER (WHERE champion_name IS NOT NULL) AS champion_name,
             count(*)::int AS games,
             count(*) FILTER (WHERE outcome = 'win')::int AS wins,
             coalesce(sum(kills)   FILTER (WHERE kda_read), 0)::int AS kills,
             coalesce(sum(deaths)  FILTER (WHERE kda_read), 0)::int AS deaths,
             coalesce(sum(assists) FILTER (WHERE kda_read), 0)::int AS assists,
             count(*) FILTER (WHERE kda_read)::int AS kda_games,
             coalesce(sum(cs), 0)::bigint AS cs,
             coalesce(sum(game_duration), 0)::bigint AS seconds_played
        FROM mine
       GROUP BY champion_id
       ORDER BY count(*) DESC, champion_id
       LIMIT ${limit}
    ),
    matchups AS (
      SELECT me.champion_id AS mine_id, foe.champion_id AS foe_id,
             min(foe.champion_name) FILTER (WHERE foe.champion_name IS NOT NULL) AS foe_name,
             count(*)::int AS games,
             count(*) FILTER (WHERE me.outcome = 'win')::int AS wins,
             coalesce(sum(me.kills)   FILTER (WHERE me.kda_read), 0)::int AS kills,
             coalesce(sum(me.deaths)  FILTER (WHERE me.kda_read), 0)::int AS deaths,
             coalesce(sum(me.assists) FILTER (WHERE me.kda_read), 0)::int AS assists,
             count(*) FILTER (WHERE me.kda_read)::int AS kda_games
        FROM mine me
        JOIN core_public.match_participant foe
          ON foe.match_id = me.match_id
         AND foe.team_id <> me.team_id
         AND foe.team_position = me.team_position
       WHERE me.team_position IS NOT NULL AND me.team_position <> ''
       GROUP BY me.champion_id, foe.champion_id
    )
    SELECT t.champion_id, t.champion_name, t.games, t.wins, t.kills, t.deaths, t.assists,
           t.kda_games, t.cs, t.seconds_played,
           coalesce(json_agg(json_build_object(
             'champion_id', mu.foe_id, 'champion_name', mu.foe_name,
             'games', mu.games, 'wins', mu.wins,
             'kills', mu.kills, 'deaths', mu.deaths, 'assists', mu.assists,
             'kda_games', mu.kda_games
           ) ORDER BY mu.games DESC, mu.foe_id) FILTER (WHERE mu.foe_id IS NOT NULL), '[]') AS matchups
      FROM totals t
      LEFT JOIN matchups mu ON mu.mine_id = t.champion_id
     GROUP BY t.champion_id, t.champion_name, t.games, t.wins, t.kills, t.deaths,
              t.assists, t.kda_games, t.cs, t.seconds_played
     ORDER BY t.games DESC, t.champion_id
  `;
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
  channel_id?: string | null;
  profile_image_url?: string | null;
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
           sum(cs.kda_games)::int AS kda_games,
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
  opts: { limit?: number; year?: number; category?: MatchCategoryFilter } = {},
): Promise<OpponentRow[]> {
  const { limit = 300, year, category } = opts;
  const sql = db();
  return sql<OpponentRow[]>`
    WITH e AS (
      SELECT CASE WHEN streamer_a_id = ${streamerId}::uuid THEN streamer_b_id ELSE streamer_a_id END AS other_id,
             CASE WHEN streamer_a_id = ${streamerId}::uuid THEN a_outcome ELSE b_outcome END = 'win' AS me_win,
             relation, is_lane_matchup, game_creation,
             -- ★ 매치 단위. 랜드는 묶음이 아니라 판마다 매치 하나다(match-tally.ts 와 같은 규칙, 0080).
             CASE WHEN category = 'land' THEN match_id ELSE series_key END AS series_key
        FROM core_public.streamer_encounter
       WHERE (streamer_a_id = ${streamerId}::uuid OR streamer_b_id = ${streamerId}::uuid)
         AND (${year ?? null}::int IS NULL OR EXTRACT(YEAR FROM game_creation AT TIME ZONE 'Asia/Seoul') = ${year ?? null}::int)
         AND (${expandCategory(category)}::text[] IS NULL OR category = ANY(${expandCategory(category)}::text[]))
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
    SELECT s.streamer_id, s.slug, s.display_name, s.profile_image_url,
           (SELECT channel_id FROM core_public.streamer_channel c WHERE c.streamer_id = s.streamer_id
             AND c.platform = 'soop' ORDER BY is_primary DESC LIMIT 1) AS channel_id,
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
  /** false 면 올스타전·이벤트 매치 — 우승 집계에서 뺀다(0052). 목록에는 그대로 나온다. */
  counts_toward_titles: boolean;
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
             mp.outcome
        FROM core_public.streamer_match sm
        JOIN core_public.match_participant mp ON mp.match_id = sm.match_id AND mp.participant_id = sm.participant_id
        JOIN core_public.match m ON m.match_id = mp.match_id
       WHERE sm.streamer_id = ${streamerId}::uuid AND m.source = 'manual'
    ),
    per_series AS (
      SELECT event_id, series_key,
             count(*)::int                                 AS sets,
             count(*) FILTER (WHERE outcome = 'win')::int  AS set_wins
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
           t.name AS team_name, tm.position, t.placement, t.placement_rank, e.counts_toward_titles,
           COALESCE(a.matches, 0)     AS matches,
           COALESCE(a.match_wins, 0)  AS match_wins,
           COALESCE(a.match_draws, 0) AS match_draws,
           COALESCE(a.sets, 0)       AS sets,
           COALESCE(a.set_wins, 0)   AS set_wins
      FROM core_public.event_team_member tm
      JOIN core_public.event_team t ON t.event_team_id = tm.event_team_id
      JOIN core_public.event e ON e.event_id = tm.event_id
      LEFT JOIN agg a ON a.event_id = tm.event_id
     -- ★ 롤 프로필의 대회 이력이다. FC 대회 참가 단위가 섞이지 않게 게임을 건다(0062).
     WHERE tm.streamer_id = ${streamerId}::uuid AND e.game_code = 'lol'
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
  best_of: number | null;
  relation: "opponent" | "ally";
  source: string;
  event_name: string | null;
  played_at: Date;
  me_outcome: MatchOutcome;
  is_lane_matchup: boolean;
  /** 경기 분류. 랜드는 묶음이 아니라 판 단위로 센다(match-tally). */
  category?: string | null;
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
   * 경기 분류 필터 (`solo` · `ck` · `tournament` …). 'all' 이거나 없으면 전부.
   * 분류 규칙은 core 의 matchCategory() 하나이고, 여기서는 이미 계산돼 저장된
   * `category` 컬럼만 본다 — 질의마다 다시 판정하면 규칙이 두 벌이 된다.
   */
  category?: MatchCategoryFilter,
): Promise<OpponentGame[]> {
  const sql = db();
  return sql<OpponentGame[]>`
    SELECT CASE WHEN se.streamer_a_id = ${streamerId}::uuid THEN se.streamer_b_id
                ELSE se.streamer_a_id END                       AS other_id,
           se.match_id, se.series_key, se.series_game_no, se.best_of,
           se.relation, se.source, se.category, se.is_lane_matchup,
           se.game_creation                                     AS played_at,
           CASE WHEN se.streamer_a_id = ${streamerId}::uuid THEN se.a_outcome
                ELSE se.b_outcome END                           AS me_outcome,
           ev.name                                              AS event_name
      FROM core_public.streamer_encounter se
      JOIN core_public.match m ON m.match_id = se.match_id
      LEFT JOIN core_public.event ev ON ev.event_id = m.event_id
     WHERE (se.streamer_a_id = ${streamerId}::uuid OR se.streamer_b_id = ${streamerId}::uuid)
       AND (${year ?? null}::int IS NULL OR EXTRACT(YEAR FROM se.game_creation AT TIME ZONE 'Asia/Seoul') = ${year ?? null}::int)
       AND (${expandCategory(category)}::text[] IS NULL OR se.category = ANY(${expandCategory(category)}::text[]))
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
  /** 정규 대회만(올스타전·이벤트 매치 제외, 0052). */
  buckets: PlacementTally[];
  unknown: number;
  /** 참가 대회 수 — 올스타전·이벤트 매치 포함(참가는 참가다). */
  total: number;
  /** 올스타전·이벤트 매치의 우승·준우승. 우승 숫자에 섞지 않고 따로 보여 준다. */
  exhibition: { champion: number; runnerup: number };
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
  const rows = await sql<{ placement_rank: number | null; counts_toward_titles: boolean }[]>`
    SELECT t.placement_rank, e.counts_toward_titles
      FROM core_public.event_team_member tm
      JOIN core_public.event_team t ON t.event_team_id = tm.event_team_id
      JOIN core_public.event e ON e.event_id = tm.event_id
     WHERE tm.streamer_id = ${streamerId}::uuid AND e.game_code = 'lol'
       AND (${year ?? null}::int IS NULL OR EXTRACT(YEAR FROM e.starts_at) = ${year ?? null}::int)
  `;
  // ★ 올스타전·이벤트 매치는 우승 숫자에서 뺀다(0052, 사용자 결정 2026-10-01). 참가 수(total)에는 넣는다.
  const titled = rows.filter((r) => r.counts_toward_titles);
  const exhibit = rows.filter((r) => !r.counts_toward_titles);
  const buckets = PLACEMENT_BUCKETS.map((b) => ({
    key: b.key as string,
    label: b.label as string,
    count: titled.filter((r) => r.placement_rank != null && b.match(r.placement_rank)).length,
  }));
  return {
    buckets,
    unknown: titled.filter((r) => placementBucket(r.placement_rank) === null).length,
    total: rows.length,
    exhibition: {
      champion: exhibit.filter((r) => r.placement_rank === 1).length,
      runnerup: exhibit.filter((r) => r.placement_rank === 2).length,
    },
  };
}

// ── 홈 ───────────────────────────────────────────────────────────────

export async function countPublic(): Promise<{ streamers: number; matches: number; encounters: number }> {
  const sql = db();
  const rows = await sql<{ streamers: number; matches: number; encounters: number }[]>`
    SELECT (SELECT count(*)::int FROM core_public.streamer)           AS streamers,
           (SELECT count(*)::int FROM core_public.match)              AS matches,
           (SELECT count(*)::int FROM core_public.streamer_encounter) AS encounters
  `;
  return rows[0];
}
