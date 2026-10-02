import Link from "next/link";
import type { ReactNode } from "react";
import { entryState, ENTRY_STATE_LABEL, kstClock, kstDateString, profileHref, SCHEDULE_GAME_LABEL, SCHEDULE_KIND_LABEL, SCHEDULE_ROLE_LABEL, slotTimeLabel, type PublicScheduleEntry, type PublicScheduleSlot } from "@soop-lol/core/lib/contract/schedule";
import { scheduleEntryHref } from "./paths.ts";
export type RoleHref = (role: string, params?: Record<string, string>) => string | null;
const WEEKDAY = ["일", "월", "화", "수", "목", "금", "토"];
export const weekday = (date: string) => { const [y, m, d] = date.split("-").map(Number); return WEEKDAY[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]; };
export const md = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
const channelUrl = (id: string) => `https://ch.sooplive.co.kr/${encodeURIComponent(id)}`;

export const timeOf = (s: PublicScheduleSlot) => ({ on_date: s.on_date, starts_at: s.starts_at ? new Date(s.starts_at) : null, ends_at: s.ends_at ? new Date(s.ends_at) : null });

export function Chips<V extends string | undefined>({ label, items, active, to, onSelect }: {
  label: string; items: readonly (readonly [V, string])[]; active: V; to: (v: V) => string; onSelect?: (v: V) => void;
}) {
  return <span className="sched-chips" role="group" aria-label={label}>
    {items.map(([v, l]) => <Link key={l} href={to(v)} onClick={(event) => {
      if (!onSelect || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); onSelect(v);
    }} aria-current={v === active ? "page" : undefined}>{l}</Link>)}
  </span>;
}

/** 결과 상세 주소 — 열리는 상세가 있고(core 가 판정) 그 역할의 모듈이 있을 때만. */
export function resultLink(e: PublicScheduleEntry, roleHref: RoleHref): string | null {
  if (!e.result) return null;
  return e.result.page === "lol_tournament" ? roleHref("tournaments", { slug: e.result.slug }) : roleHref("fc-tournaments", { slug: e.result.slug });
}

/** 제목 옆 뱃지 — 목록과 상세가 같은 것을 쓴다. */
export function Badges({ entry, state }: { entry: PublicScheduleEntry; state: ReturnType<typeof entryState> }) {
  return <span className="sched-badges">
    <span className="sched-tag">{SCHEDULE_GAME_LABEL[entry.game_code]}</span>
    <span className="sched-tag">{SCHEDULE_KIND_LABEL[entry.planned_kind]}</span>
    {entry.slots_changed_at && state !== "cancelled" && <span className="sched-tag is-changed" title="공지 뒤 날짜·시각이 바뀌었습니다">일정 변경</span>}
    <span className="sched-state">{ENTRY_STATE_LABEL[state]}</span>
  </span>;
}

/** 일정 본문 — 사람·칸·공지·결과. 목록의 펼침과 상세 화면이 같은 것을 쓴다. */
export function EntryBody({ entry, result, sourcesByTime = false }: { entry: PublicScheduleEntry; result: string | null; sourcesByTime?: boolean }) {
  const byRole = (role: "host" | "player" | "caster") => entry.participants.filter((p) => p.role === role);
  const peopleLine = (role: "host" | "player" | "caster"): ReactNode => {
    const list = byRole(role);
    return list.length === 0 ? null : <p><span className="sched-k">{SCHEDULE_ROLE_LABEL[role]}</span>
      {list.map((p, i) => <span key={p.slug}>{i > 0 && " · "}<Link href={profileHref(entry.game_code, p.slug)}>{p.display_name}</Link>{p.team && <small> ({p.team})</small>}</span>)}</p>;
  };
  // 상세에서는 공지를 작성 시각순으로 — 공지만 따라 읽어도 행사가 어떻게 흘러갔는지 보인다.
  const sources = sourcesByTime
    ? [...entry.sources].sort((a, b) => (a.posted_at ? new Date(a.posted_at).getTime() : Infinity) - (b.posted_at ? new Date(b.posted_at).getTime() : Infinity))
    : entry.sources;
  return <>
    {entry.description && <p>{entry.description}</p>}
    {peopleLine("host")}
    {entry.sponsor && <p><span className="sched-k">후원</span>{entry.sponsor}</p>}
    {peopleLine("player")}
    {peopleLine("caster")}
    <ul className="sched-slots">
      {entry.slots.map((s) => {
        const t = timeOf(s);
        return <li key={`${s.on_date}-${s.starts_at}`}>
          <b>{md(s.on_date)} ({weekday(s.on_date)})</b> {slotTimeLabel(t)}{s.label && ` · ${s.label}`}
          {s.channel_id && <> · <a href={channelUrl(s.channel_id)} target="_blank" rel="noreferrer">방송국 {s.channel_id} ↗</a></>}
        </li>;
      })}
    </ul>
    {sourcesByTime ? <div className="sched-sources-list"><span className="sched-k">근거 공지</span>
      <ol>{sources.map((s, i) => <li key={s.url}>
        <small className="tabular">{s.posted_at ? `${md(kstDateString(new Date(s.posted_at)))} ${kstClock(new Date(s.posted_at))}` : "작성 시각 모름"}</small>{" "}
        <a href={s.url} target="_blank" rel="noreferrer">{s.title ?? `공지 ${i + 1}`} ↗</a></li>)}</ol>
    </div> : <p className="sched-sources"><span className="sched-k">근거 공지</span>
      {sources.map((s, i) => <span key={s.url}>{i > 0 && " · "}<a href={s.url} target="_blank" rel="noreferrer">{s.title ?? `공지 ${i + 1}`} ↗</a>
        {s.posted_at && <small> ({md(kstDateString(new Date(s.posted_at)))})</small>}</span>)}
    </p>}
    {result && <p><Link className="sched-result" href={result}>결과 보기 →</Link></p>}
  </>;
}

/** 펼쳐 보는 일정 하나(목록). */
export function EntryDetail({ id, entry, when, result }: { id: string; entry: PublicScheduleEntry; when: string; result: string | null }) {
  const state = entryState(entry.status);
  return (
    <details id={id} className="sched-entry" data-state={state}>
      <summary>
        <span className="sched-when">{when}</span>
        <span className="sched-title">{entry.title}</span>
        <Badges entry={entry} state={state} />
      </summary>
      <div className="sched-body">
        <EntryBody entry={entry} result={result} />
        <p><Link data-schedule-id={entry.schedule_id} href={scheduleEntryHref(entry.schedule_id)}>옆 패널에서 상세 보기 →</Link></p>
      </div>
    </details>
  );
}

