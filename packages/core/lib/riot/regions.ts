/**
 * Riot API 라우팅.
 *
 * ★ 두 종류를 섞으면 조용히 404 가 난다. 가장 흔한 실수다.
 *   - regional  (asia/americas/europe/sea) : account-v1, match-v5, tournament-v5
 *   - platform  (kr/na1/euw1/...)          : summoner-v4, league-v4, spectator-v5, champion-mastery-v4
 *
 * 우리는 KR 만 다루지만, 타입으로 강제해서 실수를 컴파일 단계에서 잡는다.
 */

export const REGIONAL_ROUTES = ["americas", "asia", "europe", "sea"] as const;
export type RegionalRoute = (typeof REGIONAL_ROUTES)[number];

export const PLATFORM_ROUTES = [
  "br1", "eun1", "euw1", "jp1", "kr", "la1", "la2",
  "na1", "oc1", "ph2", "ru", "sg2", "th2", "tr1", "tw2", "vn2",
] as const;
export type PlatformRoute = (typeof PLATFORM_ROUTES)[number];

export type RiotRoute = RegionalRoute | PlatformRoute;

/** platform → 그 platform 이 속한 regional. KR 은 asia 다. */
const PLATFORM_TO_REGIONAL: Record<PlatformRoute, RegionalRoute> = {
  br1: "americas", la1: "americas", la2: "americas", na1: "americas",
  eun1: "europe", euw1: "europe", ru: "europe", tr1: "europe",
  jp1: "asia", kr: "asia", tw2: "asia", vn2: "asia",
  oc1: "sea", ph2: "sea", sg2: "sea", th2: "sea",
};

export function regionalFor(platform: PlatformRoute): RegionalRoute {
  return PLATFORM_TO_REGIONAL[platform];
}

export function hostFor(route: RiotRoute): string {
  return `https://${route}.api.riotgames.com`;
}

/** 우리 서비스의 기본값. 설정으로 빼지 않는다 — KR 전용 서비스다. */
export const DEFAULT_PLATFORM: PlatformRoute = "kr";
export const DEFAULT_REGIONAL: RegionalRoute = "asia";

/**
 * matchId 는 `{PLATFORM_ID}_{gameId}` 형식이다. platform route(`kr`)가 아니라
 * platform **id**(`KR`)를 쓴다는 점에 주의 — 둘이 다르다.
 */
export function buildMatchId(platformId: string, gameId: number | bigint): string {
  return `${platformId.toUpperCase()}_${gameId}`;
}

export function parseMatchId(matchId: string): { platformId: string; gameId: number } | null {
  const m = /^([A-Z0-9]+)_(\d+)$/.exec(matchId);
  if (!m) return null;
  return { platformId: m[1], gameId: Number(m[2]) };
}
