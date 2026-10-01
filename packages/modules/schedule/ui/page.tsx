/**
 * 편성표 모듈 화면. host 가 로비 틀 안에서 /schedule 에 띄운다.
 *
 * ★ 상태는 **공지 기준**이고 이 화면을 렌더한 시각 기준이다. 실제 방송 상태는 보지 않는다 —
 *   그래서 LIVE 가 아니라 "공지상 진행 시간" 이고, 시간이 지난 것과 "개최 확인" 을 나눈다(metrics/schedule).
 * ★ 필터는 전부 URL(?from=&game=&scale=&s=)이다. 공유한 주소가 같은 화면을 연다. 자바스크립트 없이 동작한다.
 * ★ 넓은 화면은 위에 간트(대형 막대 + 소형 날짜 칸), 아래에 펼쳐 보는 목록. 좁은 화면은 목록만.
 */
import Link from "next/link";
import type { ReactNode } from "react";

import {
  addDays, entryState, ENTRY_STATE_LABEL, kstClock, kstDateString, kstDayStart, listPublicSchedule, profileHref,
  SCHEDULE_GAME_LABEL, SCHEDULE_GAMES, SCHEDULE_KIND_LABEL, SCHEDULE_ROLE_LABEL, SCHEDULE_SCALE_LABEL, SCHEDULE_SCALES,
  slotPhase, slotTimeLabel,
  type PublicScheduleEntry, type PublicScheduleSlot, type ScheduleGame, type ScheduleScale, type SlotPhase,
} from "@soop-lol/core/lib/contract";

import { cardsByDay, majorRows, WINDOW_DAYS, WINDOW_LEAD_DAYS, windowDays } from "./layout.ts";
import { scheduleHref } from "./paths.ts";
import "./schedule.css";

type Props = {
  searchParams: Record<string, string | string[] | undefined>;
  roleHref: (role: string, params?: Record<string, string>) => string | null;
};

export function generateMetadata() {
  return { title: "편성표" };
}

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
const WEEKDAY = ["일", "월", "화", "수", "목", "금", "토"];
const weekday = (date: string) => { const [y, m, d] = date.split("-").map(Number); return WEEKDAY[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]; };
const md = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
const SLOT_PHASE_LABEL: Record<SlotPhase, string> = { upcoming: "", in_window: "공지상 진행 시간", started: "시작 시각 지남", past: "지남" };
const channelUrl = (id: string) => `https://ch.sooplive.co.kr/${encodeURIComponent(id)}`;

export default async function SchedulePage({ searchParams, roleHref }: Props) {
  const now = new Date();
  const today = kstDateString(now);
  const fromParam = one(searchParams.from);
  const from = fromParam && kstDayStart(fromParam) ? fromParam : addDays(today, -WINDOW_LEAD_DAYS);
  const to = addDays(from, WINDOW_DAYS - 1);
  const gameParam = one(searchParams.game);
  const game = SCHEDULE_GAMES.includes(gameParam as ScheduleGame) ? (gameParam as ScheduleGame) : null;
  const scaleParam = one(searchParams.scale);
  const scale = SCHEDULE_SCALES.includes(scaleParam as ScheduleScale) ? (scaleParam as ScheduleScale) : null;
  const sParam = one(searchParams.s);
  const streamer = sParam && /^[\w.-]+$/.test(sParam) ? sParam : null;

  const entries = await listPublicSchedule({ from, to, game, scale, streamer });
  const days = windowDays(from);
  const majors = majorRows(entries.filter((e) => e.scale === "major"), from);
  const minorCards = cardsByDay(entries.filter((e) => e.scale === "minor"), days);

  // 지금 보고 있는 필터를 유지한 채 하나만 바꾼 주소.
  const current = { from: fromParam && kstDayStart(fromParam) ? fromParam : undefined, game: game ?? undefined, scale: scale ?? undefined, s: streamer ?? undefined };
  const href = (patch: Partial<typeof current>) => scheduleHref({ ...current, ...patch });

  const people = new Map<string, string>();
  for (const e of entries) for (const p of e.participants) people.set(p.slug, p.display_name);
  if (streamer && !people.has(streamer)) people.set(streamer, streamer);

  const resultHref = (e: PublicScheduleEntry) => !e.result ? null
    : e.result.page === "lol_tournament" ? roleHref("tournaments", { slug: e.result.slug }) : roleHref("fc-tournaments", { slug: e.result.slug });

  return (
    <div className="sched">
      <div className="arena-title"><div>
        <h1>편성표</h1>
        <p>스트리머가 공지한 대회·CK·이벤트전 일정입니다. 상태는 <b>공지 기준</b>이고 실제 방송 여부는 확인하지 않습니다 · {md(today)} {kstClock(now)} 기준</p>
      </div></div>

      <div className="sched-toolbar">
        <nav className="sched-week" aria-label="기간 이동">
          <Link href={href({ from: addDays(from, -7) })}>← 이전 7일</Link>
          <Link href={href({ from: undefined })} aria-current={!current.from ? "page" : undefined}>이번 주</Link>
          <Link href={href({ from: addDays(from, 7) })}>다음 7일 →</Link>
          <span className="sched-range">{md(from)} ~ {md(to)}</span>
        </nav>
        <nav className="sched-filters" aria-label="필터">
          <Chips label="게임" items={[[undefined, "전체"], ...SCHEDULE_GAMES.map((g) => [g, SCHEDULE_GAME_LABEL[g]] as const)]} active={current.game} to={(v) => href({ game: v })} />
          <Chips label="규모" items={[[undefined, "전체"], ...SCHEDULE_SCALES.map((s) => [s, SCHEDULE_SCALE_LABEL[s]] as const)]} active={current.scale} to={(v) => href({ scale: v })} />
          <form className="sched-person" action={scheduleHref()}>
            {current.from && <input type="hidden" name="from" value={current.from} />}
            {game && <input type="hidden" name="game" value={game} />}
            {scale && <input type="hidden" name="scale" value={scale} />}
            <label>스트리머 <select name="s" defaultValue={streamer ?? ""}>
              <option value="">전체</option>
              {[...people].sort((a, b) => a[1].localeCompare(b[1], "ko")).map(([slug, name]) => <option key={slug} value={slug}>{name}</option>)}
            </select></label>
            <button type="submit">적용</button>
          </form>
        </nav>
      </div>

      {entries.length === 0 ? <p className="sched-empty">이 기간에 공지된 일정이 없습니다.</p> : <>
        <section className="sched-gantt" aria-label="기간 한눈에 보기" style={{ ["--days" as string]: WINDOW_DAYS }}>
          <div className="sched-row sched-head">
            <div />
            {days.map((d) => <div key={d} className={d === today ? "is-today" : undefined}>{md(d)} <small>{weekday(d)}</small></div>)}
          </div>
          {majors.length > 0 && <div className="sched-group">대형</div>}
          {majors.map(({ entry, span, liveCols }) => {
            const state = entryState(entry.status, entry.slots.map(timeOf), now);
            return <div key={entry.schedule_id} className="sched-row">
              <div className="sched-label"><span className="sched-tag">{SCHEDULE_GAME_LABEL[entry.game_code]}</span> {entry.title}</div>
              <a href={`#m-${entry.schedule_id}`} className="sched-bar" data-state={state}
                style={{ gridColumn: `${span.start + 1} / ${span.end + 2}` }} aria-label={`${entry.title} · ${ENTRY_STATE_LABEL[state]}`}>
                {span.cutStart && <span aria-hidden="true">◀ </span>}{ENTRY_STATE_LABEL[state]}{span.cutEnd && <span aria-hidden="true"> ▶</span>}
              </a>
              {liveCols.map((c) => <span key={c} className="sched-live" style={{ gridColumn: `${c + 1}` }} aria-hidden="true" />)}
            </div>;
          })}
          <div className="sched-group">소형</div>
          <div className="sched-row sched-cells">
            <div />
            {days.map((d) => <div key={d} className={d === today ? "is-today" : undefined}>
              {minorCards.get(d)!.map(({ entry, slot }) => {
                const state = entryState(entry.status, entry.slots.map(timeOf), now);
                return <a key={`${entry.schedule_id}-${slot.on_date}-${slot.starts_at}`} href={`#c-${entry.schedule_id}-${d}`} className="sched-card" data-state={state}>
                  <small>{slot.starts_at ? kstClock(new Date(slot.starts_at)) : "시각 미정"}</small>{entry.title}
                </a>;
              })}
            </div>)}
          </div>
        </section>

        {majors.length > 0 && <section className="sched-list" aria-label="대형 행사">
          <h2>대형 행사</h2>
          {majors.map(({ entry, period }) => <EntryDetail key={entry.schedule_id} id={`m-${entry.schedule_id}`} entry={entry} now={now}
            when={period.from === period.to ? md(period.from) : `${md(period.from)} ~ ${md(period.to)}`} result={resultHref(entry)} />)}
        </section>}

        <section className="sched-list" aria-label="날짜별 일정">
          <h2>날짜별 일정</h2>
          {days.filter((d) => minorCards.get(d)!.length > 0 || majors.some((m) => m.entry.slots.some((s) => s.on_date === d))).map((d) => (
            <div key={d} className="sched-day">
              <h3 className={d === today ? "is-today" : undefined}>{md(d)} ({weekday(d)}){d === today && " · 오늘"}</h3>
              {majors.flatMap((m) => m.entry.slots.filter((s) => s.on_date === d).map((s) => (
                <a key={`${m.entry.schedule_id}-${s.on_date}-${s.starts_at}`} className="sched-major-line" href={`#m-${m.entry.schedule_id}`}>
                  <b>{slotTimeLabel(timeOf(s))}</b> {m.entry.title}{s.label && ` · ${s.label}`}
                </a>
              )))}
              {minorCards.get(d)!.map(({ entry, slot }) => <EntryDetail key={`${entry.schedule_id}-${slot.on_date}-${slot.starts_at}`}
                id={`c-${entry.schedule_id}-${d}`} entry={entry} now={now} when={slotTimeLabel(timeOf(slot))} result={resultHref(entry)} />)}
            </div>
          ))}
        </section>
      </>}
    </div>
  );
}

const timeOf = (s: PublicScheduleSlot) => ({ on_date: s.on_date, starts_at: s.starts_at ? new Date(s.starts_at) : null, ends_at: s.ends_at ? new Date(s.ends_at) : null });

function Chips<V extends string | undefined>({ label, items, active, to }: {
  label: string; items: readonly (readonly [V, string])[]; active: V; to: (v: V) => string;
}) {
  return <span className="sched-chips" role="group" aria-label={label}>
    {items.map(([v, l]) => <Link key={l} href={to(v)} aria-current={v === active ? "page" : undefined}>{l}</Link>)}
  </span>;
}

/** 펼쳐 보는 일정 하나. 칸·참가자·출처·결과를 다 보여준다(상세 화면은 후속 단계라 같은 화면에서 펼친다). */
function EntryDetail({ id, entry, now, when, result }: { id: string; entry: PublicScheduleEntry; now: Date; when: string; result: string | null }) {
  const state = entryState(entry.status, entry.slots.map(timeOf), now);
  const byRole = (role: "host" | "player" | "caster") => entry.participants.filter((p) => p.role === role);
  const peopleLine = (role: "host" | "player" | "caster"): ReactNode => {
    const list = byRole(role);
    return list.length === 0 ? null : <p><span className="sched-k">{SCHEDULE_ROLE_LABEL[role]}</span>
      {list.map((p, i) => <span key={p.slug}>{i > 0 && " · "}<Link href={profileHref(entry.game_code, p.slug)}>{p.display_name}</Link>{p.team && <small> ({p.team})</small>}</span>)}</p>;
  };
  return (
    <details id={id} className="sched-entry" data-state={state}>
      <summary>
        <span className="sched-when">{when}</span>
        <span className="sched-title">{entry.title}</span>
        <span className="sched-badges">
          <span className="sched-tag">{SCHEDULE_GAME_LABEL[entry.game_code]}</span>
          <span className="sched-tag">{SCHEDULE_KIND_LABEL[entry.planned_kind]}</span>
          {entry.scale === "minor" && state === "upcoming" && <span className="sched-tag is-notice">예고</span>}
          <span className="sched-state">{ENTRY_STATE_LABEL[state]}</span>
          {entry.origin === "manual" && <span className="sched-tag is-manual" title="사람이 공지를 보고 입력한 일정">수기</span>}
        </span>
      </summary>
      <div className="sched-body">
        {entry.description && <p>{entry.description}</p>}
        {peopleLine("host")}
        {entry.sponsor && <p><span className="sched-k">후원</span>{entry.sponsor}</p>}
        {peopleLine("player")}
        {peopleLine("caster")}
        <ul className="sched-slots">
          {entry.slots.map((s) => {
            const t = timeOf(s);
            const phase = slotPhase(t, now);
            return <li key={`${s.on_date}-${s.starts_at}`} data-phase={phase}>
              <b>{md(s.on_date)} ({weekday(s.on_date)})</b> {slotTimeLabel(t)}{s.label && ` · ${s.label}`}
              {entry.status !== "cancelled" && SLOT_PHASE_LABEL[phase] && <small> · {SLOT_PHASE_LABEL[phase]}</small>}
              {s.channel_id && <> · <a href={channelUrl(s.channel_id)} target="_blank" rel="noreferrer">방송국 {s.channel_id} ↗</a></>}
            </li>;
          })}
        </ul>
        <p className="sched-sources"><span className="sched-k">근거 공지</span>
          {entry.sources.map((s, i) => <span key={s.url}>{i > 0 && " · "}<a href={s.url} target="_blank" rel="noreferrer">{s.title ?? `공지 ${i + 1}`} ↗</a>
            {s.posted_at && <small> ({md(kstDateString(new Date(s.posted_at)))})</small>}</span>)}
        </p>
        {result && <p><Link className="sched-result" href={result}>결과 보기 →</Link></p>}
      </div>
    </details>
  );
}
