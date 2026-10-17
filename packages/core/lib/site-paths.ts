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
export type NavigationSite = "platform" | SiteGame;

/** 공유 화면의 메뉴 문맥은 콘텐츠 필터와 별개다. 기존 ?game= 링크도 게임 메뉴로 연다. */
export function navigationSite(query: Record<string, string | string[] | undefined>): NavigationSite {
  const { site, game } = query;
  if (site === "platform" || site === "lol" || site === "fconline") return site;
  return game === "lol" || game === "fconline" ? game : "platform";
}

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

/** FC 메인과 전적 검색은 별도 화면이다. 롤은 기존 홈에서 검색한다. */
export const recordSearchHref = (game: SiteGame): string =>
  game === "fconline" ? `${GAME_BASE[game]}/search` : gameHomeHref(game);

/** 스트리머 개인 기록. */
export const profileHref = (game: SiteGame, slug: string, query?: HrefQuery): string =>
  withQuery(`${GAME_BASE[game]}/s/${encodeURIComponent(slug)}`, query);

/** 프로필 주소들의 공통 앞부분. 메뉴가 "프로필을 보는 중이면 전적 검색에 불을 켠다" 를 판정할 때 쓴다. */
export const profilePrefix = (game: SiteGame): string => `${GAME_BASE[game]}/s/`;

/** 롤 스트리머 목록(티어·우승 수). FC 는 전적 검색 화면에 목록이 있다. */
export const streamersHref = (query?: HrefQuery): string => withQuery(`${GAME_BASE.lol}/streamers`, query);

/** FC 경기 상세. */
export const fcMatchHref = (providerId: string): string =>
  `${GAME_BASE.fconline}/m/${encodeURIComponent(providerId)}`;

// ── 회원(플랫폼 공간 · core 화면) — docs/COMMUNITY-PLAN.md §2 ─────────

/** 로그인. next 는 로그인 뒤 돌아갈 내부 주소(받는 쪽이 safeNextPath 로 다시 거른다). */
export const loginHref = (next?: string): string => withQuery("/login", { next });
/** 소셜 로그인 시작(라우트 핸들러). */
export const loginStartHref = (provider: string, next?: string): string => withQuery(`/auth/${encodeURIComponent(provider)}`, { next });
/** 로그인 콜백 경로. 제공자에 등록하는 redirect_uri 는 사이트 주소 + 이 경로다. */
export const loginCallbackPath = (provider: string): string => `/auth/${encodeURIComponent(provider)}/callback`;
/** 내 정보(닉네임·로그아웃·탈퇴). setup 이면 처음 가입 마무리 화면. */
export const meHref = (query?: HrefQuery): string => withQuery("/me", query);
/** 경기 고치기 제보(로그인 필수) — 세트마다의 "제보하기"가 여기로 온다(docs/USER-SUBMISSION-PLAN.md). */
export const submitMatchHref = (matchId: string): string => `/submit/match/${encodeURIComponent(matchId)}`;
/** 편성표 제보(로그인 필수, 운영자 확인 뒤 반영) — 일정의 "제보하기"는 그 일정 번호, "빠진 일정 알리기"는 번호 없이. */
export const submitScheduleHref = (entryId?: string | null): string => `/submit/schedule/${entryId ? encodeURIComponent(entryId) : "new"}`;
/** 내 제보 — 보낸 제보와 상태. */
export const mySubmissionsHref = (): string => "/submissions";
export const termsHref = (): string => "/terms";
export const privacyHref = (): string => "/privacy";
export const policyHref = (): string => "/policy";

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

/** 사람의 일정은 두 게임 모두. 메뉴 맥락은 필수이며 game 필터는 넘기지 않는다. */
export function profileScheduleQuery(site: SiteGame, slug: string): { site: SiteGame; s: string } {
  return { site, s: slug };
}

/** 글 게임 → 들어온 메뉴 → 기록이 있는 게임. 열리지 않는 프로필로는 보내지 않는다. */
export function profileGameFor(available: readonly SiteGame[], game: SiteGame | null, site: NavigationSite): SiteGame {
  if (game && available.includes(game)) return game;
  if (site !== "platform" && available.includes(site)) return site;
  return available[0] ?? "lol";
}
