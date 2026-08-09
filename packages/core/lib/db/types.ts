/** db/schema.sql 의 행 타입. 스키마를 고치면 여기도 고친다. */

/**
 * 방송 플랫폼.
 *
 * ⚠️ `RiotClient.platform`(kr/na1 라우팅)과 **이름만 같고 전혀 다른 것**이다.
 *    이쪽은 SOOP·치지직 같은 방송 플랫폼을 뜻한다. docs/ARCHITECTURE.md §식별자.
 */
export type Platform = "soop" | "chzzk" | "youtube" | "twitch" | "other";
export type Visibility = "public" | "hidden";
export type StreamerStatus = "active" | "inactive" | "retired";
export type Confidence = "verified" | "likely" | "unverified";
export type MatchSource = "public_queue" | "tournament_code" | "manual";

export interface StreamerRow {
  id: string;
  slug: string;
  display_name: string;
  aliases: string[];
  profile_image_url: string | null;
  is_pro: boolean;
  team_name: string | null;
  visibility: Visibility;
  status: StreamerStatus;
  note: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * 방송 채널. 스트리머와 1:N 이다 (SOOP + 치지직 동시 송출, 본채널/서브채널, 변경 이력).
 *
 * ★ `channel_id` 는 **플랫폼이 발급한** 아이디다 (SOOP 방송국 아이디 `phonics1` 등).
 *   우리 키가 아니고, 라이엇 계정과도 아무 관계가 없다.
 *   옛 이름 `platform_user_id` 는 우리 것처럼 들려서 바꿨다.
 */
export interface StreamerChannelRow {
  id: string;
  streamer_id: string;
  platform: Platform;
  channel_id: string;
  channel_url: string | null;
  label: string | null;
  is_primary: boolean;
  active_from: string | null;
  active_to: string | null;
}

export interface RiotAccountRow {
  puuid: string;
  game_name: string | null;
  tag_line: string | null;
  platform_region: string;
  routing_region: string;
  summoner_id: string | null;
  summoner_level: number | null;
  profile_icon_id: number | null;
  revision_date: string | null;
  last_profile_synced_at: string | null;
  last_rank_synced_at: string | null;
  last_match_synced_at: string | null;
  is_active: boolean;
}

/**
 * 매핑의 근거. 근거 없는 행은 만들지 않는다 (docs/PLAN.md §11-2).
 * 부계정 오노출은 실제 분쟁이 된다.
 */
export interface AccountEvidence {
  source?:
    | "stream_clip"
    | "broadcast_notice"
    | "self_declared"
    | "community_post"
    | "user_report"
    | "rso"
    | "manual";
  url?: string;
  note?: string;
  reported_by?: string;
}

export interface StreamerAccountRow {
  streamer_id: string;
  puuid: string;
  label: string | null;
  is_main: boolean;
  evidence: AccountEvidence;
  confidence: Confidence;
  visibility: Visibility;
  active_from: string | null;
  active_to: string | null;
  verified_by: string | null;
  verified_at: string | null;
}

/** 관리자 목록에서 쓰는 조인 결과. */
export interface StreamerAccountView extends StreamerAccountRow, Pick<RiotAccountRow,
  "game_name" | "tag_line" | "summoner_level" | "profile_icon_id" | "last_match_synced_at"> {
  tier: string | null;
  division: string | null;
  league_points: number | null;
  lp_absolute: number | null;
}

export interface RankSnapshotRow {
  puuid: string;
  queue_type: string;
  snapshot_date: string;
  tier: string | null;
  division: string | null;
  league_points: number | null;
  wins: number | null;
  losses: number | null;
  hot_streak: boolean | null;
  lp_absolute: number | null;
}

export interface CareerEventRow {
  id: string;
  streamer_id: string;
  event_id: string | null;
  title: string;
  role: string | null;
  team_name: string | null;
  placement: string | null;
  date_from: string | null;
  date_to: string | null;
  source_url: string | null;
  note: string | null;
}
