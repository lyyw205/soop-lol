import { isMatchCategoryFilter, type MatchCategoryFilter } from "./category.ts";
import { resolveRecordPeriod, type RecordPeriod } from "./record-period.ts";

export interface RecordScope {
  category: MatchCategoryFilter;
  mode: string;
  relation: "o" | "a" | "l";
  sort: "recent" | "oldest";
  period: RecordPeriod;
}
export function readRecordScope(query: Pick<URLSearchParams, "get">): RecordScope {
  const category = query.get("category");
  const year = query.get("year");
  return {
    category: category && isMatchCategoryFilter(category) ? category : "all",
    mode: query.get("mode") || "all",
    relation: query.get("relation") === "ally" ? "a" : query.get("relation") === "lane" ? "l" : "o",
    sort: query.get("sort") === "oldest" ? "oldest" : "recent",
    period: resolveRecordPeriod({ period: query.get("period") ?? undefined, from: query.get("from") ?? undefined,
      to: query.get("to") ?? undefined, year: year && /^[1-9]\d{3}$/.test(year) ? Number(year) : undefined }),
  };
}
/** 필터만 교체한다. a/b, tab, site 같은 이동 맥락은 보존한다. */
export function writeRecordScope(query: URLSearchParams, scope: RecordScope): URLSearchParams {
  const out = new URLSearchParams(query);
  for (const key of ["category", "mode", "relation", "sort", "year", "period", "from", "to"]) out.delete(key);
  if (scope.category !== "all") out.set("category", scope.category);
  if (scope.mode !== "all") out.set("mode", scope.mode);
  if (scope.relation !== "o") out.set("relation", scope.relation === "a" ? "ally" : "lane");
  if (scope.sort !== "recent") out.set("sort", scope.sort);
  if (scope.period.key === "year" && scope.period.from) out.set("year", scope.period.from.slice(0, 4));
  else {
    if (scope.period.from) out.set("from", scope.period.from);
    if (scope.period.to) out.set("to", scope.period.to);
  }
  return out;
}
