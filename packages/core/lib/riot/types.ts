/**
 * Riot API 응답 타입.
 *
 * 전부 적지 않는다 — 우리가 실제로 읽는 필드만 적고, 나머지는 원본 JSON 을 S3 에 남긴다.
 * Riot 이 필드를 추가해도 깨지지 않게 하기 위함이고, 필요해지면 그때 원본에서 꺼내면 된다.
 */

// ── account-v1 (regional) ────────────────────────────────────────────

export interface RiotAccountDto {
  puuid: string;
  gameName?: string;
  tagLine?: string;
}

// ── summoner-v4 (platform) ───────────────────────────────────────────

export interface SummonerDto {
  puuid: string;
  /** ★ 폐기 진행 중. 어댑터 용도로만 보관하고 조인 키로 쓰지 않는다. */
  id?: string;
  profileIconId: number;
  summonerLevel: number;
  revisionDate: number;
}

// ── league-v4 (platform) ─────────────────────────────────────────────

export type QueueType = "RANKED_SOLO_5x5" | "RANKED_FLEX_SR" | (string & {});

export interface LeagueEntryDto {
  puuid?: string;
  leagueId?: string;
  queueType: QueueType;
  tier?: string;      // IRON..CHALLENGER
  rank?: string;      // I | II | III | IV
  leaguePoints: number;
  wins: number;
  losses: number;
  hotStreak?: boolean;
  veteran?: boolean;
  freshBlood?: boolean;
  inactive?: boolean;
}

// ── match-v5 (regional) ──────────────────────────────────────────────

export interface MatchDto {
  metadata: { dataVersion: string; matchId: string; participants: string[] };
  info: MatchInfoDto;
}

export interface MatchInfoDto {
  gameId: number;
  platformId: string;
  gameCreation: number;   // ms epoch
  gameStartTimestamp?: number;
  gameEndTimestamp?: number;
  gameDuration: number;   // 초
  gameMode: string;
  gameType: string;
  gameVersion: string;
  mapId: number;
  queueId: number;
  endOfGameResult?: string;
  participants: ParticipantDto[];
  teams: TeamDto[];
}

export interface TeamDto {
  teamId: number;   // 100 | 200
  win: boolean;
  bans?: { championId: number; pickTurn: number }[];
  objectives?: Record<string, { first: boolean; kills: number }>;
}

export interface ParticipantDto {
  puuid: string;
  participantId: number;
  teamId: number;
  win: boolean;

  /**
   * ★ 포지션은 Riot 의 **추론값**이다. 스왑 라인·특이 조합에서 틀린다.
   *   teamPosition 과 individualPosition 이 어긋나면 맞라인 판정에서 제외한다.
   *   (docs/PLAN.md §6-2)
   */
  teamPosition?: string;        // TOP|JUNGLE|MIDDLE|BOTTOM|UTILITY|''
  individualPosition?: string;
  lane?: string;
  role?: string;

  championId: number;
  championName?: string;
  champLevel?: number;

  kills: number;
  deaths: number;
  assists: number;
  goldEarned?: number;
  totalMinionsKilled?: number;
  neutralMinionsKilled?: number;
  totalDamageDealtToChampions?: number;
  totalDamageTaken?: number;
  visionScore?: number;
  wardsPlaced?: number;
  wardsKilled?: number;
  detectorWardsPlaced?: number;
  turretKills?: number;
  firstBloodKill?: boolean;
  gameEndedInSurrender?: boolean;

  summoner1Id?: number;
  summoner2Id?: number;
  item0?: number; item1?: number; item2?: number; item3?: number;
  item4?: number; item5?: number; item6?: number;
  perks?: unknown;

  /**
   * 라인전 지표의 금광. 타임라인 없이도 여기서 상당수가 나온다.
   *   soloKills / laneMinionsFirst10Minutes / maxLevelLeadLaneOpponent
   *   killParticipation / teamDamagePercentage / ...
   * Riot 이 자주 바꾸므로 통째로 jsonb 에 저장하고 읽을 때 방어적으로 꺼낸다.
   */
  challenges?: Record<string, number | undefined>;
}

// ── spectator-v5 (platform) ──────────────────────────────────────────

export interface CurrentGameInfoDto {
  gameId: number;
  gameType: string;
  gameQueueConfigId?: number;
  gameStartTime: number;
  platformId: string;
  gameMode: string;
  gameLength: number;
  participants: CurrentGameParticipantDto[];
}

export interface CurrentGameParticipantDto {
  puuid: string;
  teamId: number;
  championId: number;
  /** 스트리머와 같은 로비에 있던 사람 = 계정 후보 (docs/RESEARCH.md §2) */
  riotId?: string;
}

// ── 정적 상수 ────────────────────────────────────────────────────────

/** 우리가 다루는 큐. 화면 필터와 수집 대상의 단일 출처. */
export const QUEUE = {
  CUSTOM: 0,
  NORMAL_DRAFT: 400,
  RANKED_SOLO: 420,
  NORMAL_BLIND: 430,
  RANKED_FLEX: 440,
  ARAM: 450,
  QUICKPLAY: 490,
  CLASH: 700,
  ARENA: 1700,
} as const;

export const QUEUE_LABEL: Record<number, string> = {
  0: "사용자 설정",
  400: "일반(드래프트)",
  420: "솔로랭크",
  430: "일반(블라인드)",
  440: "자유랭크",
  450: "칼바람",
  490: "빠른 대전",
  700: "클래시",
  1700: "아레나",
};

/** 5v5 소환사의 협곡 큐만. 맞라인 분석이 의미 있는 범위. */
export const SUMMONERS_RIFT_QUEUES: number[] = [400, 420, 430, 440, 490, 700];

export const POSITIONS = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"] as const;
export type Position = (typeof POSITIONS)[number];

export const POSITION_LABEL: Record<Position, string> = {
  TOP: "탑",
  JUNGLE: "정글",
  MIDDLE: "미드",
  BOTTOM: "원딜",
  UTILITY: "서폿",
};
