"use client";

/** No players: current-squad value backcast from historical card prices. Selected players: only their
 * daily prices, on one monetary axis. Never normalize values to percentages. */
import Link from "next/link";
import { dailyPricePath, mergeSquadHistory } from "./price-history.ts";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";

export interface ChartPoint { day: string; value: number; label: string; missing: number; }
export interface ChartPlayer { key: string; name: string; color: string; points: ChartPoint[]; removeHref: string }

const RANGES = [7, 30, 90, 180, 365] as const;
/** 그리는 폭은 실제 칸 폭을 잰다 — viewBox 를 고정하면 좁은 화면에서 글자까지 같이 줄어 못 읽는다. */
const layout = (width: number, viewportHeight: number) => {
  const narrow = width < 520;
  return { W: width, H: Math.max(140, Math.min(narrow ? 190 : 250, viewportHeight - 600)), narrow, PAD: { top: 16, right: 18, bottom: 28, left: narrow ? 48 : 64 } };
};
const CLUB_COLOR = "#3987e5";

const dayNum = (day: string) => Date.parse(`${day}T00:00:00Z`) / 86_400_000;

function niceTicks(min: number, max: number, count = 4): number[] {
  if (min === max) return [min];
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const ticks: number[] = [];
  for (let t = Math.ceil(min / step) * step; t <= max + step * 1e-9; t += step) ticks.push(Number(t.toPrecision(12)));
  return ticks;
}

const wonTick = (v: number) => v >= 1e8 ? `${(v / 1e8).toLocaleString("ko-KR", { maximumFractionDigits: 1 })}억`
  : v >= 1e4 ? `${Math.round(v / 1e4).toLocaleString("ko-KR")}만` : v.toLocaleString("ko-KR");

interface Line {
  key: string; name: string; color: string; dashed: boolean;
  points: (ChartPoint & { y: number })[];   // y = 그리는 값(금액)
}

export function ClubValueChart({ clubName, estimatedHistory, collectedHistory, players, summary }: {
  clubName: string; estimatedHistory: ChartPoint[]; collectedHistory: ChartPoint[]; players: ChartPlayer[]; summary: ReactNode;
}) {
  const areaId = useId();
  const [range, setRange] = useState<(typeof RANGES)[number]>(90);
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(760);
  const [viewportHeight, setViewportHeight] = useState(900);
  useEffect(() => {
    const el = plotRef.current;
    if (!el) return;
    const update = () => {
      setWidth(Math.max(220, Math.round(el.clientWidth)));
      setViewportHeight(window.innerHeight);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener("resize", update);
    return () => { ro.disconnect(); window.removeEventListener("resize", update); };
  }, []);
  const { W, H, PAD, narrow } = layout(width, viewportHeight);
  const compare = players.length > 0;

  const view = useMemo(() => {
    const mergedHistory = mergeSquadHistory(estimatedHistory, collectedHistory);
    const all = compare ? players.flatMap((p) => p.points) : mergedHistory;
    const lastDay = all.map((p) => p.day).sort().at(-1);
    if (!lastDay) return null;
    const from = dayNum(lastDay) - range;
    const visible = (pts: ChartPoint[]) => pts.filter((p) => dayNum(p.day) >= from);
    const lines: Line[] = compare
      ? players.map(p => ({ key: p.key, name: p.name, color: p.color, dashed: false,
          points: visible(p.points).map(point => ({ ...point, y: point.value })) }))
      : [
        { key: "estimate", name: "현재 스쿼드 기준 추정", color: "#758a9f", dashed: true, points: visible(mergedHistory).map((p) => ({ ...p, y: p.value })) },
        { key: "collected", name: "수집 스쿼드 시세 합산", color: CLUB_COLOR, dashed: false, points: visible(collectedHistory).map((p) => ({ ...p, y: p.value })) },
      ];
    const drawn = lines.filter((l) => l.points.length > 0);
    const days = [...new Set(drawn.flatMap((l) => l.points.map((p) => p.day)))].sort();
    if (!days.length) return null;
    const ys = drawn.flatMap((l) => l.points.map((p) => p.y));
    let lo = Math.min(...ys), hi = Math.max(...ys);
    const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.05 || 1;
    const yMin = Math.max(0, lo - pad), yMax = hi + pad;
    const x0 = dayNum(days[0]), x1 = Math.max(dayNum(days.at(-1)!), x0 + 1);
    const x = (day: string) => PAD.left + (dayNum(day) - x0) / (x1 - x0) * (W - PAD.left - PAD.right);
    const y = (v: number) => PAD.top + (1 - (v - yMin) / (yMax - yMin)) * (H - PAD.top - PAD.bottom);
    const path = (pts: { day: string; y: number }[]) => dailyPricePath(pts, x, y);
    const ends = drawn.map(line => ({ line, at: line.points.at(-1)! }));
    return { drawn, days, x, y, path, ticks: niceTicks(yMin, yMax), ends };
  }, [estimatedHistory, collectedHistory, players, range, compare, clubName, W, H, PAD.left, PAD.right]);

  if (!view) return <div className="cv-chart">{summary}<div className="fc-empty">아직 표시할 가치 기록이 없습니다.</div></div>;
  const { drawn, days, x, y, path, ticks, ends } = view;
  const hoverDay = hover === null ? null : days[hover];

  function onMove(event: React.PointerEvent<SVGSVGElement>) {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box) return;
    const px = (event.clientX - box.left) / box.width * W;
    let best = 0;
    for (let i = 1; i < days.length; i++) if (Math.abs(x(days[i]) - px) < Math.abs(x(days[best]) - px)) best = i;
    setHover(best);
  }

  const labelDays = [days[0], days[Math.floor(days.length / 2)], days.at(-1)!].filter((d, i, all) => all.indexOf(d) === i);

  return <div className="cv-chart">
    <div className="cv-chart-bar">
      {summary}
      <div className="cv-ranges" role="group" aria-label="기간">
        {RANGES.map((r) => <button key={r} type="button" aria-pressed={range === r} onClick={() => { setRange(r); setHover(null); }}>{r}일</button>)}
      </div>
    </div>
    {!compare && <p className="cv-estimate-note" title="연한 점선은 현재 선수의 과거 시세 추정, 진한 실선·점은 저장된 스쿼드의 해당 날짜 시세 합산입니다. 홈페이지 스쿼드는 전일 기준이며, 창고 자산과 시세 미확인 선수는 포함하지 않습니다.">점선: 과거 추정 · 실선/진한 점: 수집 스쿼드</p>}
    <div className="cv-plot" ref={plotRef}>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} role="img"
        aria-label={compare ? `선수 가치, 최근 ${range}일` : `${clubName} 스쿼드 가치 추정 및 수집 기록, 최근 ${range}일`}
        onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        <defs>
          <linearGradient id={areaId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={CLUB_COLOR} stopOpacity=".16" />
            <stop offset="100%" stopColor={CLUB_COLOR} stopOpacity="0" />
          </linearGradient>
        </defs>
        {!compare && drawn.filter((l) => l.key === "estimate" && l.points.length > 1 && l.points.every((p, i) => i === 0 || (dayNum(p.day) - dayNum(l.points[i - 1].day) === 1))).map((l) =>
          <path key={l.key} className="cv-area" aria-hidden="true" fill={`url(#${areaId})`}
            d={`${path(l.points)}L${x(l.points.at(-1)!.day)},${H - PAD.bottom}L${x(l.points[0].day)},${H - PAD.bottom}Z`} />)}
        {ticks.map((t) => <g key={t}>
          <line className={compare && t === 0 ? "cv-grid cv-grid-zero" : "cv-grid"} x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} />
          <text className="cv-axis" x={PAD.left - 8} y={y(t)} textAnchor="end" dominantBaseline="middle">{wonTick(t)}</text>
        </g>)}
        {labelDays.map((d, i) => <text key={d} className="cv-axis" x={x(d)} y={H - 8}
          textAnchor={i === 0 ? "start" : i === labelDays.length - 1 ? "end" : "middle"}>{d.slice(5).replace("-", ".")}</text>)}
        {drawn.map((l) => l.points.length > 1
          ? <g key={l.key}>
              <path className="cv-line" d={path(l.points)} style={{ stroke: l.color }} strokeDasharray={l.dashed ? "5 4" : undefined} />
              {l.points.filter((p, i) => i === 0 || dayNum(p.day) - dayNum(l.points[i - 1].day) > 1).map(p =>
                <circle key={p.day} className="cv-dot" cx={x(p.day)} cy={y(p.y)} r={3} style={{ fill: l.color }} />)}
            </g>
          : <circle key={l.key} className="cv-dot" cx={x(l.points[0].day)} cy={y(l.points[0].y)} r={4} style={{ fill: l.color }} />)}
        {ends.map(({ line, at }) => <g key={line.key}>
          <circle className="cv-dot" cx={x(at.day)} cy={y(at.y)} r={4} style={{ fill: line.color }} />
        </g>)}
        {hoverDay && <g>
          <line className="cv-cross" x1={x(hoverDay)} x2={x(hoverDay)} y1={PAD.top} y2={H - PAD.bottom} />
          {drawn.map((l) => {
            const p = l.points.find((q) => q.day === hoverDay);
            return p ? <circle key={l.key} className="cv-dot" cx={x(hoverDay)} cy={y(p.y)} r={4} style={{ fill: l.color }} /> : null;
          })}
        </g>}
      </svg>
      {/* 좁은 화면은 띄우지 않고 차트 아래 고정 칸으로 — 떠 있는 상자가 칸 밖으로 잘린다. */}
      {hoverDay && <div className={`cv-tooltip${narrow ? " cv-tooltip-static" : ""}${drawn.length > 8 ? " cv-tooltip-many" : ""}`} style={narrow ? undefined : x(hoverDay) < W / 2
        ? { left: `calc(${x(hoverDay) / W * 100}% + 10px)` }
        : { right: `calc(${100 - x(hoverDay) / W * 100}% + 10px)` }}>
        <strong>{hoverDay}</strong>
        {drawn.map((l) => {
          const p = l.points.find((q) => q.day === hoverDay);
          if (!p || (l.key === "estimate" && collectedHistory.some(q => q.day === hoverDay))) return null;
          return <span key={l.key}><i className={`cv-key${l.dashed ? " cv-key-dashed" : ""}`} style={{ borderTopColor: l.color }} />
            {l.name} {p.label}{p.missing > 0 ? ` · ${p.missing}장 시세 미확인` : ""}</span>;
        })}
      </div>}
    </div>
      {compare && <div className="cv-legend cv-chart-selection" tabIndex={0} aria-label="차트에 표시한 선수">
        {players.map(p => ({ ...p, dashed: false })).map((l) => {
          const player = players.find((p) => p.key === l.key);
          return <span key={l.key} className={player ? "cv-chip" : undefined}>
            <i className={`cv-key${l.dashed ? " cv-key-dashed" : ""}`} style={{ borderTopColor: l.color }} />{l.name}
            {player && <Link href={player.removeHref} scroll={false} className="cv-chip-x" aria-label={`${l.name} 빼기`}>×</Link>}
          </span>;
        })}
      </div>}
  </div>;
}
