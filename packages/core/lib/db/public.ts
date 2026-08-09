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

export interface RankPoint {
  snapshot_date: string;
  lp_absolute: number | null;
  tier: string | null;
  division: string | null;
  league_points: number | null;
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
  champion_id: number;
  champion_name: string | null;
  team_position: string | null;
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
  cs: number | null;
}

export interface RivalRow {
  streamer_id: string;
  slug: string;
  display_name: string;
  vs_games: number;
  vs_wins: number;
  ally_games: number;
  ally_wins: number;
  lane_games: number;
  lane_wins: number;
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

/** 티어 추이. 계정이 여러 개면 날짜별로 가장 높은 계정을 쓴다. */
export async function getRankSeries(streamerId: string): Promise<RankPoint[]> {
  const sql = db();
  return sql<RankPoint[]>`
    SELECT DISTINCT ON (snapshot_date)
           snapshot_date::text AS snapshot_date, lp_absolute, tier, division, league_points
      FROM core_public.rank_snapshot
     WHERE streamer_id = ${streamerId}::uuid AND queue_type = 'RANKED_SOLO_5x5'
       AND lp_absolute IS NOT NULL
     ORDER BY snapshot_date, lp_absolute DESC
  `;
}

export async function listChampions(streamerId: string, limit = 8): Promise<ChampionRow[]> {
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
     GROUP BY cs.champion_id
     ORDER BY sum(cs.games) DESC
     LIMIT ${limit}
  `;
}

export async function listRecentGames(streamerId: string, limit = 20): Promise<RecentGame[]> {
  const sql = db();
  return sql<RecentGame[]>`
    SELECT mp.match_id, m.game_creation, m.game_duration, m.queue_id,
           mp.champion_id, mp.champion_name, mp.team_position, mp.win,
           mp.kills, mp.deaths, mp.assists, mp.cs
      FROM core_public.match_participant mp
      JOIN core_public.match m ON m.match_id = mp.match_id
     WHERE mp.streamer_id = ${streamerId}::uuid
     ORDER BY m.game_creation DESC
     LIMIT ${limit}
  `;
}

/**
 * 라이벌 — 이 프로필의 훅이다.
 *
 * 상대편으로 만난 것과 같은 팀으로 만난 것을 **섞지 않는다.**
 * 같은 팀 승리를 상대전적에 넣으면 "이겼다"의 뜻이 달라진다.
 */
export async function listRivals(streamerId: string, limit = 20): Promise<RivalRow[]> {
  const sql = db();
  return sql<RivalRow[]>`
    WITH e AS (
      SELECT CASE WHEN streamer_a_id = ${streamerId}::uuid THEN streamer_b_id ELSE streamer_a_id END AS other_id,
             CASE WHEN streamer_a_id = ${streamerId}::uuid THEN a_win ELSE b_win END AS me_win,
             relation, is_lane_matchup, game_creation
        FROM core_public.streamer_encounter
       WHERE streamer_a_id = ${streamerId}::uuid OR streamer_b_id = ${streamerId}::uuid
    )
    SELECT s.streamer_id, s.slug, s.display_name,
           count(*) FILTER (WHERE e.relation = 'opponent')::int                          AS vs_games,
           count(*) FILTER (WHERE e.relation = 'opponent' AND e.me_win)::int             AS vs_wins,
           count(*) FILTER (WHERE e.relation = 'ally')::int                              AS ally_games,
           count(*) FILTER (WHERE e.relation = 'ally' AND e.me_win)::int                 AS ally_wins,
           count(*) FILTER (WHERE e.is_lane_matchup)::int                                AS lane_games,
           count(*) FILTER (WHERE e.is_lane_matchup AND e.me_win)::int                   AS lane_wins,
           max(e.game_creation)                                                          AS last_met
      FROM e
      JOIN core_public.streamer s ON s.streamer_id = e.other_id
     GROUP BY s.streamer_id, s.slug, s.display_name
     ORDER BY count(*) DESC, max(e.game_creation) DESC
     LIMIT ${limit}
  `;
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
    SELECT match_id, game_creation, game_duration, queue_id, relation, is_lane_matchup,
           a_win, b_win, a_position, b_position, a_champion_id, b_champion_id,
           a_kills, a_deaths, a_assists, a_cs, a_gold,
           b_kills, b_deaths, b_assists, b_cs, b_gold
      FROM core_public.streamer_encounter
     WHERE streamer_a_id = ${a}::uuid AND streamer_b_id = ${b}::uuid
     ORDER BY game_creation DESC
  `;
  return { flip, games };
}
