/**
 * 사이트 주소를 만드는 **유일한 곳**.
 *
 * ★ 왜 한 곳인가
 *   프로필 주소(`/s/${slug}`)가 웹·공용 UI·모듈 안에 글자로 40곳쯤 박혀 있었다. 롤을 `/lol` 로
 *   옮기려니(docs/PLATFORM-LAYER-PLAN.md) 40곳을 하나씩 고쳐야 했고, 다음에 옮길 때 같은 일이 또 생긴다.
 *   모듈이 core 주소를 아는 것도 "모듈은 주소를 모른다"는 원칙과 어긋난다.
 *   → core 화면 주소는 여기 함수로만 만든다. 모듈·공용 UI 에 주소 글자가 다시 박히면
 *     `verify:modules` 가 실패한다.
 *
 * ★ 모듈 자기 화면의 주소는 여기 없다 — 모듈의 `module.json` 이 주소의 정본이고,
 *   `routeHref(manifest.routes, …)` 로 만든다. host 의 `roleHref` 도 같은 함수를 쓴다.
 */

export type SiteGame = "lol" | "fconline";

/**
 * 게임 공간의 뿌리. 주소를 옮길 때 고칠 곳은 여기 한 줄이다.
 * `/` 는 게임과 무관한 로비(플랫폼 공간)다 — docs/PLATFORM-LAYER-PLAN.md. 롤은 2026-10-02 에 `/` 에서 `/lol` 로 옮겼다.
 */
const GAME_BASE: Record<SiteGame, string> = { lol: "/lol", fconline: "/fc" };

export type HrefQuery = Record<string, string | number | null | undefined> | URLSearchParams;

function withQuery(path: string, query?: HrefQuery): string {
  if (!query) return path;
  const qs = query instanceof URLSearchParams
    ? query.toString()
    : new URLSearchParams(Object.entries(query).flatMap(([k, v]): [string, string][] => v == null || v === "" ? [] : [[k, String(v)]])).toString();
  return qs ? `${path}?${qs}` : path;
}

/** 로비(플랫폼 공간) 첫 화면. */
export const lobbyHref = (): string => "/";

/** 게임 공간 첫 화면. */
export const gameHomeHref = (game: SiteGame): string => GAME_BASE[game];

/** 스트리머 개인 기록. */
export const profileHref = (game: SiteGame, slug: string, query?: HrefQuery): string =>
  withQuery(`${GAME_BASE[game]}/s/${encodeURIComponent(slug)}`, query);

/** 프로필 주소들의 공통 앞부분. 메뉴가 "프로필을 보는 중이면 전적 검색에 불을 켠다" 를 판정할 때 쓴다. */
export const profilePrefix = (game: SiteGame): string => `${GAME_BASE[game]}/s/`;

/** 롤 스트리머 목록(티어·우승 수). FC 는 첫 화면이 목록을 겸해서 따로 없다. */
export const streamersHref = (query?: HrefQuery): string => withQuery(`${GAME_BASE.lol}/streamers`, query);

/** FC 경기 상세. */
export const fcMatchHref = (providerId: string): string =>
  `${GAME_BASE.fconline}/m/${encodeURIComponent(providerId)}`;

/**
 * 모듈 경로 목록에서 `params` 의 키와 [칸]이 딱 맞는 경로를 골라 채운다.
 * (`/tournaments` 와 `/tournaments/[slug]` 중에서) 맞는 게 없으면 null.
 */
export function routeHref(routes: readonly { path: string }[], params: Record<string, string> = {}, query?: HrefQuery): string | null {
  const want = Object.keys(params).sort().join(",");
  const route = routes.find((r) => [...r.path.matchAll(/\[(\w+)\]/g)].map((m) => m[1]).sort().join(",") === want);
  if (!route) return null;
  return withQuery(route.path.replace(/\[(\w+)\]/g, (_, key: string) => encodeURIComponent(params[key])), query);
}
