/**
 * 공개 솔로랭크 조회 — 솔랭 도전(모듈)처럼 **정해진 계정들의 랭크 판**을 읽는 쪽이 쓴다.
 *
 * ★ `core_public` 뷰만 읽는다. 숨긴 계정·숨긴 사람·숨긴 경기는 뷰가 거르므로, 도전 설정에 계정이
 *   적혀 있어도 그 계정이 숨겨지면 판도 랭크도 나오지 않는다(삭제 요청 경로가 모듈에서도 산다).
 * ★ Riot challenges 는 키 120여 개를 통째로 내보내지 않는다 — 화면이 쓰는 키만(허용 목록).
 *   원본 JSON 을 그대로 넘기면 무엇이 공개면에 나가는지 아무도 모르게 된다(FCO_PUBLIC_MATCH_INFO_KEYS 와 같은 이유).
 */

import { db } from "./client.ts";

/** 공개면에 내보내는 challenges 키. 늘릴 때는 화면에서 실제로 쓰는지부터 본다. */
export const RANKED_CHALLENGE_KEYS = [
  "killParticipation", "teamDamagePercentage", "damagePerMinute", "goldPerMinute", "kda",
  "soloKills", "laneMinionsFirst10Minutes", "maxCsAdvantageOnLaneOpponent",
  "laningPhaseGoldExpAdvantage", "perfectGame", "multikills",
] as const;
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
  cs: number;
  damage_to_champions: number;
  vision_score: number;
  challenges: Partial<Record<RankedChallengeKey, number>>;
}

/** 이 계정들의 랭크 판(기본 솔로랭크 420) — 시각 오름차순. 같은 판에 둘이 있으면 두 행이다. */
export async function listPublicRankedGames(puuids: string[], since: Date, queueIds: number[] = [420]): Promise<PublicRankedGame[]> {
  if (!puuids.length) return [];
  const rows = await db()<(Omit<PublicRankedGame, "challenges"> & { challenges: Record<string, unknown> | null })[]>`
    SELECT p.match_id, p.puuid, p.streamer_id, m.queue_id, m.game_creation, m.game_duration, m.ended_in_surrender,
           p.team_id, p.team_position, p.champion_id, p.champion_name, p.outcome,
           p.kills, p.deaths, p.assists, p.cs, p.damage_to_champions, p.vision_score, p.challenges
      FROM core_public.match_participant p
      JOIN core_public.match m ON m.match_id = p.match_id
     WHERE p.puuid = ANY(${puuids}) AND m.queue_id = ANY(${queueIds}) AND m.game_creation >= ${since}
     ORDER BY m.game_creation, p.match_id, p.puuid`;
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
    SELECT p.match_id, s.streamer_id, s.slug, s.display_name, p.team_id, p.champion_name, p.outcome
      FROM core_public.match_participant p
      JOIN core_public.streamer s ON s.streamer_id = p.streamer_id
     WHERE p.match_id = ANY(${matchIds}) AND NOT (p.streamer_id = ANY(${excludeStreamerIds}::uuid[]))`;
}
