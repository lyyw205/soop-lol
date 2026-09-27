"use client";

import { useState, type CSSProperties } from "react";
import type { FcoShotView, FcoSideView } from "@/lib/fco-match-view";
import { BallIcon } from "./fco-scoreboard";
import { bfParts, type BfRow } from "./fco-butterfly";

/**
 * 패스 카드 — 슛 카드와 같은 틀(토글 · 머리줄 · 본문 · 범례 격자).
 *
 * 패스 자체에는 위치가 없다(API 가 종류별 시도/성공 숫자만 준다). 대신 슛마다 "그 슛을 만든 패스가
 * 출발한 위치"(assistX/Y)가 온다. 그래서 왼쪽 맵은 모든 패스가 아니라 **슛으로 이어진 패스**만 그린다.
 * 오른쪽은 패스 종류별 성공/시도(지표 비교에 없는 숫자)와, 찬스 패스가 어디서 출발했나.
 */

type Kind = "goal" | "on" | "miss";
const kindOf = (result: number): Kind => result === 3 ? "goal" : result === 1 ? "on" : "miss";
const KIND_LABEL: Record<Kind, string> = { goal: "골", on: "유효 슛", miss: "빗나감" };

// 골라인에서 하프라인(52.5m)까지 그린다. 찬스 패스의 약 83% 가 골문 36m 안에서 출발하고,
// 하프라인 너머에서 온 패스는 하프라인에 붙여 찍는다.
const DEPTH_M = 52.5, PAD_M = 2.5;

interface Chance extends FcoShotView { side: 0 | 1; sideName: string; from: { x: number; y: number } }

/** 찬스 패스가 출발한 구역. 측면 = 터치라인 쪽 20%(크로스·컷백), 후방 = 골문에서 약 36m 밖, 나머지 중앙. */
type Zone = "측면에서" | "중앙에서" | "후방에서";
function zoneOf(from: { x: number; y: number }): Zone {
  if (from.y < .2 || from.y > .8) return "측면에서";
  return from.x < .66 ? "후방에서" : "중앙에서";
}

const toMap = (x: number, y: number) => {
  const depth = Math.min(DEPTH_M, (1 - x) * 105);
  return { left: y * 100, top: (depth + PAD_M) / (DEPTH_M + PAD_M) * 100, vx: y * 68, vy: depth };
};

const PASS_KINDS: { key: string; label: string }[] = [
  { key: "shortPass", label: "숏 패스" },
  { key: "throughPass", label: "스루 패스" },
  { key: "longPass", label: "롱 패스" },
  { key: "drivenGroundPass", label: "드리븐 땅볼" },
  { key: "lobbedThroughPass", label: "로빙 스루" },
  { key: "bouncingLobPass", label: "바운싱 롭" },
];

function PassTip({ c }: { c: Chance }) {
  return <span className="fc-shot-tip" role="tooltip">
    <b>{c.time}{c.seasonIcon && <img className="fc-shot-tip-season" src={c.seasonIcon} alt={c.seasonName ?? ""} />}{c.assistName ?? "도움"} → {c.playerName}</b>
    <span className="fc-shot-tip-assist">{c.type} · {KIND_LABEL[kindOf(c.result)]}</span>
    <small>{c.sideName} · {zoneOf(c.from)} 온 패스</small>
  </span>;
}

export function FcoPasses({ sides }: { sides: FcoSideView[] }) {
  const [view, setView] = useState<"all" | 0 | 1>("all");
  const [a, b] = sides;
  if (!a || !b) return <div className="fc-empty">패스 기록이 없습니다.</div>;

  const chances: Chance[] = [a, b].flatMap((side, i) => side.shots
    .filter((s) => s.phase < 4 && s.assistFrom)
    .map((s) => ({ ...s, side: i as 0 | 1, sideName: side.name, from: s.assistFrom! })));
  const shown = view === "all" ? chances : chances.filter((c) => c.side === view);
  const order: Record<Kind, number> = { miss: 0, on: 1, goal: 2 };
  const drawn = [...shown].sort((p, q) => order[kindOf(p.result)] - order[kindOf(q.result)]);
  const views: { key: "all" | 0 | 1; label: string }[] = [{ key: "all", label: "전체" }, { key: 0, label: a.name }, { key: 1, label: b.name }];

  // 오른쪽 위: 패스 종류별 성공/시도. 두 팀 다 0 인 종류는 뺀다.
  const kindRows: BfRow[] = PASS_KINDS
    .map(({ key, label }) => ({
      key, label,
      a: { fill: a.pass[`${key}Success`] ?? 0, total: a.pass[`${key}Try`] ?? 0 },
      b: { fill: b.pass[`${key}Success`] ?? 0, total: b.pass[`${key}Try`] ?? 0 },
    }))
    .filter((row) => row.a.total + row.b.total > 0)
    .sort((x, y) => (y.a.total + y.b.total) - (x.a.total + x.b.total));
  // 오른쪽 아래: 찬스 패스 출발 구역별 골/찬스. 규모가 달라(패스 수십 vs 찬스 한 자릿수) 막대 축을 따로 쓴다.
  const zoneRows: BfRow[] = (["측면에서", "중앙에서", "후방에서"] as Zone[]).map((zone) => {
    const pick = (i: 0 | 1) => { const list = chances.filter((c) => c.side === i && zoneOf(c.from) === zone); return { fill: list.filter((c) => c.result === 3).length, total: list.length }; };
    return { key: zone, label: zone, a: pick(0), b: pick(1) };
  });

  const summary = (side: FcoSideView, i: 0 | 1) => `패스 ${side.pass.passTry ?? 0}회 · 찬스 패스 ${chances.filter((c) => c.side === i).length}`;
  const common = { focus: view, names: [a.name, b.name] as [string, string], summaries: [summary(a, 0), summary(b, 1)] as [string, string] };
  const kinds = bfParts({ ...common, rows: kindRows, ariaUnit: ["성공", "시도"], keyText: "" });
  const zones = bfParts({ ...common, rows: zoneRows, ariaUnit: ["골", "찬스"], keyText: "" });

  return <div className="fc-sh fc-ps">
    <div className="fc-sh-toggle" role="tablist" aria-label="패스 맵 보기">
      {views.map((v) => <button key={String(v.key)} type="button" role="tab" className="fc-tab"
        data-side={v.key === "all" ? undefined : v.key}
        aria-selected={view === v.key} onClick={() => setView(v.key)}>{v.label}</button>)}
    </div>
    <div className="fc-sh-body">
      <div className="fc-sh-cap"><b>찬스를 만든 패스</b><small>점에서 출발해 슛으로 이어진 패스 · 하프라인까지</small></div>
      {kinds.head}

      <div className="fc-sh-map fc-ps-map">
        <svg viewBox={`0 ${-PAD_M} 68 ${DEPTH_M + PAD_M}`} preserveAspectRatio="none" aria-hidden="true">
          <line x1="0" y1="0" x2="68" y2="0" />
          <rect x="13.84" y="0" width="40.32" height="16.5" />
          <rect x="24.84" y="0" width="18.32" height="5.5" />
          <path d="M26.69 16.5 A9.15 9.15 0 0 0 41.31 16.5" />
          <circle cx="34" cy="11" r=".35" className="fc-field-spot" />
          <line x1="0" y1={DEPTH_M} x2="68" y2={DEPTH_M} />
          <path d={`M24.85 ${DEPTH_M} A9.15 9.15 0 0 1 43.15 ${DEPTH_M}`} />
          <rect x="30.34" y={-PAD_M + .4} width="7.32" height={PAD_M - .4} className="fc-field-goal" />
          {drawn.map((c) => {
            const f = toMap(c.from.x, c.from.y), t = toMap(c.x, c.y);
            return <g key={`${c.side}-${c.index}`} className="fc-ps-pass" data-side={c.side} data-kind={kindOf(c.result)}>
              <line x1={f.vx} y1={f.vy} x2={t.vx} y2={t.vy} />
              {/* 출발점은 작은 네모 — 슛 쪽 표시(원)와 모양으로 구분한다 */}
              <rect x={f.vx - .7} y={f.vy - .7} width="1.4" height="1.4" rx=".2" />
            </g>;
          })}
        </svg>
        {drawn.map((c) => {
          const t = toMap(c.x, c.y), kind = kindOf(c.result);
          return <span key={`m-${c.side}-${c.index}`} className="fc-shot-mark" data-kind={kind} data-side={c.side}
            data-below={t.top < 30} tabIndex={0}
            style={{ left: `${t.left}%`, top: `${t.top}%`, "--x": t.left / 100 } as CSSProperties}
            aria-label={`${c.time} ${c.sideName} ${c.assistName ?? "도움"}의 패스, ${c.playerName} ${KIND_LABEL[kind]}`}>
            {kind === "goal" && <span className="fc-shot-ball"><BallIcon className="fc-shot-ball-icon" /></span>}
            <PassTip c={c} />
          </span>;
        })}
        {!shown.length && <p className="fc-ps-none">슛으로 이어진 패스가 없습니다.</p>}
      </div>

      <div className="fc-ps-stack">
        <h4>패스 종류 <small>성공/시도</small></h4>
        <div className="fc-ps-part" style={{ flexGrow: kindRows.length }}>{kinds.rows}</div>
        <h4>찬스 패스가 출발한 곳 <small>골/찬스</small></h4>
        <div className="fc-ps-part" style={{ flexGrow: zoneRows.length }}>{zones.rows}</div>
      </div>

      <div className="fc-shot-legend" aria-hidden="true">
        <span><i className="fc-ps-origin" />패스 출발</span>
        <span><i className="fc-shot-key" data-kind="goal"><BallIcon className="fc-shot-ball-icon" /></i>골</span>
        <span><i className="fc-shot-key" data-kind="on" />유효 슛</span>
        <span><i className="fc-shot-key" data-kind="miss" />빗나감</span>
      </div>
      <div className="fc-bf-key" aria-hidden="true">
        <span className="fc-bf-key-bar"><i /></span>
        <span>진한 부분 <b>성공·골</b> · 막대 전체 <b>시도·찬스</b></span>
      </div>
    </div>
  </div>;
}
