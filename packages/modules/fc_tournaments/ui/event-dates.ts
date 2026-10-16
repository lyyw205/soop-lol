import { kstDotted, kstYear, type FcoEvent } from "@soop-lol/core/lib/contract";

type EventDates = Pick<FcoEvent, "starts_at" | "effective_starts_at" | "effective_ends_at">;

/** 조회에서 정한 날짜를 그대로 사용한다. 화면에서 경기 배열로 다시 보완하지 않는다. */
export function eventYear(event: EventDates): string | null {
  return event.effective_starts_at ? String(kstYear(new Date(event.effective_starts_at))) : null;
}

export function eventPeriod(event: EventDates): { text: string; fromMatches: boolean } {
  const start = event.effective_starts_at, end = event.effective_ends_at;
  if (!start) return { text: "일정 미정", fromMatches: false };
  const a = kstDotted(new Date(start)), b = end ? kstDotted(new Date(end)) : a;
  return { text: a === b ? a : `${a} ~ ${b}`, fromMatches: event.starts_at == null };
}
