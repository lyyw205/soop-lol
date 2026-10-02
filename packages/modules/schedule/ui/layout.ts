/**
 * 편성표 배치 계산 — 순수 함수. 화면(page.tsx)은 이 결과를 CSS grid 에 그대로 옮긴다.
 *
 * 통합 간트에서 날짜가 겹치는 행사는 서로 다른 레인에 배치한다.
 * 날짜별 목록은 동일 데이터의 보조 보기다. docs/SCHEDULE-PLAN.md §1
 */

import { addDays, daysBetween, entryPeriod, type PublicScheduleEntry, type PublicScheduleSlot } from "@soop-lol/core/lib/contract/schedule";

/** 기본으로 보는 날 수. */
export const WINDOW_DAYS = 11;
export const DAY_WIDTH = 160;
export const EXTEND_DAYS = 3;
/** 오늘 이전 3일, 오늘, 이후 7일을 우선 조회한다. */
export const WINDOW_LEAD_DAYS = 3;

export const windowDays = (from: string, n = WINDOW_DAYS): string[] => Array.from({ length: n }, (_, i) => addDays(from, i));

/**
 * 막대의 칸 범위. 1부터 세는 grid 칸 번호이고 end 는 그 칸을 포함한다.
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

/** 여러 날 행사 한 줄: 막대 범위와, 막대 안에서 실제 방송이 있는 날(진하게 칠할 칸 번호). */
export function majorRows(entries: PublicScheduleEntry[], from: string, n = WINDOW_DAYS) {
  return entries.flatMap((entry) => {
    const period = entryPeriod(entry.slots);
    const span = period && barSpan(period, from, n);
    if (!span) return [];
    const liveCols = [...new Set(entry.slots.map((s) => daysBetween(from, s.on_date) + 1).filter((c) => c >= 1 && c <= n))].sort((x, y) => x - y);
    return [{ entry, period: period!, span, liveCols }];
  });
}

/** 제목의 읽기 공간까지 충돌을 검사한다. 기간(span) 자체는 늘리지 않는다. */
export function timelineLanes(entries: PublicScheduleEntry[], from: string, n = WINDOW_DAYS, labelColumns = 1) {
  const rows = majorRows(entries, from, n).map((row) => {
    const width = Math.min(n, Math.max(row.span.end - row.span.start + 1, labelColumns));
    const start = Math.min(row.span.start, n - width + 1);
    return { ...row, displaySpan: { start, end: start + width - 1 } };
  }).sort((a, b) => a.displaySpan.start - b.displaySpan.start || b.displaySpan.end - a.displaySpan.end || a.entry.schedule_id.localeCompare(b.entry.schedule_id));
  const ends: number[] = [];
  const bars = rows.map((row) => {
    const available = ends.findIndex((end) => end < row.displaySpan.start);
    const lane = available < 0 ? ends.length : available;
    ends[lane] = row.displaySpan.end;
    return { ...row, lane };
  });
  return { bars, laneCount: Math.max(ends.length, 1) };
}

/** 여러 조회 기간에 걸친 대회는 한 번만 표시한다. 새로 받은 공개 데이터를 우선한다. */
export function mergeScheduleEntries(current: PublicScheduleEntry[], added: PublicScheduleEntry[]): PublicScheduleEntry[] {
  const byId = new Map(current.map((entry) => [entry.schedule_id, entry]));
  for (const entry of added) byId.set(entry.schedule_id, entry);
  return [...byId.values()].sort((a, b) => (entryPeriod(a.slots)?.from ?? "").localeCompare(entryPeriod(b.slots)?.from ?? "") || a.schedule_id.localeCompare(b.schedule_id));
}

/** 기존 날짜의 화면상 위치를 유지하면서 왼쪽에 추가된 칸만큼 보정한다. */
export function expandedScrollLeft(oldFrom: string, newFrom: string, scrollLeft: number, dayWidth: number): number {
  return Math.max(0, scrollLeft + daysBetween(newFrom, oldFrom) * dayWidth);
}

/** 날짜 칸의 중앙을 스크롤 영역의 중앙에 맞춘다. */
export function centeredScrollLeft(dayIndex: number, dayWidth: number, viewportWidth: number, totalWidth: number, startInset = 0): number {
  return Math.max(0, Math.min(Math.max(0, totalWidth - viewportWidth), startInset + (dayIndex + 0.5) * dayWidth - viewportWidth / 2));
}

/** 칸 날짜가 여러 날인 일정 — 아래 목록에서 '여러 날 행사' 로 따로 모은다. (규모 칸은 0059 에서 없앴다 — 날짜로 계산한다) */
export function isMultiDay(entry: { slots: { on_date: string }[] }): boolean {
  const p = entryPeriod(entry.slots);
  return p !== null && p.from !== p.to;
}
