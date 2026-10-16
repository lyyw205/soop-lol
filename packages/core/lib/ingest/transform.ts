/**
 * Riot 응답 → DB 행. **순수 함수만** 둔다 (DB 도 네트워크도 건드리지 않는다).
 *
 * 이렇게 갈라두는 이유: 수집 파이프라인에서 가장 틀리기 쉬운 곳이 "매치 하나를 행으로 펴는 규칙"인데,
 * 여기가 순수하면 실제 매치 JSON 없이도 테스트로 못을 박을 수 있다.
 *
 * ★ 참가자는 **기본 칸**(모든 판·모든 참가자)과 **상세**(지명 계정만, lol_participant_detail)로 나눠 편다
 *   (docs/CLASSIFICATION-REDESIGN-PLAN.md §3.6). 쓰기만 하고 읽는 곳이 없던 칸(lane·role·damage_taken·wards·
 *   turret_kills·first_blood_kill)은 아예 뽑지 않는다 — 뽑아 두면 언젠가 다시 저장된다.
 * ★ 조우(누가 누구를 만났나)는 여기서 계산하지 않는다. 파생 표가 없어졌고 공개 뷰(core_public.versus_pair_set)가
 *   질의 시점에 원본에서 계산한다(계획 §10 결정 5).
 */

import { totalCs } from "../metrics/matchup.ts";
import { parseMatchId } from "../riot/regions.ts";
import {
  TOURNAMENT_QUEUES,
  type MatchDto,
  type MatchInfoDto,
  type ParticipantDto,
} from "../riot/types.ts";

// ── match / match_participant ────────────────────────────────────────

export type GameCode = "lol" | "fconline";
export type MatchOutcome = "win" | "draw" | "loss" | "unknown";

/**
 * Riot 응답에서 바로 정해지는 match 칸. 판의 범위(scope)와 시리즈 자리는 여기서 정하지 않는다 —
 * 저장 쪽(db/ingest.ts saveMatch)이 지명·토너먼트 코드 여부를 보고 정한다.
 */
export interface MatchRow {
  match_id: string;
  game_code: "lol";
  platform_id: string;
  riot_game_id: number;
  queue_id: number | null;
  mode_key: string;
  game_mode: string | null;
  map_id: number | null;
  game_version: string | null;
  game_creation: Date;
  game_duration: number | null;
  winning_team: number | null;
  ended_in_surrender: boolean;
  /** 토너먼트 코드. 같은 코드 = 같은 내전 세션. 공개 큐면 null. */
  tournament_code: string | null;
  /** 어떻게 알았나 — Riot API 로 받은 판은 언제나 api. 분류 판정에 쓰지 않는다(계획 §3.3). */
  collected_via: "api";
}

/** 기본 칸 — 모든 판의 모든 참가자. VOD 판독이 채우는 칸과 같다(계획 §3.6). */
export interface ParticipantRow {
  match_id: string;
  /** Riot 이 준 puuid. 방송을 읽어 넣은 내전에서 계정을 모르면 null (0017). */
  puuid: string | null;
  /**
   * 그 자리에 있던 우리 스트리머. Riot 판은 계정 매핑에서 정해지므로 비워 두고,
   * 계정을 못 붙인 참가자만 여기로 식별한다. 둘 다 비면 저장이 거부된다.
   */
  streamer_id?: string | null;
  participant_id: number;
  team_id: number | null;
  side_no: number;
  team_position: string | null;
  individual_position: string | null;
  champion_id: number | null;
  champion_name: string | null;
  champ_level: number | null;
  /** 승패의 유일한 표현. boolean win 은 0028 에서 은퇴했다 — 무승부를 표현하지 못한다. */
  outcome: MatchOutcome;
  kills: number;
  deaths: number;
  assists: number;
}

/** 상세 — 지명 계정(collection_target)의 행만 lol_participant_detail 에 둔다. 지금 솔랭 도전만 읽는다. */
export interface DetailRow {
  match_id: string;
  participant_id: number;
  cs: number;
  gold_earned: number | null;
  damage_to_champions: number | null;
  vision_score: number | null;
  items: number[];
  summoner1_id: number | null;
  summoner2_id: number | null;
  /** 화면이 읽는 값만(storedPerks·storedChallenges). */
  perks: StoredPerks | null;
  challenges: Record<string, number> | null;
}

/**
 * 저장하는 challenges 키 — **화면이 실제로 읽는 것만**(2026-10-12). 공개면(public-ranked)도 이 목록을 그대로 내보낸다.
 * Riot 은 140여 개를 준다(이벤트 모드 SWARM_* 처럼 솔랭에선 늘 0인 것 포함). 통째로 두면 한 줄이 3KB 가 되고,
 * 그게 공개 큐 2.7만 판에서 운영 DB 디스크를 채웠다. 늘릴 때는 화면에서 쓰는지부터 보고 여기에 더한다 —
 * 이미 저장된 판엔 그 키가 없으니 Riot 보존 기간(2년) 안의 판만 다시 받아 채울 수 있다.
 */
export const STORED_CHALLENGE_KEYS = [
  "killParticipation", "teamDamagePercentage", "damagePerMinute", "goldPerMinute", "kda",
  "soloKills", "laneMinionsFirst10Minutes", "maxCsAdvantageOnLaneOpponent",
  "laningPhaseGoldExpAdvantage", "perfectGame", "multikills",
  // 기록실·케미(솔랭 도전)
  "maxKillDeficit", "survivedSingleDigitHpCount", "saveAllyFromDeath", "killsOnOtherLanesEarlyJungleAsLaner",
  "pickKillWithAlly", "outnumberedKills", "turretPlatesTaken", "visionScorePerMinute", "epicMonsterSteals", "killingSprees",
] as const;

export function storedChallenges(c: Record<string, unknown> | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of STORED_CHALLENGE_KEYS) {
    const v = c?.[k];
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/**
 * 룬은 화면이 쓰는 두 값만 — 핵심 룬과 보조 계열. 모양은 Riot 원본의 경로를 그대로 따른다:
 * 공개 뷰(core_public.personal_game, 0089)가 `perks #>> '{styles,0,selections,0,perk}'`·`'{styles,1,style}'` 로 읽는다.
 */
export interface StoredPerks {
  styles: [{ selections: [{ perk: number | null }] }, { style: number | null }];
}

export function storedPerks(perks: unknown): StoredPerks | null {
  const styles = (perks as { styles?: { style?: unknown; selections?: { perk?: unknown }[] }[] } | null)?.styles;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const keystone = n(styles?.[0]?.selections?.[0]?.perk);
  const subStyle = n(styles?.[1]?.style);
  if (keystone === null && subStyle === null) return null;
  return { styles: [{ selections: [{ perk: keystone }] }, { style: subStyle }] };
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

/**
 * 토너먼트 코드 판인가. **응답을 보고 판정한다** — 호출부가 정하게 두지 않는다.
 *
 * 두 신호를 모두 본다:
 *   · `tournamentCode` 가 있으면 무조건 토너먼트 코드 판이다 (큐 번호가 뭐든)
 *   · queueId 3130 은 토너먼트 코드 협곡방이다
 * ★ 토너먼트 코드는 분류가 아니라 입력 수단이다(사용자 결정 4). 이 판정이 정하는 것은 판의 **범위**뿐이다 —
 *   토너먼트 코드 판은 내전 세트(versus, 자동 미분류 묶음), 그 밖의 Riot 판은 지명 수집의 개인 기록(personal).
 *   한쪽이 비어 오는 경우까지 버텨야 한다 — 내전이 개인 기록으로 들어가면 어느 판이 원래 내전이었는지 되돌릴 길이 없다.
 */
export function isTournamentCodeGame(info: Pick<MatchInfoDto, "tournamentCode" | "queueId">): boolean {
  if (typeof info.tournamentCode === "string" && info.tournamentCode.length > 0) return true;
  return TOURNAMENT_QUEUES.includes(info.queueId);
}

export function toMatchRow(dto: MatchDto): MatchRow {
  const info = dto.info;
  const matchId = dto.metadata.matchId;
  // platformId 가 비어 오는 경기가 있다 — matchId 앞부분이 곧 platformId 다.
  const platformId = info.platformId || parseMatchId(matchId)?.platformId || "KR";

  return {
    match_id: matchId,
    game_code: "lol",
    platform_id: platformId.toUpperCase(),
    riot_game_id: info.gameId,
    queue_id: info.queueId,
    mode_key: String(info.queueId),
    game_mode: info.gameMode ?? null,
    map_id: info.mapId ?? null,
    game_version: info.gameVersion ?? null,
    game_creation: new Date(info.gameCreation),
    game_duration: durationSeconds(info),
    winning_team: info.teams?.find((t) => t.win)?.teamId ?? null,
    ended_in_surrender: (info.participants ?? []).some((p) => p.gameEndedInSurrender === true),
    tournament_code: info.tournamentCode || null,
    collected_via: "api",
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
    side_no: p.teamId === 100 ? 1 : 2,
    // 빈 문자열은 "판정 실패"다. NULL 로 눕혀야 SQL 에서 `IS NULL` 하나로 걸린다.
    team_position: p.teamPosition || null,
    individual_position: p.individualPosition || null,
    champion_id: p.championId,
    champion_name: p.championName ?? null,
    champ_level: int(p.champLevel),
    // Riot DTO 의 boolean 은 여기서 outcome 으로 번역되고 그걸로 끝이다.
    outcome: p.win ? "win" : "loss",
    kills: p.kills ?? 0,
    deaths: p.deaths ?? 0,
    assists: p.assists ?? 0,
  };
}

export function toParticipantRows(dto: MatchDto): ParticipantRow[] {
  return (dto.info.participants ?? []).map((p) => toParticipantRow(dto.metadata.matchId, p));
}

export function toDetailRow(matchId: string, p: ParticipantDto): DetailRow {
  return {
    match_id: matchId,
    participant_id: p.participantId,
    cs: totalCs(p),
    gold_earned: int(p.goldEarned),
    damage_to_champions: int(p.totalDamageDealtToChampions),
    vision_score: int(p.visionScore),
    items: [p.item0, p.item1, p.item2, p.item3, p.item4, p.item5, p.item6].map((i) => i ?? 0),
    summoner1_id: int(p.summoner1Id),
    summoner2_id: int(p.summoner2Id),
    perks: storedPerks(p.perks),
    challenges: storedChallenges(p.challenges),
  };
}

/** 지명 계정(`puuids`)의 상세만 편다. 나머지 참가자의 상세는 만들지도 않는다(계획 §3.6 — 상세는 지명한 사람만). */
export function toDetailRows(dto: MatchDto, puuids: ReadonlySet<string>): DetailRow[] {
  return (dto.info.participants ?? [])
    .filter((p) => p.puuid && puuids.has(p.puuid))
    .map((p) => toDetailRow(dto.metadata.matchId, p));
}
