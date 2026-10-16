import { isFormat, type Format } from "./format.ts";
import { resolveRecordPeriod, type RecordPeriod } from "./record-period.ts";

/**
 * 기록 화면의 필터 — **맵 탭 · 진행 방식 · 기간**(+ 관계·정렬·FC 경기 모드). 주소(`?map=&format=&…`)에 남는다.
 *
 * ★ 분류는 둘뿐이다(docs/CLASSIFICATION-REDESIGN-PLAN.md §5.3): 롤 맵(협곡/칼바람)과 행사의 진행 방식(format.ts).
 *   한 맵 탭 안에서 "전체" = 진행 방식 칩들의 합이다 — 미분류도 "분류 전" 칩으로 있어 몰래 빠지는 값이 없다.
 * ★ 칼바람은 진행 방식으로 나누지 않는다(사용자 결정 8). 칼바람 탭에서는 format 을 무시한다(`scopeFormat`).
 * ★ 기간은 시리즈 첫 본게임의 KST 날짜(core_public 의 series_started_on)로 판단한다 — 시리즈가 통째로 들어오거나 빠진다.
 */
export const MAP_TABS = [
  { key: "rift", label: "협곡" },
  { key: "aram", label: "칼바람" },
] as const;
export type MapTab = (typeof MAP_TABS)[number]["key"];
export const DEFAULT_MAP: MapTab = "rift";
export const isMapTab = (v: string | null | undefined): v is MapTab => MAP_TABS.some((m) => m.key === v);
export const mapTabLabel = (m: MapTab) => MAP_TABS.find((t) => t.key === m)!.label;

export type FormatFilter = Format | "all";

/** 질의에 넘길 진행 방식. "전체"·칼바람 탭이면 null(거르지 않는다). */
export const scopeFormat = (map: MapTab, format: FormatFilter): Format | null =>
  map === "aram" || format === "all" ? null : format;

export interface RecordScope {
  map: MapTab;
  format: FormatFilter;
  mode: string;
  relation: "o" | "a" | "l";
  sort: "recent" | "oldest";
  period: RecordPeriod;
}
export function readRecordScope(query: Pick<URLSearchParams, "get">): RecordScope {
  const format = query.get("format");
  const map = query.get("map");
  const year = query.get("year");
  return {
    map: isMapTab(map) ? map : DEFAULT_MAP,
    format: format && isFormat(format) ? format : "all",
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
  for (const key of ["map", "format", "mode", "relation", "sort", "year", "period", "from", "to"]) out.delete(key);
  if (scope.map !== DEFAULT_MAP) out.set("map", scope.map);
  if (scope.format !== "all") out.set("format", scope.format);
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

/** 공개 내전 세트를 고르는 조건 — 질의(core/lib/db)가 core_public.versus_set·versus_pair_set 에 그대로 건다. */
export interface VersusScope {
  map?: MapTab;
  format?: FormatFilter;
  /** KST 달력 날짜(`YYYY-MM-DD`). 시리즈 첫 본게임 날짜(series_started_on)로 자른다. */
  from?: string;
  to?: string;
}
