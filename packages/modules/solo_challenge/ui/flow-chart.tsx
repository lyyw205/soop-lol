"use client";

import { useEffect, useId, useState } from "react";
import type { ChallengeView } from "../server/model.ts";
import "./flow-chart.css";

type Props = Pick<ChallengeView, "flow" | "days" | "record">;
const short = (day: string) => day.slice(5).replace("-", ".");
const signed = (n: number) => n > 0 ? `+${n}` : String(n);

/** 경기 간격을 고정한 누적 승패. 날짜와 LP를 시간축/점수로 혼동하지 않는다. */
export function FlowChart({ flow, days, record }: Props) {
  const id = useId().replaceAll(":", "");
  const [mobile, setMobile] = useState(false);
  const [recent, setRecent] = useState(false);
  const [selected, setSelected] = useState(flow.length - 1);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 600px)");
    setMobile(media.matches);
    setRecent(media.matches);
    const change = () => setMobile(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  if (!flow.length) return <p className="sc-muted">아직 판이 없습니다.</p>;
  const start = recent ? Math.max(0, flow.length - 30) : 0;
  const index = Math.max(start, Math.min(selected, flow.length - 1));
  const chosen = flow[index];
  const day = days.find((d) => d.day === chosen.day);
  const shown = flow.slice(start);
  const points = [{ index: start - 1, net: start ? flow[start - 1].net : 0 }, ...shown.map((p, i) => ({ index: start + i, net: p.net }))];
  const W = mobile ? 340 : 800, H = mobile ? 230 : 260;
  const L = mobile ? 28 : 35, R = mobile ? 28 : 53;
  const hi = Math.max(2, ...points.map((p) => p.net)) + 1;
  const lo = Math.min(-1, ...points.map((p) => p.net)) - 1;
  const x = (i: number) => L + (i - start + 1) / shown.length * (W - L - R);
  const y = (n: number) => 26 + (hi - n) / (hi - lo) * (H - 61);
  const path = points.map((p, i) => `${i ? "L" : "M"}${x(p.index)},${y(p.net)}`).join(" ");
  const area = `${path} L${x(flow.length - 1)},${y(0)} L${x(start - 1)},${y(0)} Z`;
  const extrema = [points.reduce((a, b) => a.net >= b.net ? a : b), points.reduce((a, b) => a.net <= b.net ? a : b)];
  const dateIndices = [...new Set([start, start + Math.floor((shown.length - 1) / 3), start + Math.floor((shown.length - 1) * 2 / 3), flow.length - 1])];
  const current = record.current;
  return <div className="sf-card">
    <header className="sf-head">
      <div><h3>누적 승패</h3><p>{short(flow[0].day)} — {short(flow.at(-1)!.day)} · 수집된 경기 기준</p><div className="sf-total"><b className="sf-win">{record.wins}<small>승</small></b><span>/</span><b className="sf-loss">{record.games - record.wins}<small>패</small></b></div></div>
      <div className="sf-switch" aria-label="그래프 경기 범위"><button aria-pressed={!recent} onClick={() => setRecent(false)}>전체 {flow.length}판</button><button aria-pressed={recent} onClick={() => setRecent(true)}>최근 30판</button></div>
    </header>
    <div className="sf-body">
      <div className="sf-plot"><div className="sf-axis-title"><span>누적 승수 − 패수</span><small>경기 순서 기준 · LP 아님</small></div>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`누적 승패 그래프. ${start + 1}번째부터 ${flow.length}번째 경기, 마지막 ${signed(flow.at(-1)!.net)}`}>
          <defs><clipPath id={`${id}-up`}><rect width={W} height={y(0)} /></clipPath><clipPath id={`${id}-down`}><rect y={y(0)} width={W} height={H - y(0)} /></clipPath></defs>
          {[hi, 0, lo].map((t) => <g key={t}><line x1={L} x2={W - R + 10} y1={y(t)} y2={y(t)} className={t === 0 ? "sf-zero" : "sf-grid"} /><text x={L - 9} y={y(t) + 4} textAnchor="end" className="sf-tick">{signed(t)}</text></g>)}
          <path d={area} fill="#55d5bd" opacity=".065" clipPath={`url(#${id}-up)`} /><path d={area} fill="#f083a2" opacity=".065" clipPath={`url(#${id}-down)`} />
          <path d={path} className="sf-line sf-line-win" clipPath={`url(#${id}-up)`} /><path d={path} className="sf-line sf-line-loss" clipPath={`url(#${id}-down)`} />
          {extrema.map((p, i) => <g key={i}><circle cx={x(p.index)} cy={y(p.net)} r={3} fill={i ? "#efa0b6" : "#8edfcf"} /><text x={Math.max(55, Math.min(W - 45, x(p.index)))} y={y(p.net) + (i ? 20 : -12)} textAnchor="middle" className="sf-extreme">{i ? "최저" : "최고"} {signed(p.net)}</text></g>)}
          <line x1={x(index)} x2={x(index)} y1={15} y2={H - 35} className="sf-cursor" /><circle cx={x(index)} cy={y(chosen.net)} r={4} fill="#dcc8ff" stroke="#9b7ac7" strokeWidth={2} />
          <text x={W - R + 8} y={y(flow.at(-1)!.net) + 4} className="sf-end">{signed(flow.at(-1)!.net)}</text>
          <rect x={L} width={W - L - R} height={H} fill="transparent" onPointerMove={(event) => { const bounds = event.currentTarget.ownerSVGElement!.getBoundingClientRect(); const sx = (event.clientX - bounds.left) / bounds.width * W; setSelected(Math.max(start, Math.min(flow.length - 1, Math.round(start - 1 + (sx - L) / (W - L - R) * shown.length)))); }} />
        </svg>
        <div className="sf-dates">{dateIndices.map((i) => <span key={i}>{short(flow[i].day)} <small>· {i + 1}판</small></span>)}</div>
        <label className="sf-slider">경기 탐색<input type="range" min={start} max={flow.length - 1} value={index} onChange={(e) => setSelected(Number(e.target.value))} aria-label="경기 선택" /><span>{index + 1}판</span></label>
      </div>
      <aside className="sf-side">
        <div className="sf-current"><small>현재 연속 결과</small><strong className={current?.win ? "sf-win" : "sf-loss"}>{current ? `${current.n}${current.n > 1 ? "연" : ""}${current.win ? "승" : "패"}` : "기록 없음"}</strong><span>마지막 경기 {short(flow.at(-1)!.day)}</span></div>
        <dl className="sf-record"><div><dt>전체 경기</dt><dd>{record.games}판</dd></div><div><dt>최장 연승</dt><dd>{record.bestWinStreak}연승</dd></div><div><dt>최장 연패</dt><dd>{record.worstLoseStreak}연패</dd></div></dl>
        <div className="sf-readout" aria-live="polite"><strong>{short(chosen.day)} · {index + 1}번째 경기 <span className={chosen.win ? "sf-win" : "sf-loss"}>{chosen.win ? "승" : "패"}</span></strong><span>누적 승패 <b>{signed(chosen.net)}</b></span>{day && <small>당일 {day.wins}승 {day.losses}패</small>}</div>
      </aside>
    </div>
    <footer className="sf-footer"><span><i className="sf-win">● 승수 우세</i><i className="sf-loss">● 패수 우세</i></span><span>승리 +1 · 패배 −1 · 0은 승패 같음</span></footer>
  </div>;
}
