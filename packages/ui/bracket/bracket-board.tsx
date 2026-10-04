"use client";
/**
 * 대진표. 줄(lane)마다 띠를 하나 두고, 칸의 가로 위치는 화살표 깊이(모든 줄이 같은 열을 쓴다)다.
 * 연결선은 화살표(event_route)에서 그린다 — 승자 실선, 패자 점선. 대회마다 그림 코드를 짜지 않는다.
 * 모델은 bracket-model.ts 가 만든다. 강조색은 부모가 --bk-accent 로 준다(롤 주황 · FC 초록).
 */
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Avatar } from "../avatar.tsx";
import type { BoardModel, BoardSlot } from "./bracket-model.ts";
import "./bracket.css";

function SlotCard({ slot, onSelect, focus }: { slot: BoardSlot; onSelect?: (slot: BoardSlot) => void; focus: string | null }) {
  const inPath = focus != null && slot.sides.some((side) => side.entrant?.id === focus);
  const tone = focus == null ? "" : inPath ? " bk-slot-focus" : " bk-slot-dim";
  const body = <>
    <span className="bk-slot-head"><b>{slot.title}</b></span>
    {slot.sides.map((side, i) => <span key={i} className={`bk-side ${side.won ? "bk-side-won" : ""} ${!side.entrant ? "bk-side-unknown" : ""} ${focus && side.entrant?.id === focus ? "bk-side-focus" : ""}`}>
      {side.entrant
        ? <span className="bk-face"><Avatar name={side.entrant.name} src={side.entrant.image} channelId={side.entrant.channelId} /></span>
        : <span className="bk-face bk-face-empty" aria-hidden="true">?</span>}
      <span className="bk-name">{side.entrant?.name ?? "미정"}</span>
      {slot.kind === "selection"
        ? side.won && <i className="bk-pick">선택</i>
        : <strong>{side.score ?? (side.won ? "W" : "")}{side.shootout != null && <small className="bk-pk" title="승부차기">({side.shootout})</small>}</strong>}
    </span>)}
    {(slot.badge || (slot.bestOf && slot.bestOf > 1) || slot.loserRank || slot.sides.some((x) => x.shootout != null)) && <span className="bk-slot-foot">
      {slot.badge && <em data-badge={slot.badge}>{slot.badge}</em>}
      {slot.sides.some((x) => x.shootout != null) && <small>승부차기</small>}
      {slot.bestOf && slot.bestOf > 1 && <small>BO{slot.bestOf}</small>}
      {slot.loserRank && <span>패자 {slot.loserRank}</span>}
    </span>}
  </>;
  if (onSelect && slot.games) return <button type="button" className={`bk-slot${tone}`} data-slot={slot.id} title={slot.evidence} onClick={() => onSelect(slot)}>{body}</button>;
  return slot.href
    ? <Link className={`bk-slot${tone}`} href={slot.href} data-slot={slot.id} title={slot.evidence}>{body}</Link>
    : <div className={`bk-slot bk-slot-static${tone}`} data-slot={slot.id} title={slot.evidence}>{body}</div>;
}

interface PathStep { slot: BoardSlot; result: "승" | "패" | "선택" | "탈락" | "?" }

/** 한 참가 단위가 거친 칸들(경기 순서 = 화살표 깊이 → 번호)과 각 칸의 결과. */
function pathOf(model: BoardModel, entrant: string): PathStep[] {
  return model.lanes.flatMap((l) => l.slots)
    .filter((s) => s.sides.some((side) => side.entrant?.id === entrant))
    .sort((a, b) => a.depth - b.depth || a.no - b.no)
    .map((slot) => {
      const me = slot.sides.find((side) => side.entrant?.id === entrant)!;
      const decided = slot.sides.some((side) => side.won);
      const result = !decided ? "?" : slot.kind === "selection" ? (me.won ? "선택" : "탈락") : me.won ? "승" : "패";
      return { slot, result };
    });
}

/** 그 참가 단위가 실제로 지나간 화살표: 출발 칸에서 이긴(진) 쪽으로 나가 도착 칸에 들어간 선. */
function travels(slots: Map<string, BoardSlot>, entrant: string, edge: BoardModel["edges"][number]): boolean {
  const from = slots.get(edge.from), to = slots.get(edge.to);
  const me = from?.sides.find((side) => side.entrant?.id === entrant);
  if (!me || !to?.sides.some((side) => side.entrant?.id === entrant)) return false;
  return edge.outcome === "winner" ? me.won : !me.won;
}

/** 경로의 승·무·패 합계. 결과를 모르는 칸은 따로 센다(추론한 결과는 결과로 센다 — 단계에 점선 표시가 붙는다). */
function record(path: PathStep[]) {
  const n = (r: PathStep["result"]) => path.filter((x) => x.result === r).length;
  return { win: n("승") + n("선택"), draw: 0, loss: n("패") + n("탈락"), pending: n("?") };
}

const MIN_SCALE = 0.25;
const MAX_SCALE = 1.6;
/** 대진표 창의 최대 높이. 대진표가 이보다 낮으면 창도 그만큼만 쓴다. */
const MAX_FRAME = 680;
const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

/**
 * 지도처럼 본다: 기본은 카드 원래 크기(100%), 끌어서 상하좌우 이동, 휠로 커서 기준 확대·축소.
 * 「한눈에」 는 대진표 전체가 창에 들어오게 줄인다. onSelect 를 주면 칸을 누를 때 주소 대신 그 함수를 부른다(롤: 세트 상세 팝업).
 */
export function BracketBoard({ model, showLoserLines = true, onSelect }: {
  model: BoardModel; showLoserLines?: boolean; onSelect?: (slot: BoardSlot) => void;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const board = useRef<HTMLDivElement>(null);
  const [paths, setPaths] = useState<{ d: string; outcome: "winner" | "loser"; key: string; travelers: string[]; focus?: string }[]>([]);
  // 대진표의 원래(100%) 크기와 창 크기
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [frameW, setFrameW] = useState(0);
  const [loser, setLoser] = useState(showLoserLines);
  const [view, setView] = useState({ x: 0, y: 0, s: 1 });
  // 참가자 필터: 고른 참가 단위가 없는 칸·선을 흐리게
  const [focus, setFocus] = useState<string | null>(null);
  const people = model.placements.map((p) => p.entrant);
  const path = focus ? pathOf(model, focus) : [];
  const focusPlace = focus ? model.placements.find((p) => p.entrant.id === focus) : null;
  const focusPerson = focusPlace?.entrant ?? null;
  const tally = record(path);
  const viewRef = useRef(view);
  viewRef.current = view;
  const frameH = size.h ? Math.min(size.h + 24, MAX_FRAME) : MAX_FRAME;

  /** 대진표가 창 밖으로 다 나가지 않게 위치를 묶는다. 창보다 작으면 가운데(가로)·위(세로)에 둔다. */
  const clampView = (v: { x: number; y: number; s: number }) => {
    // 경로 패널이 하단에 떠 있으면 그 높이만큼 더 끌어올릴 수 있어야 맨 아래 칸이 가려지지 않는다
    const w = size.w * v.s, h = size.h * v.s, pad = 40, bottom = focus ? 110 : pad;
    const x = w + pad * 2 <= frameW ? (frameW - w) / 2 : Math.min(pad, Math.max(frameW - w - pad, v.x));
    const y = h + bottom <= frameH ? 12 : Math.min(pad, Math.max(frameH - h - bottom, v.y));
    return { x, y, s: v.s };
  };
  const zoomAt = (factor: number, cx: number, cy: number) => setView((v) => {
    const s = clampScale(v.s * factor);
    return clampView({ s, x: cx - (cx - v.x) * (s / v.s), y: cy - (cy - v.y) * (s / v.s) });
  });
  const zoomCenter = (factor: number) => zoomAt(factor, frameW / 2, frameH / 2);
  const fit = () => {
    if (!size.w || !frameW) return;
    const s = clampScale(Math.min((frameW - 32) / size.w, (frameH - 24) / size.h, 1));
    setView(clampView({ s, x: 0, y: 0 }));
  };
  const actual = () => setView(clampView({ s: 1, x: 16, y: 12 }));

  // 선은 대진표 원래 좌표로 그린다(확대·축소는 대진표 전체에 transform 으로 건다)
  useEffect(() => {
    const el = board.current, fr = frame.current;
    if (!el || !fr) return;
    const draw = () => {
      const s = viewRef.current.s;
      const box = el.getBoundingClientRect();
      const at = (id: string) => el.querySelector<HTMLElement>(`[data-slot="${CSS.escape(id)}"]`)?.getBoundingClientRect();
      const bySlot = new Map(model.lanes.flatMap((l) => l.slots).map((x) => [x.id, x]));
      const next = model.edges.flatMap((e) => {
        const a = at(e.from), b = at(e.to);
        if (!a || !b) return [];
        const x1 = (a.right - box.left) / s, y1 = (a.top + a.height / 2 - box.top) / s;
        const x2 = (b.left - box.left) / s, y2 = (b.top + b.height / 2 - box.top) / s;
        // 같은 열이거나 뒤로 가는 선(드물다)은 옆으로 돌아간다
        const mid = x2 > x1 + 8 ? (x1 + x2) / 2 : x1 + 12;
        const travelers = model.placements.map((p) => p.entrant.id).filter((id) => travels(bySlot, id, e));
        return [{ d: `M${x1},${y1} H${mid} V${y2} H${x2}`, outcome: e.outcome, key: `${e.from}-${e.outcome}`, travelers }];
      });
      setPaths(next);
      setSize({ w: el.offsetWidth, h: el.offsetHeight });
      setFrameW(fr.clientWidth);
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(el);
    observer.observe(fr);
    return () => observer.disconnect();
  }, [model]);

  // 참가자를 고르면 하이라이트만 한다 — 보던 위치·배율은 그대로 둔다
  const showPath = (entrant: string | null) => setFocus(entrant);

  // 크기를 처음 알면(또는 창 폭이 바뀌면) 위치를 다시 묶는다
  useEffect(() => { setView((v) => clampView(v)); }, [size.w, size.h, frameW]); // eslint-disable-line react-hooks/exhaustive-deps

  // 휠 = 확대·축소. React 의 onWheel 은 passive 라 페이지 스크롤을 못 막아 직접 단다.
  useEffect(() => {
    const fr = frame.current;
    if (!fr) return;
    const onWheel = (e: WheelEvent) => {
      // 떠 있는 경로 패널 위의 휠은 패널 안 가로 스크롤에 맡긴다
      if ((e.target as Element | null)?.closest?.(".bk-path")) return;
      e.preventDefault();
      const r = fr.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
    };
    fr.addEventListener("wheel", onWheel, { passive: false });
    return () => fr.removeEventListener("wheel", onWheel);
  });

  // 끌어서 이동. 5px 넘게 끌었으면 그 뒤의 클릭(칸 열기)은 삼킨다.
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean; id: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false, id: e.pointerId };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 5) return;
    if (!d.moved) { d.moved = true; frame.current?.setPointerCapture(e.pointerId); frame.current?.classList.add("bk-dragging"); }
    setView((v) => clampView({ ...v, x: d.vx + dx, y: d.vy + dy }));
  };
  const endDrag = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    frame.current?.classList.remove("bk-dragging");
    if (frame.current?.hasPointerCapture(e.pointerId)) frame.current.releasePointerCapture(e.pointerId);
    drag.current = null;
    if (d.moved) {
      const swallow = (ev: Event) => { ev.preventDefault(); ev.stopPropagation(); };
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
    }
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = 80;
    const move: Record<string, [number, number]> = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (move[e.key]) { e.preventDefault(); setView((v) => clampView({ ...v, x: v.x + move[e.key][0], y: v.y + move[e.key][1] })); }
    else if (e.key === "+" || e.key === "=") zoomCenter(1.2);
    else if (e.key === "-") zoomCenter(1 / 1.2);
    else if (e.key === "0") actual();
  };

  return <div className="bk-wrap">
    <div className="bk-toolbar">
      <span className="bk-legend"><i className="bk-legend-win" />승자 이동</span>
      <label className="bk-legend"><input type="checkbox" checked={loser} onChange={(e) => setLoser(e.target.checked)} /><i className="bk-legend-lose" />패자 이동</label>
      <span className="bk-hint">끌어서 이동 · 휠로 확대/축소 · 칸을 누르면 경기 상세</span>
      <span className="bk-zoom" role="group" aria-label="대진표 확대·축소">
        <button type="button" onClick={fit} title="대진표 전체를 한눈에">한눈에 보기</button>
        <button type="button" onClick={() => zoomCenter(1 / 1.2)} aria-label="축소">−</button>
        <output aria-live="polite">{Math.round(view.s * 100)}%</output>
        <button type="button" onClick={() => zoomCenter(1.2)} aria-label="확대">+</button>
        <button type="button" onClick={actual} title="카드 원래 크기(100%)">원래 크기</button>
      </span>
    </div>
    {people.length > 0 && <div className="bk-people" role="group" aria-label="참가자로 경로 보기">
      <button type="button" className="bk-chip" aria-pressed={focus == null} onClick={() => showPath(null)}>전체</button>
      {people.map((e) => <button key={e.id} type="button" className="bk-chip" aria-pressed={focus === e.id}
        onClick={() => showPath(focus === e.id ? null : e.id)}>
        <span className="bk-face"><Avatar name={e.name} src={e.image} channelId={e.channelId} /></span>{e.name}
      </button>)}
    </div>}
    <div className={`bk-viewport${focus ? " bk-focusing" : ""}`} ref={frame} style={{ height: frameH }} role="region"
      aria-label="대진표 — 끌어서 이동, 휠·+/− 로 확대·축소, 방향키로 이동" tabIndex={0}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag} onKeyDown={onKeyDown}>
      <div className="bk-board" ref={board}
        style={{ "--bk-cols": model.columns, transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})` } as React.CSSProperties}>
        <svg className="bk-lines" width={size.w} height={size.h} aria-hidden="true">
          {paths.filter((p) => loser || p.outcome === "winner" || (focus != null && p.travelers.includes(focus)))
            // 강조한 선을 맨 위에 그린다
            .sort((a, b) => Number(focus != null && a.travelers.includes(focus)) - Number(focus != null && b.travelers.includes(focus)))
            .map((p) => {
            const on = focus != null && p.travelers.includes(focus);
            return <path key={p.key} d={p.d} className={`bk-line-${p.outcome}${focus ? (on ? " bk-line-focus" : " bk-line-dim") : ""}`} />;
          })}
        </svg>
        {model.lanes.map((lane) => <section key={lane.name ?? "_"} className="bk-lane" aria-label={lane.name ?? "대진"}>
          {lane.name && <h3>{lane.name}</h3>}
          <div className="bk-lane-grid">
            {Array.from({ length: model.columns }, (_, col) => <div key={col} className="bk-col">
              {lane.slots.filter((s) => s.depth === col).map((s) => <SlotCard key={s.id} slot={s} onSelect={onSelect} focus={focus} />)}
            </div>)}
          </div>
        </section>)}
      </div>
    {focus && focusPerson && <section className="bk-path" aria-live="polite"
        onPointerDown={(e) => e.stopPropagation()} onMouseDown={(e) => e.preventDefault()} aria-label={`${focusPerson.name} 경로`}>
        <div className="bk-path-who">
          <span className="bk-face"><Avatar name={focusPerson.name} src={focusPerson.image} channelId={focusPerson.channelId} /></span>
          <span>
            <strong>{focusPerson.name}</strong>
            <small>{focusPlace?.rank ? `최종 ${focusPlace.rank}` : "순위 미정"}</small>
          </span>
        </div>
        <dl className="bk-path-record">
          <div><dt>승</dt><dd>{tally.win}</dd></div>
          <div><dt>무</dt><dd>{tally.draw}</dd></div>
          <div><dt>패</dt><dd>{tally.loss}</dd></div>
          {tally.pending > 0 && <div><dt>미정</dt><dd>{tally.pending}</dd></div>}
        </dl>
        <ol className="bk-path-steps">
          {path.map((step) => <li key={step.slot.id} data-result={step.result}
            className={step.slot.badge === "추론" ? "bk-step-inferred" : undefined}
            title={`${step.slot.title}${step.slot.badge ? ` · ${step.slot.badge}` : ""}`}>
            <small>{step.slot.no}경기</small>
            <b>{step.result}</b>
          </li>)}
          {focusPlace?.rank && <li className="bk-step-final"><small>최종</small><b>{focusPlace.rank}</b></li>}
        </ol>
      </section>}
    </div>
  </div>;
}
