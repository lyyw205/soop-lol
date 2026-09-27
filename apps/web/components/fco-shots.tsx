"use client";

import { useState, type CSSProperties } from "react";
import type { FcoShotView, FcoSideView } from "@/lib/fco-match-view";
import { BallIcon } from "./fco-scoreboard";
import { bfParts, type BfRow } from "./fco-butterfly";

/**
 * 슛 카드. 왼쪽은 슛 맵 하나(전체 / 참가자별 토글), 오른쪽은 선택에 따라 바뀌는 상세 정보.
 *
 * 좌표 규칙(실측): x 는 각자 공격 방향 기준 0~1 이라 양 팀 모두 1 쪽이 상대 골문이다.
 * 그래서 두 팀 슛을 한 맵에 겹쳐도 둘 다 위쪽 골문을 향한 슛이 된다.
 * 슛의 99% 가 골라인 33m 안에 있어(중앙값 10m) 그만큼만 확대해 그리고, 더 먼 슛은 맵 아래 끝에 붙인다.
 */

type Kind = "goal" | "on" | "miss";
const kindOf = (result: number): Kind => result === 3 ? "goal" : result === 1 ? "on" : "miss";

const DEPTH_M = 33, PAD_M = 2.5; // 그릴 깊이, 골대를 그릴 위쪽 여백(m)

interface SideShot extends FcoShotView { side: 0 | 1; sideName: string }

/** 경기 흐름 타임라인과 같은 툴팁 — 1행 시간·시즌·이름, 2행 도움, 3행 스트리머·슛 종류 */
function ShotTip({ shot }: { shot: SideShot }) {
  return <span className="fc-shot-tip" role="tooltip">
    <b>{shot.time}{shot.seasonIcon && <img className="fc-shot-tip-season" src={shot.seasonIcon} alt={shot.seasonName ?? ""} />}{shot.playerName}</b>
    {shot.assistName && <span className="fc-shot-tip-assist">도움 {shot.assistName}</span>}
    <small>{shot.sideName} · {shot.type}{shot.hitPost ? " · 골대 맞음" : ""}</small>
  </span>;
}

/** 표시 하나. 골은 공 아이콘, 유효 슛은 찬 점, 빗나감은 팀 색 빈 원 — 크기로 위계. */
function Marker({ shot }: { shot: SideShot }) {
  const kind = kindOf(shot.result);
  const depth = Math.min(DEPTH_M, (1 - shot.x) * 105);
  const left = shot.y * 100;
  const top = (depth + PAD_M) / (DEPTH_M + PAD_M) * 100;
  return <span className="fc-shot-mark" data-kind={kind} data-side={shot.side} data-below={top < 30} tabIndex={0}
    style={{ left: `${left}%`, top: `${top}%`, "--x": left / 100 } as CSSProperties}
    aria-label={`${shot.time} ${shot.sideName} ${shot.playerName} ${kind === "goal" ? "골" : kind === "on" ? "유효 슛" : "빗나감"}`}>
    {kind === "goal" && <span className="fc-shot-ball"><BallIcon className="fc-shot-ball-icon" /></span>}
    <ShotTip shot={shot} />
  </span>;
}

interface Tally { shots: number; goals: number }
const tallyOf = (list: SideShot[]): Tally => ({ shots: list.length, goals: list.filter((s) => s.result === 3).length });

/** 구역(박스 안/밖) 두 줄 + 슛 종류별 줄. 종류는 전체 슛이 많은 순. */
function breakdown(shots: SideShot[]) {
  const types = [...new Set(shots.map((s) => s.type))]
    .map((type) => ({ label: type, list: shots.filter((s) => s.type === type) }))
    .sort((x, y) => y.list.length - x.list.length);
  return {
    zones: [
      { label: "박스 안", list: shots.filter((s) => s.inPenalty) },
      { label: "박스 밖", list: shots.filter((s) => !s.inPenalty) },
    ],
    types,
  };
}

export function FcoShots({ sides }: { sides: FcoSideView[] }) {
  const [view, setView] = useState<"all" | 0 | 1>("all");
  const [a, b] = sides;
  if (!a || !b) return <div className="fc-empty">슛 기록이 없습니다.</div>;

  const all: SideShot[] = [a, b].flatMap((side, i) => side.shots.filter((s) => s.phase < 4)
    .map((shot) => ({ ...shot, side: i as 0 | 1, sideName: side.name })));
  const shown = view === "all" ? all : all.filter((s) => s.side === view);
  // 골이 맨 위에 그려지게 약한 것부터
  const order: Record<Kind, number> = { miss: 0, on: 1, goal: 2 };
  const drawn = [...shown].sort((p, q) => order[kindOf(p.result)] - order[kindOf(q.result)]);
  const views: { key: "all" | 0 | 1; label: string }[] = [{ key: "all", label: "전체" }, { key: 0, label: a.name }, { key: 1, label: b.name }];

  const chart = butterfly(a, b, all, view);

  /*
   * 한 장의 격자로 줄을 맞춘다 (모바일은 한 줄로 쌓는다).
   *   머리줄   [슛 위치 설명]      [참가자 요약]       ← 같은 높이, 같은 밑줄
   *   본문     [필드 맵]           [막대 차트 줄들]    ← 차트는 필드 높이에 맞춰 늘어난다
   *   범례     [골·유효·빗나감]    [슛·골]
   *   득점     [한 팀을 볼 때의 득점 장면 — 두 칸 전체]
   */
  return <div className="fc-sh">
    <div className="fc-sh-toggle" role="tablist" aria-label="슛 맵 보기">
      {views.map((v) => <button key={String(v.key)} type="button" role="tab" className="fc-tab"
        data-side={v.key === "all" ? undefined : v.key}
        aria-selected={view === v.key} onClick={() => setView(v.key)}>{v.label}</button>)}
    </div>
    <div className="fc-sh-body">
      <div className="fc-sh-cap"><b>슛 위치</b><small>골문 앞 {DEPTH_M}m · 위쪽이 상대 골문</small></div>
      {chart.head}

      <div className="fc-sh-map">
        <svg viewBox={`0 ${-PAD_M} 68 ${DEPTH_M + PAD_M}`} preserveAspectRatio="none" aria-hidden="true">
          <line x1="0" y1="0" x2="68" y2="0" />
          <rect x="13.84" y="0" width="40.32" height="16.5" />
          <rect x="24.84" y="0" width="18.32" height="5.5" />
          <path d="M26.69 16.5 A9.15 9.15 0 0 0 41.31 16.5" />
          <circle cx="34" cy="11" r=".35" className="fc-field-spot" />
          <rect x="30.34" y={-PAD_M + .4} width="7.32" height={PAD_M - .4} className="fc-field-goal" />
        </svg>
        {drawn.map((shot) => <Marker key={`${shot.side}-${shot.index}`} shot={shot} />)}
      </div>
      {chart.rows}

      <div className="fc-shot-legend" aria-hidden="true">
        <span><i className="fc-shot-key" data-kind="goal"><BallIcon className="fc-shot-ball-icon" /></i>골</span>
        <span><i className="fc-shot-key" data-kind="on" />유효 슛</span>
        <span><i className="fc-shot-key" data-kind="miss" />빗나감</span>
      </div>
      {chart.key}

      {view !== "all" && <GoalList shots={shown} />}
    </div>
  </div>;
}

/** 슛 카드의 막대 — 구역(박스 안/밖) 두 줄, 구분선, 슛 종류별 줄. 겹친 막대의 채움 = 골, 전체 = 슛. */
function butterfly(a: FcoSideView, b: FcoSideView, all: SideShot[], focus: "all" | 0 | 1) {
  const { zones, types } = breakdown(all);
  const side = (list: SideShot[], i: 0 | 1) => { const t = tallyOf(list.filter((s) => s.side === i)); return { fill: t.goals, total: t.shots }; };
  const rows: BfRow[] = [...zones, ...types].map((row, i) => ({
    key: row.label, label: row.label, a: side(row.list, 0), b: side(row.list, 1), divider: i === zones.length,
  }));
  // "전체" 는 다른 줄보다 훨씬 커서 같은 축에 두면 나머지가 다 짧아지므로 머리줄 요약 숫자로 뺀다.
  const summary = (i: 0 | 1) => {
    const list = all.filter((s) => s.side === i);
    return `슛 ${list.length} · 유효 ${list.filter((s) => s.result !== 2).length} · 골 ${list.filter((s) => s.result === 3).length}`;
  };
  return bfParts({
    rows, focus, names: [a.name, b.name], summaries: [summary(0), summary(1)], ariaUnit: ["골", "슛"],
    keyText: <>진한 부분 <b>골</b> · 막대 전체 <b>슛</b> · 숫자는 골/슛</>,
  });
}

/** 한 팀을 볼 때 — 득점 장면 */
function GoalList({ shots }: { shots: SideShot[] }) {
  const goals = shots.filter((s) => s.result === 3).sort((x, y) => x.seconds - y.seconds);
  if (!goals.length) return null;
  return <div className="fc-sh-goals">
    <h4>득점</h4>
    <ul>{goals.map((g) => <li key={g.index}>
      <BallIcon className="fc-shot-ball-icon" />
      <b>{g.time}</b>
      {g.seasonIcon && <img className="fc-shot-tip-season" src={g.seasonIcon} alt={g.seasonName ?? ""} />}
      <span>{g.playerName}</span>
      <small>{g.type}{g.assistName ? ` · 도움 ${g.assistName}` : ""}</small>
    </li>)}</ul>
  </div>;
}
