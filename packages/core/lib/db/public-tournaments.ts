/**
 * 공개 대회 **사실** 조회. 공개 범위와 LoL 격리는 core_public 뷰가 맡는다.
 *
 * ★ 여기는 행을 그대로 돌려준다. 대회 분류(멸망전/이벤트)·날짜 표시·시리즈 점수 같은
 *   **해석은 대회 모듈(packages/modules/tournaments)의 것**이다 — core 는 사실과 공개 정책만.
 *   모듈은 계약(core/lib/contract)을 거쳐 이 함수들을 부른다.
 * ★ 대회 = 진행 방식(event.format) 'tournament' 인 롤 행사. 경기는 행사 상세의 "한 경기 보기" 경로인
 *   core_public.match_detail(시리즈 경유 한 길, 보너스 포함)에서 읽는다. 옛 tournament_match·match 뷰는 없다.
 */
import type { Format } from "../metrics/format.ts";
import { db } from "./client.ts";

export interface PublicTournamentEventRow {
  event_id: string;
  slug: string;
  name: string;
  format: Format;
  organizer: string | null;
  source_url: string | null;
  starts_at: Date | null;
  ends_at: Date | null;
  effective_starts_at: Date | null;
  effective_ends_at: Date | null;
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
  streamer_id: string;
  slug: string;
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

/** 스트리머로 연결되지 않은 로스터 자리의 출처 표기 이름(0068). 표시 전용 — 사람이 아니다. */
export interface PublicTournamentListedNameRow {
  event_team_id: string;
  position: "TOP" | "JUNGLE" | "MIDDLE" | "BOTTOM" | "UTILITY";
  name: string;
  source_url: string;
}
export interface PublicTournamentFactRow {
  section: string;
  label: string;
  value: string;
}

export interface PublicTournamentMatchRow {
  match_id: string;
  series_id: string;
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
  /** 확인 전(회원 제보, 0093) — 화면에 보이고 점수·선수 기록에는 안 들어간다(contract 의 counted). */
  pending: boolean;
}

/** 공개 경기나 참가자가 하나라도 있는 **롤** 대회(format='tournament'). 최근 것부터. */
export async function listPublicTournamentEvents(): Promise<PublicTournamentEventRow[]> {
  return db()<PublicTournamentEventRow[]>`
    WITH games AS (
      -- 본게임만 센다 — 보너스 판은 목록 숫자에 들어가지 않는다(펼친 경기 보기에만).
      SELECT event_id, min(played_at) AS first_match, max(played_at) AS last_match,
             count(DISTINCT match_id)::int AS set_count, count(DISTINCT series_id)::int AS series_count
        FROM core_public.match_detail WHERE format = 'tournament' AND set_role = 'main' AND NOT pending GROUP BY event_id
    ), teams AS (
      SELECT event_id,count(*)::int AS team_count,
             max(name) FILTER (WHERE placement_rank=1) AS winner,
             array_agg(name) AS names FROM core_public.event_team GROUP BY event_id
    ), people AS (
      SELECT ids.event_id,array_agg(DISTINCT s.display_name) AS names
        FROM (
          SELECT event_id,streamer_id FROM core_public.event_team_member
          UNION
          SELECT event_id,streamer_id FROM core_public.lol_versus_set WHERE format = 'tournament'
        ) ids JOIN core_public.streamer s ON s.streamer_id=ids.streamer_id GROUP BY ids.event_id
    )
    SELECT e.event_id,e.slug,e.name,e.format,e.organizer,e.source_url,e.starts_at,e.ends_at,e.effective_starts_at,e.effective_ends_at,
           g.first_match,g.last_match,COALESCE(t.team_count,0)::int AS team_count,
           COALESCE(g.series_count,0)::int AS series_count,COALESCE(g.set_count,0)::int AS set_count,
           t.winner,COALESCE(t.names,ARRAY[]::text[])||COALESCE(p.names,ARRAY[]::text[]) AS search_names
      FROM core_public.event_dates e LEFT JOIN games g ON g.event_id=e.event_id
      LEFT JOIN teams t ON t.event_id=e.event_id LEFT JOIN people p ON p.event_id=e.event_id
     -- ★ 롤 대회만. FC 대회도 참가 단위를 가진다(0061·0062) — 게임을 안 걸면 FC 대회가 섞인다.
     WHERE e.game_code = 'lol' AND e.format = 'tournament' AND (g.event_id IS NOT NULL OR p.event_id IS NOT NULL)
     ORDER BY e.effective_starts_at DESC NULLS LAST,e.slug
  `;
}

/** 한 대회의 팀·로스터·경기. 로스터 상세(챔피언·KDA)는 계약의 listMatchRosters 로 따로 읽는다. */
export async function getPublicTournamentFacts(eventId: string): Promise<{
  teams: PublicTournamentTeamRow[];
  members: PublicTournamentMemberRow[];
  matches: PublicTournamentMatchRow[];
  links: PublicTournamentLinkRow[];
  facts: PublicTournamentFactRow[];
  listed: PublicTournamentListedNameRow[];
}> {
  const sql = db();
  const [teams, members, matches, links, facts, listed] = await Promise.all([
    sql<PublicTournamentTeamRow[]>`
      SELECT event_team_id,name,placement,placement_rank,prize,vote_rank FROM core_public.event_team
       WHERE event_id=${eventId}::uuid ORDER BY placement_rank NULLS LAST,name`,
    sql<PublicTournamentMemberRow[]>`
      SELECT tm.event_team_id,s.streamer_id,s.slug,s.display_name,s.profile_image_url,ch.channel_id,tm.position,
             tm.is_captain,tm.rating_label,tm.rating_points::float8 AS rating_points,tm.award
        FROM core_public.event_team_member tm JOIN core_public.streamer s ON s.streamer_id=tm.streamer_id
        LEFT JOIN LATERAL (SELECT channel_id FROM core_public.streamer_channel WHERE streamer_id=s.streamer_id AND platform='soop' ORDER BY is_primary DESC LIMIT 1) ch ON true
       WHERE tm.event_id=${eventId}::uuid ORDER BY s.display_name`,
    // ★ match_detail 은 참가자 한 줄씩이라 경기 칸만 DISTINCT 로 접는다. 대회 화면은 본게임만 그린다.
    // ⚠ best_of·set_order_known·round_label(시리즈 칸)은 match_detail 에 있어야 한다 — 본 세션 요청(보고서).
    sql<PublicTournamentMatchRow[]>`
      SELECT DISTINCT m.match_id,m.series_id,m.series_game_no,m.played_at AS game_creation,m.game_creation_precision,m.game_duration,
             m.winning_team,m.blue_team_id,m.red_team_id,b.name AS blue_name,r.name AS red_name,
             m.best_of,m.set_order_known,m.round_label,m.source_url,m.pending
        FROM core_public.match_detail m
        LEFT JOIN core_public.event_team b ON b.event_team_id=m.blue_team_id
        LEFT JOIN core_public.event_team r ON r.event_team_id=m.red_team_id
       WHERE m.event_id=${eventId}::uuid AND m.set_role='main'
       ORDER BY game_creation,m.series_id,m.series_game_no,m.match_id`,
    sql<PublicTournamentLinkRow[]>`
      SELECT label,url FROM core_public.event_link WHERE event_id=${eventId}::uuid ORDER BY sort,label`,
    sql<PublicTournamentFactRow[]>`
      SELECT section,label,value FROM core_public.event_fact WHERE event_id=${eventId}::uuid ORDER BY sort,section,label`,
    sql<PublicTournamentListedNameRow[]>`
      SELECT event_team_id,position,name,source_url FROM core_public.event_team_listed_name WHERE event_id=${eventId}::uuid`,
  ]);
  return { teams, members, matches, links, facts, listed };
}
