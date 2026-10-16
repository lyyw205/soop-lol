import { addDays, entryPeriod, type PublicScheduleEntry } from "@soop-lol/core/lib/contract/schedule";
import { compareCards, type DayCard } from "./layout.ts";

export type ScheduleKindFilter = "tournament" | "ck" | "showmatch" | "other" | null;
export const parseKind = (value: string | undefined): ScheduleKindFilter =>
  value === "tournament" || value === "ck" || value === "showmatch" || value === "other" ? value : null;

/** 월요일~일요일을 표시한다. 시각·서버 시간대에 영향을 받지 않는 KST 날짜 계산. */
export function weekStart(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return addDays(date, -((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7));
}

/** 월 전체를 월요일~일요일 행으로 표시한다(28~42일). */
export function agendaRange(date: string) {
  const month = date.slice(0, 7);
  const from = weekStart(`${month}-01`);
  const nextMonth = addDays(`${month}-01`, 32).slice(0, 7);
  const last = addDays(`${nextMonth}-01`, -1);
  return { from, to: addDays(weekStart(last), 6) };
}

export function agendaEntries(entries: PublicScheduleEntry[], kind: ScheduleKindFilter, query: string) {
  const q = query.trim().replace(/\s+/g, "").toLocaleLowerCase("ko");
  return entries.filter((entry) => (!kind || entry.planned_kind === kind) && (!q ||
    [entry.title, ...entry.participants.map((p) => p.display_name), ...entry.slots.map((s) => s.label ?? "")]
      .join(" ").replace(/\s+/g, "").toLocaleLowerCase("ko").includes(q)));
}

/** 대회 전체 기간을 매일 경기로 만들지 않는다. 공지된 슬롯만 날짜별 목록에 넣는다. */
export function agendaCards(entries: PublicScheduleEntry[], from: string, to: string): DayCard[] {
  return entries.flatMap((entry) => entry.slots
    .filter((slot) => slot.on_date >= from && slot.on_date <= to).map((slot) => ({ entry, slot })))
    .sort((a, b) => a.slot.on_date.localeCompare(b.slot.on_date) || compareCards(a, b));
}

/** 취소·연기·완료를 다음 경기로 추천하지 않고, 지난 일정은 날짜를 그대로 표시한다. */
export function featuredCard(cards: DayCard[], date: string): DayCard | undefined {
  const active = (card: DayCard) => card.entry.status === "scheduled" || card.entry.status === "in_progress";
  return cards.find((card) => card.slot.on_date === date && active(card))
    ?? cards.find((card) => card.slot.on_date > date && active(card))
    ?? cards.find((card) => card.slot.on_date === date)
    ?? cards.filter((card) => card.slot.on_date < date).at(-1)
    ?? cards[0];
}

export function tournamentEntries(entries: PublicScheduleEntry[], date: string) {
  return entries.filter((entry) => entry.planned_kind === "tournament" && entry.slots.length > 0)
    .sort((a, b) => {
      const pa = entryPeriod(a.slots)!; const pb = entryPeriod(b.slots)!;
      const pastA = pa.to < date; const pastB = pb.to < date;
      return Number(pastA) - Number(pastB) || (pastA ? pb.to.localeCompare(pa.to) : pa.from.localeCompare(pb.from));
    });
}
