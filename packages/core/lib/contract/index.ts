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
export { affinity, rawWinRate, games, SMALL_SAMPLE_THRESHOLD } from "../metrics/affinity.ts";
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
  queue_id: number;
  source: string;
  game_creation: Date;
  game_duration: number | null;
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
    SELECT * FROM core_public.streamer_encounter
     WHERE streamer_a_id = ${streamerId}::uuid OR streamer_b_id = ${streamerId}::uuid
     ORDER BY game_creation DESC LIMIT ${limit}
  `;
}

/** 두 스트리머 사이의 조우. 쌍 정규화(a < b)는 여기서 흡수한다 — 모듈이 신경 쓸 일이 아니다. */
export async function listEncountersBetween(x: string, y: string, limit = 500): Promise<PublicEncounter[]> {
  const [a, b] = [x, y].sort();
  return db()<PublicEncounter[]>`
    SELECT * FROM core_public.streamer_encounter
     WHERE streamer_a_id = ${a}::uuid AND streamer_b_id = ${b}::uuid
     ORDER BY game_creation DESC LIMIT ${limit}
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
