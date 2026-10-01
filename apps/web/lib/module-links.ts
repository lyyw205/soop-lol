/**
 * 모듈이 채우는 자리로 가는 링크.
 *
 * ★ core 는 모듈 **이름**을 모른다
 *   "상대전적" 이라는 **역할**을 등록부에 묻고, 그 역할을 채우는 모듈의 경로를 받는다.
 *   versus 모듈을 지우면 여기가 null 을 돌려주고 링크는 저절로 사라진다 —
 *   core 코드는 한 줄도 안 고친다(계약 4조: core 는 모듈을 import 하지 않는다).
 */

import { routeHref, type HrefQuery } from "@soop-lol/core/lib/site-paths";
import { moduleProviding } from "@soop-lol/modules/registry";

/** 두 스트리머의 상대전적 화면. 그 역할을 채우는 모듈이 없으면 null. */
export function versusHref(aSlug: string, bSlug: string, scope: { category?: string; year?: number; relation?: "ally" | "lane"; from?: string; to?: string } = {}): string | null {
  return roleHref("versus", {}, {
    a: aSlug, b: bSlug, category: scope.category === "all" ? undefined : scope.category,
    year: scope.year, relation: scope.relation, from: scope.from, to: scope.to,
  });
}

/** 상대전적 첫 화면(선택기). 없으면 null. */
export const versusIndexHref = (): string | null => roleHref("versus");

/**
 * 그 역할을 채우는 모듈의 경로. `params` 의 키와 경로의 [칸]이 딱 맞는 경로를 고른다
 * (`/fc/tournaments` 와 `/fc/tournaments/[slug]` 중에서). 모듈이 없으면 null — 링크를 안 그리면 된다.
 */
export function roleHref(role: string, params: Record<string, string> = {}, query?: HrefQuery): string | null {
  const mod = moduleProviding(role);
  return mod ? routeHref(mod.routes, params, query) : null;
}

/** FC 상대전적·대회 화면. 그 모듈이 없으면 null. */
export const fcVersusIndexHref = () => roleHref("fc-versus");
export const fcVersusHref = (a: string, b: string) => roleHref("fc-versus", {}, { a, b });
export const fcTournamentsIndexHref = () => roleHref("fc-tournaments");
export const fcTournamentHref = (slug: string) => roleHref("fc-tournaments", { slug });
