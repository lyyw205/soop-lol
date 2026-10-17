"use client";

import Link from "next/link";
import { useEffect, useId, useRef } from "react";
import { entryState, profileHref, slotTimeLabel, submitScheduleHref, type PublicScheduleEntry } from "@soop-lol/core/lib/contract/schedule";
import { Badges, md, weekday, timeOf } from "./content.tsx";

/** 네이티브 dialog가 포커스·Escape·배경 접근 차단을 맡는다. 원본 공지와 고유 상세 주소는 유지한다. */
export function ScheduleDialog({ entries, selected, onClose, detailHref, resultHref }: {
  entries: PublicScheduleEntry[]; selected: string | null;
  onClose: () => void;
  detailHref: (entry: PublicScheduleEntry) => string; resultHref: (entry: PublicScheduleEntry) => string | null;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const index = entries.findIndex((entry) => entry.schedule_id === selected);
  const entry = entries[index];
  const open = !!entry;

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open) {
      if (!node.open) node.showModal();
      heading.current?.focus({ preventScroll: true });
    } else if (node.open) node.close();
  }, [open, entry?.schedule_id]);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, [open]);

  return <dialog ref={dialog} className="sched-dialog" aria-labelledby={titleId} onClose={onClose}
    onClick={(event) => {
      if (event.target !== event.currentTarget) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.currentTarget.close();
    }}>
    {entry && <>
      <div className="sched-dialog-toolbar"><span>일정 상세</span><button type="button" aria-label="일정 상세 닫기" onClick={() => dialog.current?.close()}>×</button></div>
      <div className="sched-dialog-content" key={entry.schedule_id}>
        <Badges entry={entry} state={entryState(entry.status)} />
        <h2 id={titleId} tabIndex={-1} ref={heading}>{entry.title}</h2>
        {entry.description && <p className="sched-viewer-description">{entry.description}</p>}
        <section className="sched-viewer-section" aria-label="경기 일정">
          <div className="sched-viewer-section-title"><h3>경기 일정</h3><span>한국 시간 기준</span></div>
          <ul className="sched-viewer-slots">{[...entry.slots].sort((a, b) => a.on_date.localeCompare(b.on_date) || (a.starts_at ? new Date(a.starts_at).getTime() : Infinity) - (b.starts_at ? new Date(b.starts_at).getTime() : Infinity)).map((slot, i) => <li key={i}>
            <div className="sched-viewer-date"><b>{md(slot.on_date)}</b><span>{weekday(slot.on_date)}요일</span></div>
            <div className="sched-viewer-time"><b>{slotTimeLabel(timeOf(slot))}</b>{slot.label && <span>{slot.label}</span>}</div>
            {slot.channel_id && <a className="sched-viewer-watch" href={`https://ch.sooplive.co.kr/${encodeURIComponent(slot.channel_id)}`} target="_blank" rel="noreferrer" aria-label={`${md(slot.on_date)} ${slot.label ?? "경기"} 방송국 열기`}>방송국 ↗</a>}
          </li>)}</ul>
        </section>
        {entry.participants.length > 0 && <section className="sched-viewer-section" aria-label="참여 스트리머">
          <h3>참여 스트리머</h3>
          <dl className="sched-viewer-people">{([['host', '주최'], ['player', '참가'], ['caster', '중계']] as const).map(([role, label]) => {
            const people = entry.participants.filter((person) => person.role === role);
            return people.length > 0 && <div key={role}><dt>{label}</dt><dd>{people.map((person) => <span key={person.slug}>
              <Link href={profileHref(entry.game_code, person.slug)}>{person.display_name}</Link>{person.team && <small>{person.team}</small>}
            </span>)}</dd></div>;
          })}</dl>
        </section>}
        {(entry.sources.length > 0 || entry.sponsor) && <details className="sched-viewer-notices"><summary>공지 및 행사 정보</summary>
          {entry.sponsor && <p className="sched-viewer-sponsor">후원 <span>{entry.sponsor}</span></p>}
          {entry.sources.length > 0 && <ul>{entry.sources.map((source, i) => <li key={source.url}><a href={source.url} target="_blank" rel="noreferrer">{source.title ?? `행사 공지 ${i + 1}`} ↗</a></li>)}</ul>}
        </details>}
        <div className="sched-viewer-actions">{resultHref(entry) && <Link className="sched-viewer-result" href={resultHref(entry)!}>경기 결과 보기 →</Link>}
          <Link href={detailHref(entry)}>일정 페이지 열기 ↗</Link>
          {/* 틀렸거나 바뀐 일정 — 로그인한 회원이 제보하고 운영자가 확인한 뒤 반영된다. 주소는 core site-paths 한 곳. */}
          <Link className="sched-viewer-report" href={submitScheduleHref(entry.schedule_id)} prefetch={false}>제보하기</Link></div>
      </div>
    </>}
  </dialog>;
}
