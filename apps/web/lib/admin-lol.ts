import { matchCategory, type MatchCategoryInput } from "@soop-lol/core/lib/metrics/category";
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

export function inLoLCollection(match: MatchCategoryInput, collection?: LoLReviewCollection): boolean {
  if (!collection) return true;
  const category = matchCategory(match);
  const aram = category === "aram" || category === "aram_custom";
  return collection === "aram" ? aram : !aram && category !== "excluded";
}
