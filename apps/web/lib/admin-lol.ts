import type { LoLReviewCollection } from "@soop-lol/core/lib/db/lol-review-scope";
import { adminReturn } from "./admin-navigation";

export const LOL_ADMIN = {
  rift: { label: "협곡", queue: "/admin/ck", compare: "/admin/overview", unknown: "/admin/ck/unknown" },
  aram: { label: "칼바람", queue: "/admin/aram", compare: "/admin/aram/overview", unknown: "/admin/aram/unknown" },
} as const;

export function adminLoLCollection(href?: string | null): LoLReviewCollection | undefined {
  const path = adminReturn(href, "").split(/[?#]/)[0];
  if (path === "/admin/aram" || path.startsWith("/admin/aram/")) return "aram";
  if (path === "/admin/ck" || path.startsWith("/admin/ck/") || path === "/admin/overview") return "rift";
}

/**
 * 이 경기가 협곡/칼바람 목록의 것인가 — 공개 맵 탭과 같은 칸(match.map, 0089 생성 칼럼) 하나를 본다.
 * SQL 쪽 규칙(lol-review-scope.ts)과 같다. 아레나·우르프 등(unsupported)은 어느 쪽에도 들지 않는다.
 */
export function inLoLCollection(match: { map: string | null }, collection?: LoLReviewCollection): boolean {
  if (!collection) return true;
  return match.map === collection;
}
