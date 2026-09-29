/**
 * 공개 대회 **사실** 조회. 공개 범위와 LoL 격리는 core_public 뷰가 맡는다.
 *
 * ★ 여기는 행을 그대로 돌려준다. 대회 분류(멸망전/이벤트)·날짜 표시·시리즈 점수 같은
 *   **해석은 대회 모듈(packages/modules/tournaments)의 것**이다 — core 는 사실과 공개 정책만.
 *   모듈은 계약(core/lib/contract)을 거쳐 이 함수들을 부른다.
 */
import { db } from "./client.ts";

export interface PublicTournamentEventRow {
  event_id: string;
  slug: string;
  name: string;
  kind: string;
  organizer: string | null;
  source_url: string | null;
  starts_at: Date | null;
  ends_at: Date | null;
  first_match: Date | null;
  last_match: Date | null;
  team_count: number;
  series_count: number;
  set_count: number;
  /** placement_rank = 1 인 팀 이름. 순위를 모르면 null. */
  winner: string | null;
  /** 팀 이름과 참가자 표시 이름 — 검색용. */
  search_names: string[];
}

export interface PublicTournamentTeamRow {
  event_team_id: string;
  name: string;
  placement: string | null;
  placement_rank: number | null;
  prize: string | null;
  vote_rank: number | null;
}

export interface PublicTournamentMemberRow {
  event_team_id: string;
  streamer_id: string | null;
  slug: string | null;
  display_name: string;
  profile_image_url: string | null;
  channel_id: string | null;
  position: string | null;
  /** 주최측 발표 팀장이면 true. 모르면 null(0039). */
  is_captain: boolean | null;
  rating_label: string | null;
  rating_points: number | null;
  award: string | null;
}

export interface PublicTournamentLinkRow {
  label: string;
  url: string;
}

export interface PublicTournamentFactRow {
  section: string;
  label: string;
  value: string;
}

export interface PublicTournamentMatchRow {
  match_id: string;
  series_id: string | null;
  series_game_no: number | null;
  game_creation: Date;
  game_creation_precision: "date" | "datetime";
  game_duration: number | null;
  winning_team: number | null;
  blue_team_id: string | null;
  red_team_id: string | null;
  blue_name: string | null;
  red_name: string | null;
  best_of: number | null;
  set_order_known: boolean;
  round_label: string | null;
  source_url: string | null;
}

/** 공개 경기나 참가자가 하나라도 있는 대회(kind='tournament'). 최근 것부터. */
export async function listPublicTournamentEvents(): Promise<PublicTournamentEventRow[]> {
  return db()<PublicTournamentEventRow[]>`
    WITH games AS (
      SELECT event_id, min(game_creation) AS first_match, max(game_creation) AS last_match,
             count(*)::int AS set_count, count(DISTINCT COALESCE(series_id,match_id))::int AS series_count
        FROM core_public.match WHERE event_id IS NOT NULL GROUP BY event_id
    ), teams AS (
      SELECT event_id,count(*)::int AS team_count,
             max(name) FILTER (WHERE placement_rank=1) AS winner,
             array_agg(name) AS names FROM core_public.event_team GROUP BY event_id
    ), people AS (
      SELECT names.event_id,array_agg(DISTINCT names.display_name) AS names FROM (
        SELECT event_id,member_display_name AS display_name FROM core_public.event_team_member
        UNION ALL
        SELECT m.event_id,s.display_name FROM core_public.match_participant mp
          JOIN core_public.match m ON m.match_id=mp.match_id
          JOIN core_public.streamer s ON s.streamer_id=mp.streamer_id
         WHERE m.event_id IS NOT NULL
      ) names GROUP BY names.event_id
    )
    SELECT e.event_id,e.slug,e.name,e.kind,e.organizer,e.source_url,e.starts_at,e.ends_at,
           g.first_match,g.last_match,COALESCE(t.team_count,0)::int AS team_count,
           COALESCE(g.series_count,0)::int AS series_count,COALESCE(g.set_count,0)::int AS set_count,
           t.winner,COALESCE(t.names,ARRAY[]::text[])||COALESCE(p.names,ARRAY[]::text[]) AS search_names
      FROM core_public.event e LEFT JOIN games g ON g.event_id=e.event_id
      LEFT JOIN teams t ON t.event_id=e.event_id LEFT JOIN people p ON p.event_id=e.event_id
     WHERE e.kind = 'tournament' AND (g.event_id IS NOT NULL OR p.event_id IS NOT NULL)
     ORDER BY COALESCE(e.starts_at,g.first_match) DESC NULLS LAST,e.slug
  `;
}

/** 한 대회의 팀·로스터·경기. 로스터 상세(챔피언·KDA)는 계약의 listMatchRosters 로 따로 읽는다. */
export async function getPublicTournamentFacts(eventId: string): Promise<{
  teams: PublicTournamentTeamRow[];
  members: PublicTournamentMemberRow[];
  matches: PublicTournamentMatchRow[];
  links: PublicTournamentLinkRow[];
  facts: PublicTournamentFactRow[];
}> {
  const sql = db();
  const [teams, members, matches, links, facts] = await Promise.all([
    sql<PublicTournamentTeamRow[]>`
      SELECT event_team_id,name,placement,placement_rank,prize,vote_rank FROM core_public.event_team
       WHERE event_id=${eventId}::uuid ORDER BY placement_rank NULLS LAST,name`,
    sql<PublicTournamentMemberRow[]>`
      SELECT tm.event_team_id,tm.streamer_id,s.slug,tm.member_display_name AS display_name,s.profile_image_url,ch.channel_id,tm.position,
         tm.is_captain,tm.rating_label,tm.rating_points::float8 AS rating_points,tm.award
        FROM core_public.event_team_member tm LEFT JOIN core_public.streamer s ON s.streamer_id=tm.streamer_id
        LEFT JOIN LATERAL (SELECT channel_id FROM core_public.streamer_channel WHERE streamer_id=s.streamer_id AND platform='soop' ORDER BY is_primary DESC LIMIT 1) ch ON true
       WHERE tm.event_id=${eventId}::uuid ORDER BY s.display_name`,
    sql<PublicTournamentMatchRow[]>`
      SELECT m.match_id,m.series_id,m.series_game_no,m.game_creation,m.game_creation_precision,m.game_duration,
             m.winning_team,m.blue_team_id,m.red_team_id,b.name AS blue_name,r.name AS red_name,
             m.best_of,m.set_order_known,m.round_label,m.source_url
        FROM core_public.tournament_match m
        LEFT JOIN core_public.event_team b ON b.event_team_id=m.blue_team_id
        LEFT JOIN core_public.event_team r ON r.event_team_id=m.red_team_id
       WHERE m.event_id=${eventId}::uuid ORDER BY m.game_creation,m.series_id,m.series_game_no,m.match_id`,
    sql<PublicTournamentLinkRow[]>`
      SELECT label,url FROM core_public.event_link WHERE event_id=${eventId}::uuid ORDER BY sort,label`,
    sql<PublicTournamentFactRow[]>`
      SELECT section,label,value FROM core_public.event_fact WHERE event_id=${eventId}::uuid ORDER BY sort,section,label`,
  ]);
  return { teams, members, matches, links, facts };
}
