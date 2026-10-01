/**
 * 편성표 배치 계산 — 순수 함수. 화면(page.tsx)은 이 결과를 CSS grid 에 그대로 옮긴다.
 *
 * ★ 위는 간트(대형: 행사 하나가 한 줄, 기간만큼 긴 막대), 아래는 날짜 칸(소형: 그날 칸에 카드).
 *   좁은 화면은 간트를 버리고 날짜별 목록(agenda)으로 그린다. docs/SCHEDULE-PLAN.md §1
 */

import { addDays, daysBetween, entryPeriod, type PublicScheduleEntry, type PublicScheduleSlot } from "@soop-lol/core/lib/contract";

/** 기본으로 보는 날 수. */
export const WINDOW_DAYS = 14;
/** 기본 창은 오늘보다 며칠 앞에서 시작한다 — 막 끝난 일정(개최 미확인)도 보이게. */
export const WINDOW_LEAD_DAYS = 3;

export const windowDays = (from: string, n = WINDOW_DAYS): string[] => Array.from({ length: n }, (_, i) => addDays(from, i));

/**
 * 대형 막대의 칸 범위. 1부터 세는 grid 칸 번호이고 end 는 그 칸을 포함한다.
 * 창 밖으로 나간 쪽은 잘라 내고 cutStart·cutEnd 로 알린다(화살표를 그린다). 창과 안 겹치면 null.
 */
export function barSpan(period: { from: string; to: string }, from: string, n = WINDOW_DAYS):
  { start: number; end: number; cutStart: boolean; cutEnd: boolean } | null {
  const a = daysBetween(from, period.from);
  const b = daysBetween(from, period.to);
  if (b < 0 || a > n - 1) return null;
  return { start: Math.max(a, 0) + 1, end: Math.min(b, n - 1) + 1, cutStart: a < 0, cutEnd: b > n - 1 };
}

export interface DayCard { entry: PublicScheduleEntry; slot: PublicScheduleSlot }

/** 같은 날 안의 순서: 시각을 아는 칸을 시각순으로 먼저, 시각 미정은 뒤에 제목순. */
export function compareCards(a: DayCard, b: DayCard): number {
  const ta = a.slot.starts_at ? new Date(a.slot.starts_at).getTime() : null;
  const tb = b.slot.starts_at ? new Date(b.slot.starts_at).getTime() : null;
  if (ta !== null && tb !== null && ta !== tb) return ta - tb;
  if (ta === null && tb !== null) return 1;
  if (ta !== null && tb === null) return -1;
  return a.entry.title.localeCompare(b.entry.title, "ko");
}

/** 날짜 → 그날의 칸들(정렬됨). days 에 없는 날짜의 칸은 버린다. */
export function cardsByDay(entries: PublicScheduleEntry[], days: string[]): Map<string, DayCard[]> {
  const out = new Map<string, DayCard[]>(days.map((d) => [d, []]));
  for (const entry of entries) for (const slot of entry.slots) out.get(slot.on_date)?.push({ entry, slot });
  for (const list of out.values()) list.sort(compareCards);
  return out;
}

/** 대형 행사 한 줄: 막대 범위와, 막대 안에서 실제 방송이 있는 날(진하게 칠할 칸 번호). */
export function majorRows(entries: PublicScheduleEntry[], from: string, n = WINDOW_DAYS) {
  return entries.flatMap((entry) => {
    const period = entryPeriod(entry.slots);
    const span = period && barSpan(period, from, n);
    if (!span) return [];
    const liveCols = [...new Set(entry.slots.map((s) => daysBetween(from, s.on_date) + 1).filter((c) => c >= 1 && c <= n))].sort((x, y) => x - y);
    return [{ entry, period: period!, span, liveCols }];
  });
}
