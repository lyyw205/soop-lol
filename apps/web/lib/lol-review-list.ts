/**
 * LoL 검수 **목록 주소 → 목록 범위**. 목록 화면과 경기 검수 화면의 작업 목록이 이 함수 하나로 범위를 만든다.
 *
 * ★ 왜 하나로 두나(2026-10-11): 예전엔 목록은 시리즈 세트 순서, 검수 큐는 VOD 시각, 완료 후 이동은 경기 시각
 *   순이었고 조건도 일부만 이어받았다. 눈에 보이는 다음 항목과 실제로 넘어가는 항목이 달랐다.
 *   검수 화면은 돌아갈 목록 주소(`from`)를 늘 들고 다니므로, 그 주소를 같은 규칙으로 풀면 같은 범위가 된다.
 */
import type { OverviewOptions, OverviewQueue } from "@soop-lol/core/lib/db/match-overview";
import { FORMATS_BY_GAME, type Format } from "@soop-lol/core/lib/metrics/format";
import type { LoLReviewCollection } from "@soop-lol/core/lib/db/lol-review-scope";

import { LOL_ADMIN } from "./admin-lol";
import { adminReturn } from "./admin-navigation";

export type LoLListQuery = { format?: string; review?: string; q?: string; page?: string; event?: string; focus?: string; channel?: string; queue?: string };
/** 분류 필터의 진행 방식 — 공개 칩과 같은 목록·순서(core metrics/format.ts). 마지막은 "분류 전". */
export const LIST_FORMATS: readonly Format[] = FORMATS_BY_GAME.lol;

export function reviewListScope(query: LoLListQuery, collection: LoLReviewCollection) {
  const format = LIST_FORMATS.includes(query.format as Format) ? query.format as Format : undefined;
  // 기본은 우선 검수. classify = 분류 대기(자동 미분류 묶음 — 토너먼트 코드 날짜 묶음 등), all = 전체.
  const queue: OverviewQueue | undefined = query.queue === "general" ? "general" : query.queue === "classify" ? "classify"
    : query.queue === "all" ? undefined : "priority";
  const pending = query.review !== "all";
  const opts: OverviewOptions = { collection, format, unreviewed: pending, q: query.q, event: query.event, focus: query.focus, queue };
  return { format, queue, pending, opts };
}

/** 검수 화면의 `from` 이 LoL 목록(검수·시리즈 비교)이면 그 범위. 다른 화면에서 왔으면 null — 경기 하나만 본다. */
export function reviewListScopeFromHref(from?: string | null) {
  const href = adminReturn(from, "");
  if (!href) return null;
  const url = new URL(href, "https://admin.invalid");
  for (const collection of ["rift", "aram"] as const) {
    const section = LOL_ADMIN[collection];
    if (url.pathname === section.queue || url.pathname === section.compare) {
      return { collection, ...reviewListScope(Object.fromEntries(url.searchParams) as LoLListQuery, collection) };
    }
  }
  return null;
}
