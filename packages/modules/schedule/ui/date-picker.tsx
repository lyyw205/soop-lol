"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { addDays } from "@soop-lol/core/lib/contract/schedule";
import { adjacentMonth, calendarDays } from "./calendar.ts";

export function ScheduleDatePicker({ value, today, disabled, onSelect }: {
  value: string; today: string; disabled: boolean; onSelect: (date: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(value.slice(0, 7));
  const [focused, setFocused] = useState(value);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popupId = useId();
  const dates = calendarDays(month);
  const currentYear = Number(today.slice(0, 4));
  const years = [...new Set([Number(month.slice(0, 4)), ...Array.from({ length: 31 }, (_, i) => currentYear - 25 + i)])].sort((a, b) => a - b);
  const tabDate = focused.startsWith(month) ? focused : `${month}-01`;

  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLButtonElement>(`[data-calendar-date="${focused}"]`)?.focus({ preventScroll: true });
  }, [open, focused]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  function choose(date: string) {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
    onSelect(date);
  }

  function move(event: KeyboardEvent<HTMLButtonElement>, date: string) {
    const offsets: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    let next: string;
    if (event.key in offsets) next = addDays(date, offsets[event.key]);
    else if (event.key === "PageUp" || event.key === "PageDown") next = `${adjacentMonth(month, event.key === "PageUp" ? -1 : 1)}-01`;
    else return;
    event.preventDefault();
    setMonth(next.slice(0, 7)); setFocused(next);
  }

  return <div className="sched-calendar" ref={root}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false); }}
    onKeyDown={(event) => { if (event.key === "Escape" && open) { event.stopPropagation(); setOpen(false); trigger.current?.focus(); } }}>
    <button ref={trigger} type="button" disabled={disabled} aria-expanded={open} aria-controls={popupId} aria-haspopup="dialog"
      onClick={() => { if (!open) { setMonth(value.slice(0, 7)); setFocused(value); } setOpen(!open); }}>{value.replaceAll("-", ".")} ▾</button>
    {open && <div className="sched-calendar-popup" id={popupId} role="dialog" aria-label="이동할 날짜 선택">
      <div className="sched-calendar-month">
        <button type="button" aria-label="이전 달" onClick={() => setMonth(adjacentMonth(month, -1))}>‹</button>
        <select aria-label="연도" value={Number(month.slice(0, 4))} onChange={(event) => setMonth(`${event.target.value}-${month.slice(5)}`)}>
          {years.map((year) => <option key={year} value={year}>{year}년</option>)}
        </select>
        <select aria-label="월" value={month.slice(5)} onChange={(event) => setMonth(`${month.slice(0, 4)}-${event.target.value}`)}>
          {Array.from({ length: 12 }, (_, i) => <option key={i} value={String(i + 1).padStart(2, "0")}>{i + 1}월</option>)}
        </select>
        <button type="button" aria-label="다음 달" onClick={() => setMonth(adjacentMonth(month, 1))}>›</button>
      </div>
      <div className="sched-calendar-weekdays" aria-hidden="true">{["일", "월", "화", "수", "목", "금", "토"].map((day) => <span key={day}>{day}</span>)}</div>
      <div className="sched-calendar-days">
        {dates.map((date) => <button key={date} type="button" data-calendar-date={date} disabled={disabled}
          data-outside={!date.startsWith(month)} data-selected={date === value} aria-current={date === today ? "date" : undefined}
          aria-label={`${date}${date === today ? ", 오늘" : ""}${date === value ? ", 선택한 날짜" : ""}`} tabIndex={date === tabDate ? 0 : -1}
          onKeyDown={(event) => move(event, date)} onClick={() => choose(date)}>{Number(date.slice(8))}</button>)}
      </div>
    </div>}
  </div>;
}
