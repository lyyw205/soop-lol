import { addDays } from "@soop-lol/core/lib/contract/schedule";

/** 일요일부터 시작하는 6주 달력. 시간대에 따라 날짜가 달라지지 않는다. */
export function calendarDays(month: string): string[] {
  const first = `${month}-01`;
  const weekday = new Date(`${first}T00:00:00Z`).getUTCDay();
  return Array.from({ length: 42 }, (_, index) => addDays(first, index - weekday));
}

export function adjacentMonth(month: string, direction: -1 | 1): string {
  return addDays(`${month}-01`, direction === -1 ? -1 : 32).slice(0, 7);
}
