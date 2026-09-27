"use client";

import type { CSSProperties } from "react";
import type { FcoShotView, FcoSideView } from "@/lib/fco-match-view";
import { BallIcon, PlayerShot } from "./fco-scoreboard";

/**
 * 경기 흐름 카드 — 슛 타임라인. 위는 왼쪽 참가자, 아래는 오른쪽 참가자.
 * 골만 선에서 띄워 대시선으로 잇고, 슛은 선 위에 점으로만 얹는다. 어느 쪽 슛인지는 색과 툴팁이 말한다.
 * 위계는 크기로 준다 — 골(액션샷) > 유효 슛(찬 점) > 빗나감(빈 원).
 */

interface SideShot extends FcoShotView { side: 0 | 1; sideName: string }

function sideShots(sides: FcoSideView[]): SideShot[] {
  return sides.flatMap((side, i) => side.shots.map((shot) => ({ ...shot, side: i as 0 | 1, sideName: side.name })));
}

/** 연장은 연장 구간에 슛이 있을 때만 확신한다. 슛 없는 연장은 데이터로 알 수 없다. */
function hasExtraTime(shots: SideShot[]) { return shots.some((shot) => shot.phase >= 2 && shot.phase < 4); }
function hasShootout(sides: FcoSideView[], shots: SideShot[]) {
  return shots.some((shot) => shot.phase === 4) || sides.some((side) => (side.shoot.shootOutScore ?? 0) > 0);
}

/** 몰수 경기는 기록이 도중에 끊긴다. 마지막 슛이 있는 구간까지만 믿는다. */
function forfeitOf(sides: FcoSideView[], shots: SideShot[]) {
  const side = sides.find((s) => s.forfeit);
  if (!side) return null;
  const lastPhase = Math.max(0, ...shots.filter((s) => s.phase < 4).map((s) => s.phase));
  const lastSeconds = Math.max(0, ...shots.filter((s) => s.phase < 4).map((s) => s.seconds));
  return { label: `${side.name} ${side.forfeit}`, lastPhase, lastSeconds };
}

type ShotKind = "goal" | "on" | "miss";
const KIND_LABEL: Record<ShotKind, string> = { goal: "골", on: "유효 슛", miss: "빗나감" };
function kindOf(result: number): ShotKind { return result === 3 ? "goal" : result === 1 ? "on" : "miss"; }

export function FcoFlow({ sides }: { sides: FcoSideView[] }) {
  const [a, b] = sides;
  const shots = sideShots(sides).filter((shot) => shot.phase < 4);
  if (!a || !b || !shots.length) return <div className="fc-empty">슛 기록이 없어 흐름을 그릴 수 없습니다.</div>;

  const extra = hasExtraTime(shots);
  const span = extra ? 120 : 90;
  const pct = (seconds: number) => `${Math.min(100, (seconds / 60 / span) * 100)}%`;
  const marks = extra ? [45, 90, 105] : [45];
  const pens = hasShootout(sides, sideShots(sides));
  const forfeit = forfeitOf(sides, shots);
  const ordered = [...shots].sort((x, y) => x.seconds - y.seconds);

  // 칩에 선수명이 들어가 넓다. 같은 쪽에서 14분 안에 연달아 난 골은 칩을 한 칸 바깥으로 엇갈린다.
  const stacked = new Set<SideShot>();
  for (const side of [0, 1] as const) {
    let previous: SideShot | null = null;
    for (const goal of ordered.filter((shot) => shot.side === side && shot.result === 3)) {
      if (previous && goal.seconds - previous.seconds < 14 * 60 && !stacked.has(previous)) stacked.add(goal);
      previous = goal;
    }
  }

  const tally = (side: 0 | 1) => {
    const mine = shots.filter((shot) => shot.side === side);
    return { total: mine.length, on: mine.filter((s) => s.result !== 2).length, goals: mine.filter((s) => s.result === 3).length };
  };

  return <div className="fc-flow2">
    <div className="fc-flow2-stage">
      {/* 위 절반은 왼쪽 참가자, 아래 절반은 오른쪽 참가자의 영역이다. 팀 색으로 옅게 칠하고 모서리에 이름을 둔다. */}
      <span className="fc-flow2-zone" data-side={0} aria-hidden="true" />
      <span className="fc-flow2-zone" data-side={1} aria-hidden="true" />
      {[a, b].map((side, i) => {
        const t = tally(i as 0 | 1);
        return <span key={side.ouid} className="fc-flow2-lane" data-side={i}>
          <b>{side.name}</b>
          <span>슛 {t.total} · 유효 {t.on} · 골 {t.goals}</span>
        </span>;
      })}
      {extra && <span className="fc-flow2-extra" style={{ left: pct(90 * 60) }} />}
      {marks.map((m) => <i key={m} className="fc-flow2-div" style={{ left: pct(m * 60) }} />)}
      {extra && <span className="fc-flow2-period is-extra" style={{ left: pct(105 * 60) }}>연장</span>}

      <i className="fc-flow2-axis" />
      {forfeit && <>
        <span className="fc-flow2-cut" style={{ left: pct(forfeit.lastSeconds) }} />
        <span className="fc-flow2-forfeit" style={{ left: pct(forfeit.lastSeconds) }}>{forfeit.label} · 기록 끝</span>
      </>}

      {ordered.map((shot, i) => {
        const kind = kindOf(shot.result);
        // 이름표·툴팁은 가운데 정렬하되, 넘칠 때만 넘치는 만큼 안으로 민다(CSS 에서 --x 로 계산).
        const at = shot.seconds / 60 / span;
        return <div key={`${shot.side}-${shot.index}`} className="fc-flow2-shot" data-side={shot.side} data-kind={kind} data-stack={stacked.has(shot) || undefined}
          style={{ left: pct(shot.seconds), "--i": i, "--x": Math.min(1, at) } as CSSProperties}>
          {kind === "goal" && <span className="fc-flow2-anchor"><BallIcon className="fc-flow2-ball" /></span>}
          <span className="fc-flow2-stem" />
          <span className="fc-flow2-mark" tabIndex={0}
            aria-label={`${shot.time} ${shot.sideName} ${shot.playerName} ${KIND_LABEL[kind]}`}>
            {kind === "goal" && <>
              <span className="fc-flow2-face">
                <PlayerShot action={shot.playerAction} face={shot.playerFace} alt="" />
              </span>
              {shot.seasonIcon && <img className="fc-flow2-season" src={shot.seasonIcon} alt={shot.seasonName ?? ""} />}
              <span className="fc-flow2-chip"><span>{shot.playerName}</span><small>{shot.time}</small></span>
            </>}
            <span className="fc-flow2-tip" role="tooltip">
              <b>{shot.time}{shot.seasonIcon && <img className="fc-flow2-tip-season" src={shot.seasonIcon} alt={shot.seasonName ?? ""} />}{shot.playerName}</b>
              {shot.assistName && <span className="fc-flow2-tip-assist">도움 {shot.assistName}</span>}
              {/* 결과(골·유효·빗나감)는 표시 모양이 이미 말한다. 모양으로 알 수 없는 골대만 적는다. */}
              <small>{shot.sideName} · {shot.type}{shot.hitPost ? " · 골대 맞음" : ""}</small>
            </span>
          </span>
        </div>;
      })}
    </div>

    <div className="fc-flow2-scale">
      {[0, ...marks, span].map((m) => <span key={m} data-minor={m === 105} style={{ left: `${(m / span) * 100}%` }}>{m}&apos;</span>)}
    </div>
    <div className="fc-flow2-legend" aria-hidden="true">
      <span><i className="fc-flow2-key" data-kind="goal"><BallIcon className="fc-flow2-ball" /></i>골</span>
      <span><i className="fc-flow2-key" data-kind="on" />유효 슛</span>
      <span><i className="fc-flow2-key" data-kind="miss" />빗나감</span>
    </div>
    {pens && <p className="fc-flow2-pens">승부차기 {a.shoot.shootOutScore ?? 0} – {b.shoot.shootOutScore ?? 0}</p>}
  </div>;
}
