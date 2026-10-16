import { navigationSite, routeHref, type HrefQuery } from "@soop-lol/core/lib/contract/schedule";

import manifest from "../module.json" with { type: "json" };

/** 이 모듈의 주소. module.json 의 routes 가 정본이다 — 모듈 코드에 주소 글자를 박지 않는다(verify:modules). */
export const scheduleHref = (query?: HrefQuery): string => routeHref(manifest.routes, {}, query)!;
export const scheduleEntryHref = (id: string, query?: HrefQuery): string => routeHref(manifest.routes, { id }, query)!;

/** 상세를 열고 돌아와도 게임 메뉴·필터·날짜를 유지한다. */
export function scheduleQuery(query: Record<string, string | string[] | undefined>) {
  const one = (key: string) => typeof query[key] === "string" ? query[key] : undefined;
  return { site: navigationSite(query), game: one("game"), date: one("date"), s: one("s"), kind: one("kind"), q: one("q") };
}
