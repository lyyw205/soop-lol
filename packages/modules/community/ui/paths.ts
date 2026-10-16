import { navigationSite, routeHref, type HrefQuery } from "@soop-lol/core/lib/contract/community-client";

import manifest from "../module.json" with { type: "json" };

/** 이 모듈의 주소. module.json 의 routes 가 정본이다 — 모듈 코드에 주소 글자를 박지 않는다(verify:modules). */
export const communityHref = (query?: HrefQuery): string => routeHref(manifest.routes, {}, query)!;
export const communityPostHref = (id: number, query?: HrefQuery): string => routeHref(manifest.routes, { id: String(id) }, query)!;

/** 글 상세·쓰기·수정에서도 유지할 목록 문맥. write/edit는 다음 화면으로 전파하지 않는다. */
export function communityQuery(query: Record<string, string | string[] | undefined>) {
  const one = (key: string) => typeof query[key] === "string" ? query[key] : undefined;
  return { site: navigationSite(query), game: one("game"), s: one("s"), author: one("author"), cursor: one("cursor") };
}

/** 쓰기/삭제 성공 후에도 같은 메뉴·목록으로 돌아간다. 임의의 리다이렉트 주소는 받지 않는다. */
export function communityReturnQuery(form: FormData) {
  const keys = ["site", "game", "s", "author", "cursor"];
  return communityQuery(Object.fromEntries(keys.map(key => {
    const value = form.get(`return_${key}`);
    return [key, typeof value === "string" ? value : undefined];
  })));
}
