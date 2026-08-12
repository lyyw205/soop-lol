/**
 * Riot 응답 → DB 행. **순수 함수만** 둔다 (DB 도 네트워크도 건드리지 않는다).
 *
 * 이렇게 갈라두는 이유: 수집 파이프라인에서 가장 틀리기 쉬운 곳이
 * "매치 하나를 행으로 펴는 규칙"과 "누가 누구를 만났나 판정"인데,
 * 여기가 순수하면 실제 매치 JSON 없이도 테스트로 못을 박을 수 있다.
 */

import { isLaneMatchup, resolvePosition, totalCs } from "../metrics/matchup.ts";
import { parseMatchId } from "../riot/regions.ts";
import {
  SUMMONERS_RIFT_QUEUES,
  TOURNAMENT_QUEUES,
  type MatchDto,
  type MatchInfoDto,
  type ParticipantDto,
} from "../riot/types.ts";

// ── match / match_participant ────────────────────────────────────────

/**
 * 경기의 출처. **공개 큐와 내전을 절대 섞지 않는다**(§11-7)의 축이 되는 타입이다.
 * 정의가 여기(ingest) 있는 이유: 출처 판정(classifySource)이 이 파일 소관이고,
 * db/types 에 두면 db ↔ ingest 타입 순환이 생긴다. db/types 가 재수출한다.
 */
export type MatchSource = "public_queue" | "tournament_code" | "manual";

export interface MatchRow {
  match_id: string;
  platform_id: string;
  game_id: number;
  queue_id: number;
  game_mode: string | null;
  game_type: string | null;
  map_id: number | null;
  game_version: string | null;
  game_creation: Date;
  game_start: Date | null;
  game_end: Date | null;
  game_duration: number | null;
  winning_team: number | null;
  ended_in_surrender: boolean;
  source: MatchSource;
  /** 토너먼트 코드. 같은 코드 = 같은 내전 세션. 공개 큐면 null. */
  tournament_code: string | null;
}

export interface ParticipantRow {
  match_id: string;
  /** Riot 이 준 puuid. 방송을 읽어 넣은 내전에서 계정을 모르면 null (0017). */
  puuid: string | null;
  /**
   * 그 자리에 있던 우리 스트리머. 공개 큐는 계정 매핑에서 파생되므로 비워 두고,
   * 계정을 못 붙인 참가자만 여기로 식별한다. 둘 다 비면 저장이 거부된다.
   */
  streamer_id?: string | null;
  participant_id: number;
  team_id: number;
  team_position: string | null;
  individual_position: string | null;
  lane: string | null;
  role: string | null;
  champion_id: number;
  champion_name: string | null;
  champ_level: number | null;
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
  gold_earned: number | null;
  cs: number;
  damage_to_champions: number | null;
  damage_taken: number | null;
  vision_score: number | null;
  wards_placed: number | null;
  wards_killed: number | null;
  control_wards: number | null;
  turret_kills: number | null;
  first_blood_kill: boolean;
  summoner1_id: number | null;
  summoner2_id: number | null;
  items: number[];
  perks: unknown;
  challenges: Record<string, number | undefined>;
}

/**
 * `gameDuration` 의 단위는 경기마다 다르다.
 *
 * Riot 공식: 패치 11.20 이전 경기는 `gameEndTimestamp` 가 없고 이때 **밀리초**,
 * 있으면 **초**다. 백필이 2년치라 대부분 후자지만, 단위를 잘못 읽으면
 * 20분 경기가 20만 초(=55시간)로 들어가서 평균 경기시간이 통째로 망가진다.
 */
export function durationSeconds(info: Pick<MatchInfoDto, "gameDuration" | "gameEndTimestamp">): number | null {
  if (typeof info.gameDuration !== "number" || !Number.isFinite(info.gameDuration)) return null;
  return info.gameEndTimestamp ? info.gameDuration : Math.round(info.gameDuration / 1000);
}

const ms = (v: number | undefined | null): Date | null =>
  typeof v === "number" && v > 0 ? new Date(v) : null;

/**
 * 이 경기가 내전인가. **응답을 보고 판정한다** — 호출부가 정하게 두지 않는다.
 *
 * 두 신호를 모두 본다:
 *   · `tournamentCode` 가 있으면 무조건 내전이다 (큐 번호가 뭐든)
 *   · queueId 3130 은 토너먼트 코드 협곡방이다
 * 하나만 봐도 대부분 맞지만, 둘 다 보는 건 §11-7(공개 큐와 절대 안 섞는다)이
 * **한쪽이 비어 오는 경우까지** 버텨야 하는 규칙이라서다. 잘못 섞이면
 * 사후에 되돌리기 어렵다 — 어느 경기가 원래 내전이었는지 알 길이 없어진다.
 */
export function classifySource(info: MatchInfoDto): MatchSource {
  if (typeof info.tournamentCode === "string" && info.tournamentCode.length > 0) {
    return "tournament_code";
  }
  return TOURNAMENT_QUEUES.includes(info.queueId) ? "tournament_code" : "public_queue";
}

/**
 * `source` 를 넘기지 않으면 응답을 보고 판정한다.
 * 수기 데이터(`'manual'`)처럼 응답으로 알 수 없는 것만 호출부가 지정한다.
 */
export function toMatchRow(dto: MatchDto, source?: MatchSource): MatchRow {
  const info = dto.info;
  const matchId = dto.metadata.matchId;
  // platformId 가 비어 오는 경기가 있다 — matchId 앞부분이 곧 platformId 다.
  const platformId = info.platformId || parseMatchId(matchId)?.platformId || "KR";

  return {
    match_id: matchId,
    platform_id: platformId.toUpperCase(),
    game_id: info.gameId,
    queue_id: info.queueId,
    game_mode: info.gameMode ?? null,
    game_type: info.gameType ?? null,
    map_id: info.mapId ?? null,
    game_version: info.gameVersion ?? null,
    game_creation: new Date(info.gameCreation),
    game_start: ms(info.gameStartTimestamp),
    game_end: ms(info.gameEndTimestamp),
    game_duration: durationSeconds(info),
    winning_team: info.teams?.find((t) => t.win)?.teamId ?? null,
    ended_in_surrender: (info.participants ?? []).some((p) => p.gameEndedInSurrender === true),
    source: source ?? classifySource(info),
    tournament_code: info.tournamentCode || null,
  };
}

const int = (v: number | undefined | null): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

export function toParticipantRow(matchId: string, p: ParticipantDto): ParticipantRow {
  return {
    match_id: matchId,
    puuid: p.puuid,
    participant_id: p.participantId,
    team_id: p.teamId,
    // 빈 문자열은 "판정 실패"다. NULL 로 눕혀야 SQL 에서 `IS NULL` 하나로 걸린다.
    team_position: p.teamPosition || null,
    individual_position: p.individualPosition || null,
    lane: p.lane || null,
    role: p.role || null,
    champion_id: p.championId,
    champion_name: p.championName ?? null,
    champ_level: int(p.champLevel),
    win: p.win,
    kills: p.kills ?? 0,
    deaths: p.deaths ?? 0,
    assists: p.assists ?? 0,
    gold_earned: int(p.goldEarned),
    cs: totalCs(p),
    damage_to_champions: int(p.totalDamageDealtToChampions),
    damage_taken: int(p.totalDamageTaken),
    vision_score: int(p.visionScore),
    wards_placed: int(p.wardsPlaced),
    wards_killed: int(p.wardsKilled),
    control_wards: int(p.detectorWardsPlaced),
    turret_kills: int(p.turretKills),
    first_blood_kill: p.firstBloodKill === true,
    summoner1_id: int(p.summoner1Id),
    summoner2_id: int(p.summoner2Id),
    items: [p.item0, p.item1, p.item2, p.item3, p.item4, p.item5, p.item6].map((i) => i ?? 0),
    perks: p.perks ?? null,
    challenges: p.challenges ?? {},
  };
}

export function toParticipantRows(dto: MatchDto): ParticipantRow[] {
  return (dto.info.participants ?? []).map((p) => toParticipantRow(dto.metadata.matchId, p));
}

// ── streamer_encounter — 이 프로젝트의 심장 ──────────────────────────

/** 조우 판정에 필요한 최소 필드. match_participant 에서 그대로 읽어온다. */
export interface EncounterParticipant {
  /**
   * Riot 계정. **방송을 읽어 넣은 내전에서는 없을 수 있다** —
   * 그때는 `streamer_id` 로 사람을 식별한다(마이그레이션 0017).
   */
  puuid: string | null;
  /** 계정을 아직 못 붙였지만 그 자리에 있던 게 확인된 우리 스트리머. */
  streamer_id?: string | null;
  team_id: number;
  team_position: string | null;
  individual_position: string | null;
  win: boolean;
  champion_id: number;
  kills: number;
  deaths: number;
  assists: number;
  cs: number | null;
  gold_earned: number | null;
  damage_to_champions: number | null;
}

export interface EncounterMatch {
  match_id: string;
  queue_id: number;
  source: string;
  game_creation: Date;
  game_duration: number | null;
}

export interface EncounterRow {
  match_id: string;
  streamer_a_id: string;
  streamer_b_id: string;
  /** 어느 계정으로 뛰었는지 되짚는 참고값. 계정을 모르면 null 이다(0017). */
  a_puuid: string | null;
  b_puuid: string | null;
  relation: "opponent" | "ally";
  a_position: string | null;
  b_position: string | null;
  is_lane_matchup: boolean;
  a_win: boolean;
  b_win: boolean;
  a_champion_id: number;
  b_champion_id: number;
  a_kills: number; a_deaths: number; a_assists: number;
  a_cs: number | null; a_gold: number | null; a_damage: number | null;
  b_kills: number; b_deaths: number; b_assists: number;
  b_cs: number | null; b_gold: number | null; b_damage: number | null;
  queue_id: number;
  source: string;
  game_creation: Date;
  game_duration: number | null;
}

/**
 * 한 경기에서 스트리머 쌍을 뽑는다.
 *
 * 규칙:
 *  - 쌍은 항상 `streamer_a_id < streamer_b_id` 로 정규화한다 (스키마 CHECK 와 같은 규칙).
 *    uuid 소문자 16진 문자열 비교는 Postgres 의 uuid 바이트 비교와 순서가 같다.
 *  - 한 스트리머가 같은 경기에 계정 두 개로 잡히는 건 **매핑 사고**다.
 *    자기 자신과의 쌍은 만들지 않고, 먼저 나온 참가자만 대표로 쓴다.
 *  - `is_lane_matchup` 은 **협곡 5v5** 에서만 참일 수 있다.
 *    칼바람·아레나엔 라인이 없다 (거기서 나온 teamPosition 은 의미가 없다).
 *
 *    대회 경기(source='manual')는 큐 아이디가 0(커스텀)이라 큐 목록에 없지만,
 *    멸망전 같은 내전은 협곡 5v5 다. 그리고 여기 들어오는 포지션은 Riot 추론값이
 *    아니라 **주최측이 발표한 로스터 포지션**이라 오히려 더 단단하다.
 *    포지션이 비어 있으면 resolvePosition 이 null 을 주므로 그때는 여전히 안 센다 —
 *    "애매하면 판정하지 않는다"(§11-10)는 그대로다.
 */
export function deriveEncounters(
  match: EncounterMatch,
  participants: EncounterParticipant[],
  ownerOf: ReadonlyMap<string, string>,
): EncounterRow[] {
  const laneCapable =
    SUMMONERS_RIFT_QUEUES.includes(match.queue_id) || match.source === "manual";

  const seen = new Map<string, EncounterParticipant>();
  for (const p of participants) {
    // ★ 계정이 붙어 있으면 그걸로, 아니면 사람으로 식별한다.
    //   조우는 **사람 사이**의 사실이라 계정이 없다고 빠뜨리면 안 된다 —
    //   실제로 이라333 이 시그니처CK 5경기에서 통째로 사라져 있었다.
    const streamerId = (p.puuid ? ownerOf.get(p.puuid) : null) ?? p.streamer_id ?? null;
    if (!streamerId) continue;
    if (!seen.has(streamerId)) seen.set(streamerId, p);
  }
  if (seen.size < 2) return [];

  const entries = [...seen.entries()].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  const rows: EncounterRow[] = [];

  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const [aId, a] = entries[i];
      const [bId, b] = entries[j];
      rows.push({
        match_id: match.match_id,
        streamer_a_id: aId,
        streamer_b_id: bId,
        a_puuid: a.puuid,
        b_puuid: b.puuid,
        relation: a.team_id === b.team_id ? "ally" : "opponent",
        a_position: resolvePosition({ teamPosition: a.team_position ?? undefined, individualPosition: a.individual_position ?? undefined }),
        b_position: resolvePosition({ teamPosition: b.team_position ?? undefined, individualPosition: b.individual_position ?? undefined }),
        is_lane_matchup: laneCapable && isLaneMatchup(
          { teamId: a.team_id, teamPosition: a.team_position ?? undefined, individualPosition: a.individual_position ?? undefined },
          { teamId: b.team_id, teamPosition: b.team_position ?? undefined, individualPosition: b.individual_position ?? undefined },
        ),
        a_win: a.win,
        b_win: b.win,
        a_champion_id: a.champion_id,
        b_champion_id: b.champion_id,
        a_kills: a.kills, a_deaths: a.deaths, a_assists: a.assists,
        a_cs: a.cs, a_gold: a.gold_earned, a_damage: a.damage_to_champions,
        b_kills: b.kills, b_deaths: b.deaths, b_assists: b.assists,
        b_cs: b.cs, b_gold: b.gold_earned, b_damage: b.damage_to_champions,
        queue_id: match.queue_id,
        source: match.source,
        game_creation: match.game_creation,
        game_duration: match.game_duration,
      });
    }
  }
  return rows;
}
