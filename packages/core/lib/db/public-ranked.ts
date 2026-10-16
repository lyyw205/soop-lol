/**
 * 공개 솔로랭크 조회 — 솔랭 도전(모듈)처럼 **정해진 계정들의 랭크 판**을 읽는 쪽이 쓴다.
 *
 * ★ 개인 기록(scope='personal', 지명 수집한 공개 큐 판)의 공개 경로 `core_public.personal_game` 만 읽는다 —
 *   내전 집계(versus_set)와 섞이지 않는다(계획 §3.5·§5.4).
 * ★ 상세 지표(CS·피해량·시야·아이템·룬·challenges)는 **지명한 계정의 행만** 채워진다(lol_participant_detail).
 *   같은 판의 나머지 9명은 기본 칸(챔피언·KDA·결과)뿐이다 — 그래서 상세 칸은 null 일 수 있고, 0 으로 채우지 않는다.
 *
 * ★ `core_public` 뷰만 읽는다. 숨긴 계정·숨긴 사람·숨긴 경기는 뷰가 거르므로, 도전 설정에 계정이
 *   적혀 있어도 그 계정이 숨겨지면 판도 랭크도 나오지 않는다(삭제 요청 경로가 모듈에서도 산다).
 * ★ Riot challenges 는 키 120여 개를 통째로 내보내지 않는다 — 화면이 쓰는 키만(허용 목록).
 *   원본 JSON 을 그대로 넘기면 무엇이 공개면에 나가는지 아무도 모르게 된다(FCO_PUBLIC_MATCH_INFO_KEYS 와 같은 이유).
 */

import { db } from "./client.ts";
import { STORED_CHALLENGE_KEYS } from "../ingest/transform.ts";

/** 공개면에 내보내는 challenges 키 = 저장하는 키(ingest/transform). 늘릴 때는 화면에서 실제로 쓰는지부터 본다. */
export const RANKED_CHALLENGE_KEYS = STORED_CHALLENGE_KEYS;
export type RankedChallengeKey = (typeof RANKED_CHALLENGE_KEYS)[number];

export interface PublicRankedGame {
  match_id: string;
  puuid: string;
  streamer_id: string;
  queue_id: number;
  game_creation: Date;
  game_duration: number;
  ended_in_surrender: boolean | null;
  team_id: number;
  team_position: string | null;
  champion_id: number;
  champion_name: string;
  outcome: string;
  kills: number;
  deaths: number;
  assists: number;
  /** 상세 — 지명 계정의 행만. 없으면 null(0 이 아니다). */
  cs: number | null;
  damage_to_champions: number | null;
  vision_score: number | null;
  challenges: Partial<Record<RankedChallengeKey, number>>;
  /** 아이템 7칸(마지막은 장신구) · 소환사 주문 · 핵심 룬 · 보조 계열(0069). 상세가 없으면 빈 배열. */
  items: number[];
  summoner1_id: number | null;
  summoner2_id: number | null;
  keystone_id: number | null;
  sub_style_id: number | null;
}

/** 이 계정들의 랭크 판(기본 솔로랭크 420) — 시각 오름차순. 같은 판에 둘이 있으면 두 행이다. */
export async function listPublicRankedGames(
  puuids: string[],
  range: { since: Date; until?: Date | null; queueIds: number[] },
): Promise<PublicRankedGame[]> {
  if (!puuids.length || !range.queueIds.length) return [];
  const { since, until = null, queueIds } = range;
  const rows = await db()<(Omit<PublicRankedGame, "challenges"> & { challenges: Record<string, unknown> | null })[]>`
    SELECT g.match_id, g.puuid, g.streamer_id, g.queue_id, g.played_at AS game_creation, g.game_duration, g.ended_in_surrender,
           g.side AS team_id, g.team_position, g.champion_id, g.champion_name, g.outcome,
           g.kills, g.deaths, g.assists, g.cs, g.damage_to_champions, g.vision_score, g.challenges,
           coalesce(g.items, '{}') AS items, g.summoner1_id, g.summoner2_id, g.keystone_id, g.sub_style_id
      FROM core_public.personal_game g
     WHERE g.puuid = ANY(${puuids}) AND g.queue_id = ANY(${queueIds}) AND g.played_at >= ${since}
       AND (${until}::timestamptz IS NULL OR g.played_at < ${until})
     ORDER BY g.played_at, g.match_id, g.puuid`;
  return rows.map(({ challenges, ...r }) => ({
    ...r,
    challenges: Object.fromEntries(RANKED_CHALLENGE_KEYS
      .map((k) => [k, Number(challenges?.[k])] as const)
      .filter(([, v]) => Number.isFinite(v))),
  }));
}

export interface PublicAccountRank {
  puuid: string;
  streamer_id: string;
  snapshot_date: string;
  tier: string | null;
  division: string | null;
  league_points: number | null;
  wins: number | null;
  losses: number | null;
  lp_absolute: number | null;
}

/** 계정별 솔로랭크 스냅샷 — 날짜 오름차순(진행 그래프·현재 위치). */
export async function listPublicAccountRanks(puuids: string[], queueType = "RANKED_SOLO_5x5"): Promise<PublicAccountRank[]> {
  if (!puuids.length) return [];
  return db()<PublicAccountRank[]>`
    SELECT puuid, streamer_id, snapshot_date::text AS snapshot_date, tier, division, league_points, wins, losses, lp_absolute
      FROM core_public.rank_snapshot
     WHERE puuid = ANY(${puuids}) AND queue_type = ${queueType}
     ORDER BY snapshot_date, puuid`;
}

/** 이 판들에 같이 있던 **다른 공개 스트리머** — 솔랭에서 만난 사람(아군·적군). */
export async function listPublicCoPlayers(matchIds: string[], excludeStreamerIds: string[]): Promise<{
  match_id: string; streamer_id: string; slug: string; display_name: string; team_id: number; champion_name: string; outcome: string;
}[]> {
  if (!matchIds.length) return [];
  return db()`
    SELECT g.match_id, s.streamer_id, s.slug, s.display_name, g.side AS team_id, g.champion_name, g.outcome
      FROM core_public.personal_game g
      JOIN core_public.streamer s ON s.streamer_id = g.streamer_id
     WHERE g.match_id = ANY(${matchIds}) AND NOT (g.streamer_id = ANY(${excludeStreamerIds}::uuid[]))`;
}

/**
 * 판의 한 자리 — 기본 칸(챔피언·KDA·결과)만. ★ CS·피해량·골드는 없다: 나머지 참가자는 상세를 저장하지 않는다(계획 §3.6).
 */
export interface PublicLineupSlot {
  match_id: string; participant_id: number; team_id: number; team_position: string | null;
  champion_id: number; outcome: string; kills: number; deaths: number; assists: number;
  /** 공개 스트리머 자리만 — 나머지(일반인·숨긴 사람)는 익명 */
  streamer_id: string | null; slug: string | null; display_name: string | null;
}

/** 판마다 양 팀 10자리 — 신원 없이 챔피언·KDA, 공개 스트리머 자리에만 이름(core_public.personal_game). */
export async function listPublicLineups(matchIds: string[]): Promise<PublicLineupSlot[]> {
  if (!matchIds.length) return [];
  return db()<PublicLineupSlot[]>`
    SELECT g.match_id, g.slot AS participant_id, g.side AS team_id, g.team_position, g.champion_id, g.outcome,
           g.kills, g.deaths, g.assists, g.streamer_id, s.slug, s.display_name
      FROM core_public.personal_game g
      LEFT JOIN core_public.streamer s ON s.streamer_id = g.streamer_id
     WHERE g.match_id = ANY(${matchIds})
     ORDER BY g.match_id, g.side, g.slot`;
}
