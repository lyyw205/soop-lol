import Link from "next/link";
import { entryPeriod, entryState, ENTRY_STATE_LABEL, kstClock, SCHEDULE_GAME_LABEL, scheduleFormatLabel,
  type PublicScheduleEntry } from "@soop-lol/core/lib/contract/schedule";
import { Avatar } from "../../../ui/avatar.tsx";
import type { DayCard } from "./layout.ts";
import { weekday } from "./content.tsx";

export type SchedulePerson = { slug: string; display_name: string; channel_id: string | null };
export const shortDate = (date: string) => date.slice(5).replace("-", ".");

export function ScheduleArrow({ diagonal = false }: { diagonal?: boolean }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
    <path d={diagonal ? "M6 18 18 6M6 6h12v12" : "M4 12h15m-6-6 6 6-6 6"} />
  </svg>;
}

export function ScheduleFaces({ entry, people }: { entry: PublicScheduleEntry; people: SchedulePerson[] }) {
  const unique = [...new Map(entry.participants.map((p) => [p.slug, p])).values()];
  return unique.length > 0 && <span className="sched-faces" aria-label={`참가자 ${unique.map((p) => p.display_name).join(", ")}`}>
    {unique.slice(0, 4).map((person) => <Avatar key={person.slug} name={person.display_name}
      channelId={people.find((p) => p.slug === person.slug)?.channel_id} />)}
    {unique.length > 4 && <span className="sched-face-more">+{unique.length - 4}</span>}
  </span>;
}

export function ScheduleStatus({ entry }: { entry: PublicScheduleEntry }) {
  return <span className="sched-status" data-state={entryState(entry.status)}><i />{ENTRY_STATE_LABEL[entryState(entry.status)]}</span>;
}

function SlotTime({ card }: { card: DayCard }) {
  return <>{card.slot.starts_at ? kstClock(new Date(card.slot.starts_at)) : <span className="sched-time-tbd">시간 미정</span>}</>;
}

export function HeadlineMatch({ card, people, href }: {
  card: DayCard; people: SchedulePerson[]; href: string;
}) {
  const { entry, slot } = card;
  return <Link href={href} data-schedule-id={entry.schedule_id} aria-haspopup="dialog" className="sched-headline" data-kind={entry.planned_format}>
    <div className="sched-headline-top"><span>주목할 일정 / {SCHEDULE_GAME_LABEL[entry.game_code]}</span><ScheduleStatus entry={entry} /></div>
    <h2>{entry.title}</h2><p>{slot.label ?? scheduleFormatLabel(entry.planned_format)}</p>
    <div className="sched-headline-bottom"><ScheduleFaces entry={entry} people={people} />
      <span className="sched-headline-time"><small>{shortDate(slot.on_date)} {weekday(slot.on_date)}요일</small><b><SlotTime card={card} /></b></span>
      <span className="sched-match-link"><ScheduleArrow diagonal /></span>
    </div>
  </Link>;
}

export function ScheduleRow({ card, people, href, compact = false }: {
  card: DayCard; people: SchedulePerson[]; href: string; compact?: boolean;
}) {
  const { entry, slot } = card;
  const hosts = entry.participants.filter((p) => p.role === "host").map((p) => p.display_name).join(" · ");
  // 미분류 일정은 분류 이름을 달지 않는다 — 확인된 것만 이름을 단다(계획 결정 7).
  const formatName = scheduleFormatLabel(entry.planned_format);
  return <Link href={href} data-schedule-id={entry.schedule_id} aria-haspopup="dialog" data-kind={entry.planned_format} data-state={entryState(entry.status)}
    className={compact ? "sched-agenda-row is-compact" : "sched-agenda-row"}>
    <span className="sched-row-time">{compact ? <><b>{slot.on_date.slice(-2)}</b><small>{Number(slot.on_date.slice(5, 7))}월 · {weekday(slot.on_date)}요일</small></>
      : <><b><SlotTime card={card} /></b><ScheduleStatus entry={entry} /></>}</span>
    <div className="sched-row-copy">
      <h3>{entry.title}</h3>
      <div className="sched-row-meta">{formatName && <span className="sched-kind">{formatName}</span>}
        <span>{compact ? <SlotTime card={card} /> : SCHEDULE_GAME_LABEL[entry.game_code]}</span>
        {slot.label && <span>{slot.label}</span>}{hosts && <span>{hosts} 주최</span>}
        {entry.slots_changed_at && entry.status !== "cancelled" && <span className="sched-changed">일정 변경</span>}
      </div>
    </div>
    {compact ? <ScheduleStatus entry={entry} /> : <ScheduleFaces entry={entry} people={people} />}
    <span className="sched-row-arrow"><ScheduleArrow diagonal={!compact} /></span>
  </Link>;
}

export function TournamentCard({ entry, date, href }: { entry: PublicScheduleEntry; date: string; href: string }) {
  const period = entryPeriod(entry.slots)!;
  const slots = [...entry.slots].sort((a, b) => a.on_date.localeCompare(b.on_date));
  const hosts = entry.participants.filter((p) => p.role === "host").map((p) => p.display_name).join(" · ");
  return <Link className="sched-competition" href={href} data-schedule-id={entry.schedule_id} aria-haspopup="dialog" data-state={entryState(entry.status)} data-kind="tournament">
    <div className="sched-competition-top"><span>{SCHEDULE_GAME_LABEL[entry.game_code]}</span>
      <span>{period.to < date && "지난 일정 · "}{shortDate(period.from)}{period.from !== period.to && ` — ${shortDate(period.to)}`}</span></div>
    <h3>{entry.title}</h3><div className="sched-competition-track">
      {slots.slice(0, 5).map((slot, i) => <span key={`${slot.on_date}-${i}`} data-current={slot.on_date === date}>
        <i /><b>{shortDate(slot.on_date)}</b><small>{slot.label ?? weekday(slot.on_date) + "요일"}</small>
      </span>)}
    </div>
    {slots.length > 5 && <span className="sched-more-slots">외 {slots.length - 5}개 일정</span>}
    <div className="sched-competition-bottom"><span>{hosts ? `${hosts} 주최` : scheduleFormatLabel(entry.planned_format)}</span><ScheduleStatus entry={entry} /><ScheduleArrow /></div>
  </Link>;
}
