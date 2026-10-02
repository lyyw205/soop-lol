"use client";

import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";

import { daysBetween } from "@soop-lol/core/lib/contract/schedule";

import { centeredScrollLeft, expandedScrollLeft, EXTEND_DAYS } from "./layout.ts";

import { bindTimelineWheel, timelineEdges } from "./scroll.ts";

/** 서버가 만든 공개 상세를 재사용한다. 일정 전환 시 조회나 페이지 이동이 없다. */
export function ScheduleExplorer({ children, timeline, panels, from, focusDate, focusRequest }: {
  from: string; focusDate: string; focusRequest: number;
  children: ReactNode;
  timeline: ReactNode;
  panels: { id: string; title: string; content: ReactNode }[];
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const main = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const index = panels.findIndex((panel) => panel.id === selected);
  const active = panels[index];
  const open = Boolean(active);
  const previous = useRef<{ from: string; request: number } | null>(null);

  useLayoutEffect(() => {
    const chart = frame.current?.querySelector<HTMLElement>(".sched-scroll");
    const day = chart?.querySelector<HTMLElement>("[data-date]");
    if (!chart || !day) return;
    const old = previous.current;
    const jump = !old || old.request !== focusRequest;
    let moved = false;
    let placed = false;
    const place = () => {
      const width = day.getBoundingClientRect().width;
      if (!width || !chart.clientWidth || moved) return;
      if (jump) {
        chart.scrollLeft = centeredScrollLeft(daysBetween(from, focusDate), width, chart.clientWidth, chart.scrollWidth, parseFloat(getComputedStyle(chart).paddingLeft) || 0);
      } else if (!placed && old.from !== from) {
        chart.scrollLeft = expandedScrollLeft(old.from, from, chart.scrollLeft, width);
      }
      placed = true;
      previous.current = { from, request: focusRequest };
    };
    // 초기 레이아웃·스크롤 복원 뒤에도 한 번 맞추되, 사용자 조작이 시작되면 중단한다.
    const stop = () => { moved = true; };
    const events = ["wheel", "pointerdown", "touchstart", "keydown"] as const;
    for (const event of events) chart.addEventListener(event, stop, { passive: true });
    place();
    if (jump) setSelected(null);
    const animation = requestAnimationFrame(place);
    const observer = new ResizeObserver(place);
    observer.observe(chart);
    observer.observe(day);
    return () => {
      cancelAnimationFrame(animation); observer.disconnect();
      for (const event of events) chart.removeEventListener(event, stop);
    };
  }, [from, focusDate, focusRequest]);


  useEffect(() => {
    for (const link of main.current?.querySelectorAll<HTMLElement>("[data-schedule-id]") ?? []) {
      link.dataset.selected = String(link.dataset.scheduleId === selected);
      link.setAttribute("aria-expanded", String(link.dataset.scheduleId === selected));
    }
  }, [selected, panels]);

  useEffect(() => {
    if (frame.current) return bindTimelineWheel(frame.current);
  }, []);

  function close() {
    setSelected(null);
    trigger.current?.focus({ preventScroll: true });
  }

  useEffect(() => {
    if (!open) return;
    heading.current?.focus({ preventScroll: true });
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSelected(null);
        trigger.current?.focus({ preventScroll: true });
      }
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [open]);

  function select(event: MouseEvent<HTMLDivElement>) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = (event.target as HTMLElement).closest<HTMLElement>("[data-schedule-id]");
    const id = link?.dataset.scheduleId;
    if (!id || !panels.some((panel) => panel.id === id)) return;
    event.preventDefault();
    trigger.current = link;
    setSelected(id);
  }

  return <div className="sched-explorer" data-open={open}>
    <div className="sched-explorer-main" ref={main} onClick={select}>
      <div className="sched-chart-frame" ref={frame}>
        {timeline}
        {active && <aside className="sched-panel" aria-label="선택한 일정 상세">
      <div className="sched-panel-toolbar">
        <span>일정 상세 · {index + 1} / {panels.length}</span>
        <button type="button" onClick={close} aria-label="상세 패널 닫기">닫기 ×</button>
      </div>
      <div className="sched-panel-scroll" key={active.id}>
        <h2 ref={heading} tabIndex={-1}>{active.title}</h2>
        {active.content}
      </div>
      <nav className="sched-panel-nav" aria-label="일정 둘러보기">
        <button type="button" disabled={index === 0} onClick={() => setSelected(panels[index - 1].id)}>← 이전 일정</button>
        <button type="button" disabled={index === panels.length - 1} onClick={() => setSelected(panels[index + 1].id)}>다음 일정 →</button>
      </nav>
        </aside>}
      </div>
      {children}
    </div>
  </div>;
}


/** 실제 스크롤 끝에서만 확장 버튼을 표시한다. 버튼 자리는 일정과 겹치지 않는다. */
export function TimelineViewport({ children, days, loading, onExpand }: {
  children: ReactNode; days: number; loading: boolean; onExpand: (direction: "previous" | "next") => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  useLayoutEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const update = () => {
      const next = timelineEdges(node.scrollLeft, node.scrollWidth, node.clientWidth);
      setEdges((old) => old.left === next.left && old.right === next.right ? old : next);
    };
    update();
    node.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(node);
    if (node.firstElementChild) observer.observe(node.firstElementChild);
    return () => { node.removeEventListener("scroll", update); observer.disconnect(); };
  }, [days]);

  return <div className="sched-viewport">
    <div ref={viewport} className="sched-scroll" tabIndex={0} role="region" aria-label={`${days}일 편성표, 좌우 끝에서 3일 더 보기`}>
      {children}
    </div>
    <div className="sched-edge-controls" aria-label="기간 확장">
      {edges.left && <button className="sched-edge-previous" type="button" disabled={loading} onClick={() => { viewport.current?.focus({ preventScroll: true }); onExpand("previous"); }}>← 이전 {EXTEND_DAYS}일 더 보기</button>}
      {edges.right && <button className="sched-edge-next" type="button" disabled={loading} onClick={() => { viewport.current?.focus({ preventScroll: true }); onExpand("next"); }}>다음 {EXTEND_DAYS}일 더 보기 →</button>}
    </div>
  </div>;
}
