"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { addDays, daysBetween, entryState, ENTRY_STATE_LABEL, kstClock, kstDayStart, SCHEDULE_GAME_LABEL, SCHEDULE_GAMES, SCHEDULE_KIND_LABEL, slotTimeLabel, type PublicScheduleEntry, type ScheduleGame } from "@soop-lol/core/lib/contract/schedule";
import { loadScheduleWindow } from "../server/load-window.ts";
import { cardsByDay, timelineLanes, majorRows, DAY_WIDTH, EXTEND_DAYS, WINDOW_DAYS, WINDOW_LEAD_DAYS, windowDays, mergeScheduleEntries, isMultiDay } from "./layout.ts";
import { Badges, EntryBody, EntryDetail, Chips, timeOf, md, weekday, resultLink } from "./content.tsx";
import { scheduleEntryHref, scheduleHref } from "./paths.ts";
import { ScheduleDatePicker } from "./date-picker.tsx";
import { ScheduleExplorer, TimelineViewport } from "./schedule-explorer.tsx";

export function ScheduleBoard({ initialEntries, initialFrom, today, renderedAt, game: initialGame, streamer: initialStreamer, resultRoutes }: {
  initialEntries: PublicScheduleEntry[]; initialFrom: string; today: string; renderedAt: string;
  game: ScheduleGame | null; streamer: string | null;
  resultRoutes: Record<string, string | null>;
}) {
  const [entries, setEntries] = useState(initialEntries);
  const [filters, setFilters] = useState({ game: initialGame, streamer: initialStreamer });
  const { game, streamer } = filters;
  const [range, setRange] = useState({ from: initialFrom, to: addDays(initialFrom, WINDOW_DAYS - 1) });
  const { from, to } = range;
  const [focus, setFocus] = useState({ date: addDays(initialFrom, WINDOW_LEAD_DAYS), request: 0 });
  const [loading, setLoading] = useState(false);
  const busy = useRef(false);
  const [error, setError] = useState("");
  const now = new Date(renderedAt);
  const days = windowDays(from, daysBetween(from, to) + 1);
  const { bars, laneCount } = timelineLanes(entries, from, days.length, 2);
  // 아래 목록: 여러 날 행사는 행사 단위로, 하루 일정은 날짜 칸에. 규모를 사람이 고르지 않고 칸 날짜로 가른다.
  const majors = majorRows(entries.filter(isMultiDay), from, days.length);
  const minorCards = cardsByDay(entries.filter((e) => !isMultiDay(e)), days);
  const roleHref = (role: string, params?: Record<string, string>) => resultRoutes[role]?.replace("schedule-result-slug", encodeURIComponent(params?.slug ?? "")) ?? null;

  async function navigate(direction: "previous" | "next" | "date", date = focus.date) {
    if (busy.current) return;
    if (direction === "date" && !kstDayStart(date)) { setError("이동할 날짜를 선택해 주세요."); return; }
    if (direction === "date" && date >= from && date <= to) {
      setFocus((v) => ({ date, request: v.request + 1 }));
      return;
    }
    busy.current = true; setLoading(true); setError("");
    const start = direction === "previous" ? addDays(from, -EXTEND_DAYS) : direction === "next" ? addDays(to, 1) : addDays(date, -WINDOW_LEAD_DAYS);
    const end = addDays(start, direction === "date" ? WINDOW_DAYS - 1 : EXTEND_DAYS - 1);
    try {
      const added = await loadScheduleWindow({ from: start, to: end, game, streamer });
      setEntries((old) => direction === "date" ? added : mergeScheduleEntries(old, added));
      setRange(direction === "date" ? { from: start, to: end } : { from: direction === "previous" ? start : from, to: direction === "next" ? end : to });
      if (direction === "date") {
        setFocus((v) => ({ date, request: v.request + 1 }));
      }
    } catch { setError("일정을 불러오지 못했습니다. 기존 일정은 유지됩니다. 다시 시도해 주세요."); }
    finally { busy.current = false; setLoading(false); }
  }
  async function changeFilters(next: typeof filters) {
    if (busy.current) return;
    busy.current = true; setLoading(true); setError("");
    try {
      let filtered: PublicScheduleEntry[] = [];
      for (let start = from; start <= to; start = addDays(start, WINDOW_DAYS)) {
        const end = addDays(start, WINDOW_DAYS - 1);
        filtered = mergeScheduleEntries(filtered, await loadScheduleWindow({ from: start, to: end < to ? end : to, ...next }));
      }
      setEntries(filtered); setFilters(next);
    } catch { setError("필터를 적용하지 못했습니다. 기존 일정은 유지됩니다. 다시 시도해 주세요."); }
    finally { busy.current = false; setLoading(false); }
  }

  // 지금 보고 있는 필터를 유지한 채 하나만 바꾼 주소.
  const current = { date: focus.date, game: game ?? undefined, s: streamer ?? undefined };
  const href = (patch: Partial<typeof current>) => scheduleHref({ ...current, ...patch });

  const people = new Map<string, string>();
  for (const e of entries) for (const p of e.participants) people.set(p.slug, p.display_name);
  if (streamer && !people.has(streamer)) people.set(streamer, streamer);

  useEffect(() => {
    const url = new URL(window.location.href);
    for (const [key, value] of Object.entries({ game, s: streamer })) {
      if (value) url.searchParams.set(key, value); else url.searchParams.delete(key);
    }
    // 기본 URL은 매번 오늘로 열린다. 직접 선택한 날짜만 주소에 보존한다.
    url.searchParams.delete("from");
    if (focus.date === today) url.searchParams.delete("date");
    else url.searchParams.set("date", focus.date);
    window.history.replaceState(null, "", url);
  }, [game, streamer, focus.date, today]);

  const resultHref = (e: PublicScheduleEntry) => resultLink(e, roleHref);

  return (
    <div className="sched" style={{ ["--day-width" as string]: `${DAY_WIDTH}px`, ["--initial-center" as string]: `${(WINDOW_LEAD_DAYS + 0.5) * DAY_WIDTH}px` }}>
      <header className="sched-heading">
        <div><h1>편성표</h1><p>스트리머가 공지한 대회와 CK 일정을 모았습니다.</p></div>
        <span className="sched-updated">{md(today)} {kstClock(now)} 기준 · 한국 시간</span>
      </header>

      <div className="sched-toolbar">
        <nav className="sched-week" aria-label="날짜 이동">
          <ScheduleDatePicker value={focus.date} today={today} disabled={loading} onSelect={(date) => { void navigate("date", date); }} />
          <button type="button" disabled={loading} onClick={() => navigate("date", today)}>오늘</button>
          {loading && <span className="sched-load-status" role="status">일정을 불러오는 중…</span>}
        </nav>
        <nav className="sched-filters" aria-label="필터">
          <Chips label="게임" items={[[undefined, "전체"], ...SCHEDULE_GAMES.map((g) => [g, SCHEDULE_GAME_LABEL[g]] as const)]} active={current.game} to={(v) => href({ game: v })} onSelect={(v) => { void changeFilters({ ...filters, game: v ?? null }); }} />
          <form className="sched-person" action={scheduleHref()} onSubmit={(event) => { event.preventDefault(); const slug = new FormData(event.currentTarget).get("s"); void changeFilters({ ...filters, streamer: typeof slug === "string" && slug ? slug : null }); }}>
            <input type="hidden" name="date" value={current.date} />
            {game && <input type="hidden" name="game" value={game} />}
            <label>스트리머 <select name="s" key={streamer ?? "all"} defaultValue={streamer ?? ""}>
              <option value="">전체</option>
              {[...people].sort((a, b) => a[1].localeCompare(b[1], "ko")).map(([slug, name]) => <option key={slug} value={slug}>{name}</option>)}
            </select></label>
            <button type="submit" disabled={loading}>적용</button>
          </form>
        </nav>
      </div>

      {error && <p className="sched-load-error" role="alert">{error}</p>}
      <ScheduleExplorer from={from} focusDate={focus.date} focusRequest={focus.request} panels={entries.map((entry) => ({
        id: entry.schedule_id, title: entry.title,
        content: <><div className="sched-panel-badges"><Badges entry={entry} state={entryState(entry.status)} /></div>
          <div className="sched-body"><EntryBody entry={entry} result={resultHref(entry)} sourcesByTime />
            <p><Link href={scheduleEntryHref(entry.schedule_id)}>고유 페이지 · 변경 이력 보기 ↗</Link></p>
          </div></>,
      }))} timeline={
        <section className="sched-timeline" aria-label="경기 편성표">
          <div className="sched-timeline-heading">
            <h2>{from.slice(0, 4)}년 {md(from)} — {md(to)} <span>일정 {entries.length}개</span></h2>
            <div className="sched-legend"><span><i className="sched-legend-bar" />행사 기간</span><span><i className="sched-legend-dot" />공지된 경기일</span></div>
          </div>
          <div className="sched-status-legend" aria-label="막대 색상별 상태">
            {Object.entries(ENTRY_STATE_LABEL).map(([state, label]) => <span key={state} data-state={state}><i aria-hidden="true" />{label}</span>)}
          </div>
          <TimelineViewport days={days.length} loading={loading} onExpand={(direction) => { void navigate(direction); }}>
            <div className="sched-gantt" style={{ ["--days" as string]: days.length }}>
              <div className="sched-row sched-head">
                {days.map((d) => <div key={d} data-date={d} className={d === today ? "is-today" : undefined} data-weekend={weekday(d) === "토" || weekday(d) === "일"}>
                  <small>{d === today ? "오늘" : weekday(d)}</small><b>{md(d)}</b>
                </div>)}
              </div>
                  <div className="sched-tracks" style={{ gridTemplateRows: `repeat(${laneCount}, minmax(88px, auto))` }}>
                    {days.map((d, i) => <div key={d} className={`sched-grid-day${d === today ? " is-today" : ""}`}
                      style={{ gridColumn: i + 1, gridRow: "1 / -1" }} aria-hidden="true" />)}
                    {bars.length === 0 && <p className="sched-track-empty">이 기간에 공지된 일정이 없습니다</p>}
                    {bars.map(({ entry, period, span, displaySpan, liveCols, lane }) => {
                      const state = entryState(entry.status);
                      const dates = period.from === period.to ? md(period.from) : `${md(period.from)} – ${md(period.to)}`;
                      const singleSlot = entry.slots.length === 1 ? entry.slots[0] : null;
                      const when = singleSlot ? `${dates} · ${slotTimeLabel(timeOf(singleSlot))}` : dates;
                      return <a key={entry.schedule_id} href={scheduleEntryHref(entry.schedule_id)} className="sched-event" data-state={state} data-schedule-id={entry.schedule_id}
                        aria-label={`${SCHEDULE_GAME_LABEL[entry.game_code]} · ${entry.title} · ${when} · ${ENTRY_STATE_LABEL[state]}`} title={ENTRY_STATE_LABEL[state]}
                        style={{ gridColumn: `${displaySpan.start} / ${displaySpan.end + 1}`, gridRow: lane + 1,
                          gridTemplateColumns: `repeat(${displaySpan.end - displaySpan.start + 1}, minmax(0, 1fr))` }}>
                        <span className="sched-event-copy"><span className="sched-event-meta">{SCHEDULE_KIND_LABEL[entry.planned_kind]} · {when}</span>
                          <span className="sched-event-title">{entry.title}</span></span>
                        <span className="sched-period" data-cut-start={span.cutStart} data-cut-end={span.cutEnd}
                          style={{ gridColumn: `${span.start - displaySpan.start + 1} / ${span.end - displaySpan.start + 2}`,
                            gridTemplateColumns: `repeat(${span.end - span.start + 1}, minmax(0, 1fr))` }} aria-hidden="true">
                          <span className="sched-period-game">{entry.game_code === "lol" ? "LOL" : "FC"}</span>
                          {liveCols.map((c) => <i key={c} style={{ gridColumn: c - span.start + 1 }} />)}
                        </span>
                      </a>;
                    })}
                  </div>
            </div>
          </TimelineViewport>
          <div className="sched-timeline-footer"><span>일정을 누르면 옆 패널에서 상세를 볼 수 있습니다.</span><span>상태는 관리자가 확인해 반영합니다.</span></div>
        </section>
      }>
        {majors.length > 0 && <section className="sched-list" aria-label="여러 날 행사">
          <h2>여러 날 행사</h2>
          {majors.map(({ entry, period }) => <EntryDetail key={entry.schedule_id} id={`m-${entry.schedule_id}`} entry={entry}
            when={period.from === period.to ? md(period.from) : `${md(period.from)} ~ ${md(period.to)}`} result={resultHref(entry)} />)}
        </section>}

        {entries.length > 0 && <section className="sched-list" aria-label="날짜별 일정">
          <h2>날짜별 일정</h2>
          {days.filter((d) => minorCards.get(d)!.length > 0 || majors.some((m) => m.entry.slots.some((s) => s.on_date === d))).map((d) => (
            <div key={d} className="sched-day">
              <h3 className={d === today ? "is-today" : undefined}>{md(d)} ({weekday(d)}){d === today && " · 오늘"}</h3>
              {majors.flatMap((m) => m.entry.slots.filter((s) => s.on_date === d).map((s) => (
                <a key={`${m.entry.schedule_id}-${s.on_date}-${s.starts_at}`} className="sched-major-line" data-schedule-id={m.entry.schedule_id} href={`#m-${m.entry.schedule_id}`}>
                  <b>{slotTimeLabel(timeOf(s))}</b> {m.entry.title}{s.label && ` · ${s.label}`}
                </a>
              )))}
              {minorCards.get(d)!.map(({ entry, slot }) => <EntryDetail key={`${entry.schedule_id}-${slot.on_date}-${slot.starts_at}`}
                id={`c-${entry.schedule_id}-${d}`} entry={entry} when={slotTimeLabel(timeOf(slot))} result={resultHref(entry)} />)}
            </div>
          ))}
        </section>}
      </ScheduleExplorer>
    </div>
  );
}
