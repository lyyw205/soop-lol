import { routeHref } from "@soop-lol/core/lib/contract";

import manifest from "../module.json" with { type: "json" };

/** 이 모듈의 주소. module.json 의 routes 가 정본이다 — 모듈 코드에 주소 글자를 박지 않는다(verify:modules). */
export const tournamentsIndexHref = (): string => routeHref(manifest.routes)!;
export const tournamentDetailHref = (slug: string): string => routeHref(manifest.routes, { slug })!;
