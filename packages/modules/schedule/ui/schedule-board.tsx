"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { daysBetween, kstClock, kstDayStart, SCHEDULE_GAME_LABEL, SCHEDULE_GAMES, submitScheduleHref,
  type NavigationSite, type PublicScheduleEntry, type ScheduleGame } from "@soop-lol/core/lib/contract/schedule";
import { loadScheduleWindow } from "../server/load-window.ts";
import { agendaCards, agendaEntries, agendaRange, featuredCard, type ScheduleKindFilter } from "./agenda.ts";
import { HeadlineMatch, ScheduleRow, shortDate, type SchedulePerson } from "./agenda-cards.tsx";
import { Chips, weekday, resultLink } from "./content.tsx";
import { windowDays } from "./layout.ts";
import { scheduleEntryHref, scheduleHref } from "./paths.ts";
import { adjacentMonth } from "./calendar.ts";
import { ScheduleDialog } from "./schedule-dialog.tsx";

export function ScheduleBoard({ initialEntries, initialDate, today, renderedAt, game: initialGame, streamer: initialStreamer,
  initialKind, initialSearch, people, resultRoutes, site }: {
  initialEntries: PublicScheduleEntry[]; initialDate: string; today: string; renderedAt: string;
  game: ScheduleGame | null; streamer: string | null; initialKind: ScheduleKindFilter; initialSearch: string;
  people: SchedulePerson[]; resultRoutes: Record<string, string | null>; site: NavigationSite;
}) {
  const [entries, setEntries] = useState(initialEntries);
  const [filters, setFilters] = useState({ game: initialGame, streamer: initialStreamer });
  const [date, setDate] = useState(initialDate);
  const [kind, setKind] = useState(initialKind);
  const [search, setSearch] = useState(initialSearch);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const busy = useRef(false);
  const agenda = useRef<HTMLDivElement>(null);
  const calendar = useRef<HTMLElement>(null);
  const agendaPanel = useRef<HTMLElement>(null);
  const [scrollRequest, setScrollRequest] = useState(0);
  const trigger = useRef<HTMLElement | null>(null);
  const { game, streamer } = filters;
  const range = agendaRange(date);
  const month = date.slice(0, 7);
  const days = windowDays(range.from, daysBetween(range.from, range.to) + 1);
  const visible = agendaEntries(entries, kind, search);
  const cards = agendaCards(visible, range.from, range.to);
  const agendaDays = days.filter((day) => day === date || cards.some((card) => card.slot.on_date === day));
  const feature = featuredCard(agendaCards(entries, range.from, range.to), today);
  const monthlyCount = cards.filter((card) => card.slot.on_date.startsWith(month)).length;
  const current = { site, date, game: game ?? undefined, s: streamer ?? undefined, kind: kind ?? undefined, q: search || undefined };
  const href = (patch: Partial<typeof current>) => scheduleHref({ ...current, ...patch });
  const detailHref = (entry: PublicScheduleEntry) => scheduleEntryHref(entry.schedule_id, current);
  const roleHref = (role: string, params?: Record<string, string>) => resultRoutes[role]?.replace("schedule-result-slug", encodeURIComponent(params?.slug ?? "")) ?? null;

  async function changeView(nextDate: string, nextFilters = filters) {
    if (busy.current) return;
    if (!kstDayStart(nextDate)) { setError("이동할 날짜를 선택해 주세요."); return; }
    const nextRange = agendaRange(nextDate);
    if (nextRange.from === range.from && nextFilters.game === game && nextFilters.streamer === streamer) {
      setDate(nextDate); setScrollRequest((value) => value + 1); setSelected(null); setError(""); return;
    }
    busy.current = true; setLoading(true); setError("");
    try {
      const loaded = await loadScheduleWindow({ ...nextRange, ...nextFilters });
      setEntries(loaded); setFilters(nextFilters); setDate(nextDate); setScrollRequest((value) => value + 1); setSelected(null);
    } catch { setError("일정을 불러오지 못했습니다. 다시 시도해 주세요."); }
    finally { busy.current = false; setLoading(false); }
  }

  useEffect(() => {
    const url = new URL(window.location.href);
    for (const [key, value] of Object.entries({ site, game, s: streamer, kind, q: search || null, date: date === today ? null : date })) {
      if (value) url.searchParams.set(key, value); else url.searchParams.delete(key);
    }
    url.searchParams.delete("from");
    window.history.replaceState(null, "", url);
  }, [site, game, streamer, kind, search, date, today]);

  useEffect(() => {
    const node = calendar.current;
    if (!node) return;
    const syncHeight = () => agendaPanel.current?.style.setProperty("--calendar-height", `${node.getBoundingClientRect().height}px`);
    syncHeight();
    const observer = new ResizeObserver(syncHeight);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const viewport = agenda.current;
    if (!viewport) return;
    let frame = 0;
    const stop = () => cancelAnimationFrame(frame);
    const center = (smooth: boolean) => {
      stop();
      viewport.style.setProperty("--agenda-half-height", `${viewport.clientHeight / 2}px`);
      const target = viewport.querySelector<HTMLElement>(`[data-agenda-date="${date}"]`);
      if (!target) return;
      const top = target.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop;
      const destination = Math.max(0, Math.min(viewport.scrollHeight - viewport.clientHeight,
        top - viewport.clientHeight / 2 + Math.min(target.offsetHeight, viewport.clientHeight * .7) / 2));
      const start = viewport.scrollTop;
      const distance = destination - start;
      if (!smooth || Math.abs(distance) < 1 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        viewport.scrollTop = destination;
        return;
      }
      const duration = Math.min(950, 560 + Math.sqrt(Math.abs(distance)) * 8);
      const startedAt = performance.now();
      const tick = (now: number) => {
        const progress = Math.min(1, (now - startedAt) / duration);
        // Quintic smoothstep: both velocity and acceleration settle at either end.
        const eased = progress ** 3 * (progress * (progress * 6 - 15) + 10);
        viewport.scrollTop = start + distance * eased;
        if (progress < 1) frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    };
    center(scrollRequest > 0);
    let height = viewport.clientHeight;
    const observer = new ResizeObserver(() => {
      if (viewport.clientHeight !== height) { height = viewport.clientHeight; center(false); }
    });
    observer.observe(viewport);
    const inputs = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
    for (const input of inputs) viewport.addEventListener(input, stop, { passive: true });
    return () => {
      stop(); observer.disconnect();
      for (const input of inputs) viewport.removeEventListener(input, stop);
    };
  }, [date, entries, kind, search, scrollRequest]);

  function select(event: MouseEvent<HTMLDivElement>) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = (event.target as HTMLElement).closest<HTMLElement>("[data-schedule-id]");
    const id = link?.dataset.scheduleId;
    if (!id || !entries.some((entry) => entry.schedule_id === id)) return;
    event.preventDefault(); trigger.current = link; setSelected(id);
  }

  const theme = site === "lol" ? "lol" : "fconline";
  const gameLabel = site === "platform" ? "SOOP" : site === "lol" ? "LEAGUE OF LEGENDS" : "FC ONLINE";
  return <div className="sched sched-agenda" data-theme={theme}>
    <div onClickCapture={select}>
      <section className="sched-hero">
        <div className="sched-stadium" aria-hidden="true" /><div className="sched-light-sweep" aria-hidden="true" />
        <div className="sched-container sched-hero-inner">
          <div className="sched-hero-title"><div className="sched-eyebrow"><i />{gameLabel} / SCHEDULE</div>
            <h1>편성표</h1><div className="sched-masthead" aria-hidden="true">MATCH<span>DAY.</span></div><p>대회부터 CK까지.</p>
            <Link className="sched-report-link" href={submitScheduleHref()} prefetch={false}>빠진 일정 알리기 →</Link>
            <span className="sched-hero-edition">{month.replace("-", " / ")}</span>
          </div>
          {feature ? <HeadlineMatch card={feature} people={people} href={detailHref(feature.entry)} />
            : <div className="sched-headline sched-headline-empty"><span className="sched-eyebrow">{gameLabel}</span><span className="sched-empty-date">{shortDate(date)}</span><h2>등록된 일정이 없습니다.</h2><p>다른 날짜나 필터를 선택해 보세요.</p></div>}
        </div>
      </section>

      <div className="sched-container sched-content">
        <div className="sched-filters">
          <Chips label="게임" items={[[undefined, "전체"], ...SCHEDULE_GAMES.map((g) => [g, SCHEDULE_GAME_LABEL[g]] as const)]}
            active={current.game} to={(value) => href({ game: value })} onSelect={(value) => { void changeView(date, { ...filters, game: value ?? null }); }} />
          <span className="sched-filter-divider" />
          <Chips label="일정 유형" items={[[undefined, "전체 일정"], ["tournament", "대회"], ["ck", "CK"]] as const}
            active={kind ?? undefined} to={(value) => href({ kind: value })} onSelect={(value) => { setKind(value ?? null); setSelected(null); }} />
          <div className="sched-search-tools"><label className="sched-person"><span>스트리머</span>
            <select aria-label="스트리머 필터" value={streamer ?? ""} disabled={loading} onChange={(event) => { void changeView(date, { ...filters, streamer: event.target.value || null }); }}>
              <option value="">전체</option>{streamer && !people.some((p) => p.slug === streamer) && <option value={streamer}>{streamer}</option>}
              {people.map((person) => <option key={person.slug} value={person.slug}>{person.display_name}</option>)}
            </select></label>
            <label className="sched-search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="10" cy="10" r="6.5" /><path d="m15 15 5 5" /></svg>
              <input aria-label="일정·참가자 검색" type="search" maxLength={100} placeholder="일정 · 참가자 검색" value={search}
                onChange={(event) => { setSearch(event.target.value); setSelected(null); }} /></label>
          </div>
        </div>
        <div className="sched-feedback" aria-live="polite">{loading && <span>일정을 불러오는 중…</span>}{error && <p role="alert">{error}</p>}</div>

        <div className="sched-main-grid" aria-busy={loading}>
          <section ref={calendar} className="sched-month-panel" aria-label="월간 캘린더">
            <div className="sched-month-heading"><div><h2>{month.slice(0, 4)}년 {Number(month.slice(5))}월</h2><span>이번 달 일정 {monthlyCount}개</span></div>
              <nav aria-label="월 이동"><button type="button" disabled={loading} aria-label="이전 달" onClick={() => void changeView(`${adjacentMonth(month, -1)}-01`)}>‹</button>
                <button type="button" disabled={loading} onClick={() => void changeView(today)}>오늘</button>
                <button type="button" disabled={loading} aria-label="다음 달" onClick={() => void changeView(`${adjacentMonth(month, 1)}-01`)}>›</button></nav>
            </div>
            <a className="sched-calendar-skip" href="#schedule-day">선택한 날짜 일정으로 이동</a>
            <div className="sched-month-weekdays" aria-hidden="true">{["월", "화", "수", "목", "금", "토", "일"].map((day) => <span key={day}>{day}</span>)}</div>
            <nav className="sched-month-days" aria-label="월간 날짜 선택">{days.map((day) => {
              const matches = cards.filter((card) => card.slot.on_date === day);
              return <Link key={day} href={href({ date: day })} aria-current={day === date ? "date" : undefined}
                data-outside={!day.startsWith(month)} data-today={day === today} data-past={day < today} aria-disabled={loading}
                aria-label={`${Number(day.slice(5, 7))}월 ${Number(day.slice(-2))}일 ${weekday(day)}요일${day === today ? ", 오늘" : ""}, 일정 ${matches.length}개`}
                onClick={(event) => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); void changeView(day); }}>
                <span className="sched-month-day-number"><b>{Number(day.slice(-2))}</b>{day === today && <small>오늘</small>}</span>
                <span className="sched-month-dots" aria-hidden="true">{matches.map((card, i) => <i key={i} />)}</span>
              </Link>;
            })}</nav>
            <p className="sched-month-hint">점 하나당 일정 1개 · 날짜를 선택하면 목록이 이동합니다.</p>
          </section>
          <section ref={agendaPanel} id="schedule-day" className="sched-day-panel" tabIndex={-1} aria-label="날짜순 전체 일정">
            <div className="sched-section-heading"><h2>전체 일정</h2><span>{cards.length}개 · 날짜순</span></div>
            <div className="sched-agenda-scroll" ref={agenda} tabIndex={0} role="region" aria-label="전체 일정 목록, 위아래로 스크롤">
              {agendaDays.map((day) => {
                const matches = cards.filter((card) => card.slot.on_date === day);
                return <section key={day} className="sched-agenda-day" data-agenda-date={day} data-selected={day === date} aria-label={`${shortDate(day)} 일정`}>
                  <div className="sched-agenda-day-heading"><h3>{shortDate(day)} <small>{weekday(day)}요일{day === today && " · 오늘"}</small></h3><span>{matches.length}개</span></div>
                  {matches.length ? <div className="sched-agenda-rows">{matches.map((card, i) => <ScheduleRow key={`${card.entry.schedule_id}-${i}`} card={card} people={people} href={detailHref(card.entry)} />)}</div>
                    : <p className="sched-agenda-no-events">이날 등록된 일정이 없습니다.</p>}
                </section>;
              })}
            </div>
            <span className="sched-scroll-status" role="status">{shortDate(date)} 일정 위치로 이동</span>
          </section>
        </div>
        <div className="sched-footnote"><span>공지 기준 · 한국 시간</span><span>{shortDate(today)} {kstClock(new Date(renderedAt))} 확인</span></div>
      </div>
    </div>
    <ScheduleDialog entries={entries} selected={selected} detailHref={detailHref}
      resultHref={(entry) => resultLink(entry, roleHref)} onClose={() => { setSelected(null); trigger.current?.focus({ preventScroll: true }); }} />
  </div>;
}
