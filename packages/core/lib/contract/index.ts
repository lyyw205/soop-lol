/**
 * 모듈 계약 — 모듈이 core 에서 쓸 수 있는 **전부**.
 *
 * 모듈은 이 파일만 import 한다. `core/lib/db/*` 를 직접 부르면 안 된다.
 * 이유는 두 가지다:
 *
 *  1. **안전.** core/lib/db 는 raw 테이블을 쓴다. 거기엔 visibility='hidden' 인
 *     부계정과 evidence(제보자 메모)가 그대로 들어 있다. 모듈이 그걸 만지면
 *     삭제 요청 경로가 무의미해진다 (docs/PLAN.md §11-2).
 *     여기 있는 함수는 전부 `core_public` 뷰만 읽으므로 애초에 못 본다.
 *
 *  2. **자유.** core 는 내부 테이블을 언제든 바꿀 수 있어야 한다.
 *     계약이 좁을수록 core 가 움직일 여지가 넓다.
 *
 * 모듈이 필요한 게 여기 없으면 **여기에 추가하는 게 맞다**. 우회하지 않는다.
 */

import { db } from "../db/client.ts";
import type { Position } from "../riot/types.ts";

// 지표 계산은 모듈도 같은 것을 써야 한다 — 두 군데서 계산하면 반드시 어긋난다.
export { affinity, rawWinRate, games, isSmallSample, formatRecord, SMALL_SAMPLE_THRESHOLD } from "../metrics/affinity.ts";
export type { HeadToHead } from "../metrics/affinity.ts";
export { lpAbsolute, lpAbsoluteToRank, formatRank, tierGridLines } from "../metrics/lp.ts";
export { kda, formatKda } from "../metrics/matchup.ts";
export { kstDateString, kstYear } from "../time.ts";
export { QUEUE, QUEUE_LABEL, POSITION_LABEL, SUMMONERS_RIFT_QUEUES } from "../riot/types.ts";
export type { Position } from "../riot/types.ts";

// ── 읽기 모델 ────────────────────────────────────────────────────────

export interface PublicStreamer {
  streamer_id: string;
  slug: string;
  display_name: string;
  aliases: string[];
  profile_image_url: string | null;
  is_pro: boolean;
  team_name: string | null;
  status: string;
}

export interface PublicEncounter {
  match_id: string;
  streamer_a_id: string;
  streamer_b_id: string;
  relation: "opponent" | "ally";
  a_position: Position | null;
  b_position: Position | null;
  is_lane_matchup: boolean;
  a_win: boolean;
  b_win: boolean;
  a_champion_id: number | null;
  b_champion_id: number | null;
  a_kills: number | null; a_deaths: number | null; a_assists: number | null;
  b_kills: number | null; b_deaths: number | null; b_assists: number | null;
  queue_id: number;
  source: string;
  /** 경기 분류 (solo/scrim/tournament …). 규칙은 core 의 matchCategory 하나다. */
  category: string;
  /** 같은 다전제를 묶는 키. 세트와 매치를 나눠 세려면 필요하다. */
  series_key: string;
  series_game_no: number | null;
  /** 대회 이름. 공개 큐면 null. */
  event_name: string | null;
  game_creation: Date;
  game_duration: number | null;
}

/** 선택기용 최소 목록. 이름·별칭·방송국 아이디로 찾을 수 있어야 한다. */
export interface PublicStreamerOption {
  slug: string;
  display_name: string;
  aliases: string[];
  channel_id: string | null;
}

/** 한 경기의 참가자 한 줄. **계정이 확인된 스트리머만** 나온다(§11-2). */
export interface PublicRosterEntry {
  match_id: string;
  streamer_id: string;
  slug: string;
  display_name: string;
  team_id: number;
  team_name: string | null;
  team_position: Position | null;
  champion_id: number;
  champion_name: string | null;
  win: boolean;
  kills: number; deaths: number; assists: number;
}

/** 조우가 있는 두 사람. 상대전적 첫 화면이 "많이 붙은 쌍" 을 그릴 재료다. */
export interface PublicPair {
  a_slug: string; a_name: string;
  b_slug: string; b_name: string;
  sets: number;
  vs_sets: number;
  lane_sets: number;
  last_met: Date;
}

export interface PublicRankPoint {
  streamer_id: string;
  puuid: string;
  queue_type: string;
  snapshot_date: string;
  tier: string | null;
  division: string | null;
  league_points: number | null;
  lp_absolute: number | null;
}

export async function listPublicStreamers(): Promise<PublicStreamer[]> {
  return db()<PublicStreamer[]>`
    SELECT streamer_id, slug, display_name, aliases, profile_image_url, is_pro, team_name, status
      FROM core_public.streamer ORDER BY display_name
  `;
}

export async function getPublicStreamer(slug: string): Promise<PublicStreamer | null> {
  const rows = await db()<PublicStreamer[]>`
    SELECT streamer_id, slug, display_name, aliases, profile_image_url, is_pro, team_name, status
      FROM core_public.streamer WHERE slug = ${slug} LIMIT 1
  `;
  return rows[0] ?? null;
}

/** 한 스트리머의 조우 전부. 상대·아군 모두 포함한다. */
export async function listEncountersFor(streamerId: string, limit = 500): Promise<PublicEncounter[]> {
  return db()<PublicEncounter[]>`
    SELECT e.match_id, e.streamer_a_id, e.streamer_b_id, e.relation,
           e.a_position, e.b_position, e.is_lane_matchup, e.a_win, e.b_win,
           e.a_champion_id, e.b_champion_id,
           e.a_kills, e.a_deaths, e.a_assists, e.b_kills, e.b_deaths, e.b_assists,
           e.queue_id, e.source, e.category, e.series_key, e.series_game_no,
           e.game_creation, e.game_duration,
           ev.name AS event_name
      FROM core_public.streamer_encounter e
      JOIN core_public.match m ON m.match_id = e.match_id
      LEFT JOIN core_public.event ev ON ev.event_id = m.event_id
     WHERE e.streamer_a_id = ${streamerId}::uuid OR e.streamer_b_id = ${streamerId}::uuid
     ORDER BY e.game_creation DESC LIMIT ${limit}
  `;
}

/** 두 스트리머 사이의 조우. 쌍 정규화(a < b)는 여기서 흡수한다 — 모듈이 신경 쓸 일이 아니다. */
export async function listEncountersBetween(x: string, y: string, limit = 500): Promise<PublicEncounter[]> {
  const [a, b] = [x, y].sort();
  return db()<PublicEncounter[]>`
    SELECT e.match_id, e.streamer_a_id, e.streamer_b_id, e.relation,
           e.a_position, e.b_position, e.is_lane_matchup, e.a_win, e.b_win,
           e.a_champion_id, e.b_champion_id,
           e.a_kills, e.a_deaths, e.a_assists, e.b_kills, e.b_deaths, e.b_assists,
           e.queue_id, e.source, e.category, e.series_key, e.series_game_no,
           e.game_creation, e.game_duration,
           ev.name AS event_name
      FROM core_public.streamer_encounter e
      JOIN core_public.match m ON m.match_id = e.match_id
      LEFT JOIN core_public.event ev ON ev.event_id = m.event_id
     WHERE e.streamer_a_id = ${a}::uuid AND e.streamer_b_id = ${b}::uuid
     ORDER BY e.game_creation DESC, e.series_game_no DESC LIMIT ${limit}
  `;
}

/** 티어 추이. snapshot_date 오름차순 — 그래프에 그대로 꽂는다. */
export async function listRankSeries(
  streamerId: string,
  queueType = "RANKED_SOLO_5x5",
): Promise<PublicRankPoint[]> {
  return db()<PublicRankPoint[]>`
    SELECT * FROM core_public.rank_snapshot
     WHERE streamer_id = ${streamerId}::uuid AND queue_type = ${queueType}
     ORDER BY snapshot_date
  `;
}

/** 최신 스냅샷 한 장씩. 리더보드의 원재료. */
export async function latestRanks(queueType = "RANKED_SOLO_5x5"): Promise<PublicRankPoint[]> {
  return db()<PublicRankPoint[]>`
    SELECT DISTINCT ON (streamer_id, puuid) *
      FROM core_public.rank_snapshot
     WHERE queue_type = ${queueType}
     ORDER BY streamer_id, puuid, snapshot_date DESC
  `;
}

/** 이름·별칭·방송국 아이디로 찾는 선택기용 목록. */
export async function listPublicStreamerOptions(): Promise<PublicStreamerOption[]> {
  return db()<PublicStreamerOption[]>`
    SELECT s.slug, s.display_name, s.aliases, ch.channel_id
      FROM core_public.streamer s
      LEFT JOIN LATERAL (
             SELECT channel_id FROM core_public.streamer_channel
              WHERE streamer_id = s.streamer_id ORDER BY is_primary DESC LIMIT 1
           ) ch ON true
     ORDER BY s.display_name
  `;
}

/**
 * 경기별 로스터. "그 판에 누가 있었나" 를 보여줄 때 쓴다.
 * core_public 이 이미 **계정이 확인된 스트리머만** 내보내므로 모듈이 더 거를 게 없다.
 */
export async function listMatchRosters(matchIds: string[]): Promise<PublicRosterEntry[]> {
  if (matchIds.length === 0) return [];
  return db()<PublicRosterEntry[]>`
    SELECT mp.match_id, mp.streamer_id, s.slug, s.display_name,
           mp.team_id, mp.team_position, mp.champion_id, mp.champion_name, mp.win,
           mp.kills, mp.deaths, mp.assists,
           t.name AS team_name
      FROM core_public.match_participant mp
      JOIN core_public.streamer s ON s.streamer_id = mp.streamer_id
      JOIN core_public.match m    ON m.match_id = mp.match_id
      LEFT JOIN core_public.event_team t
             ON t.event_team_id = CASE WHEN mp.team_id = 100 THEN m.blue_team_id ELSE m.red_team_id END
     WHERE mp.match_id = ANY(${matchIds}::text[])
     ORDER BY mp.match_id, mp.team_id, mp.team_position NULLS LAST, s.display_name
  `;
}

/**
 * 많이 붙은 쌍. 정렬은 **맞대결 세트** 다 — 총 조우로 정렬하면 같은 팀으로만
 * 만난 쌍이 위에 올라와서, 이 사이트가 무엇을 세는 곳인지 첫 화면부터 어긋난다.
 */
export async function listPublicPairs(limit = 20): Promise<PublicPair[]> {
  return db()<PublicPair[]>`
    SELECT a.slug AS a_slug, a.display_name AS a_name,
           b.slug AS b_slug, b.display_name AS b_name,
           count(*)::int                                        AS sets,
           count(*) FILTER (WHERE e.relation = 'opponent')::int  AS vs_sets,
           count(*) FILTER (WHERE e.is_lane_matchup)::int        AS lane_sets,
           max(e.game_creation)                                  AS last_met
      FROM core_public.streamer_encounter e
      JOIN core_public.streamer a ON a.streamer_id = e.streamer_a_id
      JOIN core_public.streamer b ON b.streamer_id = e.streamer_b_id
     GROUP BY 1, 2, 3, 4
    HAVING count(*) FILTER (WHERE e.relation = 'opponent') > 0
     ORDER BY vs_sets DESC, sets DESC
     LIMIT ${limit}
  `;
}

// ── 모듈 전용 SQL ────────────────────────────────────────────────────

/**
 * 모듈이 자기 스키마에 쓰기 위한 통로.
 *
 * ★ core 테이블을 건드리면 안 된다. 규칙은 `npm run verify:modules` 가 검사한다.
 *   여기서 raw 클라이언트를 주는 이유는 모듈마다 필요한 집계가 달라서인데,
 *   대신 어디에 쓸 수 있는지를 스키마 이름으로 못 박는다.
 */
export function moduleDb(schema: string) {
  if (!/^mod_[a-z0-9_]+$/.test(schema)) {
    throw new Error(`모듈 스키마 이름은 mod_ 로 시작해야 한다: ${schema}`);
  }
  return db();
}
