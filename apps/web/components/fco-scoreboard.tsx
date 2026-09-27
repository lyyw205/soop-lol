"use client";

import { useState } from "react";
import { Avatar } from "./avatar";
import type { FcoSideView, FcoSquadPlayerView } from "@/lib/fco-match-view";

/**
 * 경기 상세 맨 위 스코어보드 — 매치데이 포스터.
 * 두 참가자 색이 대각선으로 맞붙고 이긴 쪽 절반만 채도가 산다.
 * 득점자 얼굴은 아래 경기 흐름 카드가 맡으므로 여기선 이름·시간만 적는다.
 */

interface Props { sides: FcoSideView[]; date: string; mode: string; event: string | null }

/* ── 판정 ──────────────────────────────────── */

interface Scorer { key: string; name: string; time: string; ownGoal?: boolean }

function scorersOf(side: FcoSideView, other: FcoSideView | undefined): Scorer[] {
  // 승부차기 골(구간 4)은 경기 득점이 아니라 뺀다. 결과 줄에서 따로 보여준다.
  const goals: Scorer[] = side.shots.filter((shot) => shot.result === 3 && shot.phase < 4)
    .map((shot) => ({ key: `g${shot.index}`, name: shot.playerName, time: shot.time ?? "" }));
  // 상대 자책골은 내 슛 기록에 없지만 내 점수에는 들어간다. 빠뜨리면 점수와 득점자 수가 안 맞는다.
  const own = other?.shoot.ownGoal ?? 0;
  for (let i = 0; i < own; i++) goals.push({ key: `og${i}`, name: "상대 자책골", time: "", ownGoal: true });
  return goals;
}

interface MatchState { label: string; tone: "normal" | "extra" | "forfeit"; shootout: string | null }

function matchState(sides: FcoSideView[]): MatchState {
  const [a, b] = sides;
  const shots = sides.flatMap((side) => side.shots);
  const forfeit = sides.find((side) => side.forfeit);
  const pens = (a?.shoot.shootOutScore ?? 0) + (b?.shoot.shootOutScore ?? 0) > 0 || shots.some((s) => s.phase === 4);
  const shootout = pens ? `승부차기 ${a?.shoot.shootOutScore ?? 0} : ${b?.shoot.shootOutScore ?? 0}` : null;
  if (forfeit) return { label: `${forfeit.name} ${forfeit.forfeit}`, tone: "forfeit", shootout };
  if (pens) return { label: "승부차기 종료", tone: "extra", shootout };
  // 연장은 연장 구간에 슛이 하나라도 있을 때만 확신한다. 슛 없이 끝난 연장은 알 수 없어 "경기 종료"로 둔다.
  if (shots.some((s) => s.phase >= 2)) return { label: "연장 종료", tone: "extra", shootout };
  return { label: "경기 종료", tone: "normal", shootout };
}

function mvpOf(sides: FcoSideView[]): (FcoSquadPlayerView & { sideName: string; sideIndex: number }) | null {
  let best: (FcoSquadPlayerView & { sideName: string; sideIndex: number }) | null = null;
  sides.forEach((side, sideIndex) => side.squad.forEach((player) => {
    if (player.rating == null) return;
    if (!best || player.rating > (best.rating ?? 0)) best = { ...player, sideName: side.name, sideIndex };
  }));
  return best;
}

/** 이모지 ⚽ 는 폰트가 없는 환경에서 □ 로 깨진다. 작은 SVG 로 직접 그린다. */
export function BallIcon({ className = "fc-sb2-ball" }: { className?: string }) {
  return <svg className={className} viewBox="0 0 16 16" aria-hidden="true">
    <circle cx="8" cy="8" r="7" fill="#f4f7fb" />
    <path d="M8 4.6 10.9 6.7 9.8 10H6.2L5.1 6.7Z" fill="#0b1119" />
    <path d="M8 1v3.6M10.9 6.7l3.6-1M9.8 10l2 3.2M6.2 10l-2 3.2M5.1 6.7l-3.6-1" stroke="#0b1119" strokeWidth="1" />
    <circle cx="8" cy="8" r="7" fill="none" stroke="#0b1119" strokeWidth=".6" />
  </svg>;
}

/** 액션샷은 오래된 시즌에 없다(403). 실패하면 얼굴로 떨어뜨린다. */
export function PlayerShot({ action, face, alt, className }: {
  action: string | null; face: string | null; alt: string; className?: string;
}) {
  const sources = [action, face].filter((src): src is string => !!src);
  const [index, setIndex] = useState(0);
  const src = sources[index];
  if (!src) return null;
  return <img className={className} src={src} alt={alt} loading="lazy" onError={() => setIndex((i) => i + 1)} />;
}

/* ── 스코어보드 ─────────────────────────────────────────────── */

export function FcoScoreboard({ sides, date, mode, event }: Props) {
  const [a, b] = sides;
  const state = matchState(sides);
  const mvp = mvpOf(sides);
  const winner = sides.findIndex((side) => side.outcome === "win");

  return <section className="fc-sb2" data-winner={winner} aria-label="경기 결과">
    <div className="fc-sb2-half" data-side={0} aria-hidden="true" />
    <div className="fc-sb2-half" data-side={1} aria-hidden="true" />
    <div className="fc-sb2-pitch" aria-hidden="true" />

    <div className="fc-sb2-body">
      <p className="fc-sb2-kicker">{event ?? "일반 경기"} <span>·</span> {mode}</p>

      {/* 프로필 줄과 득점자 줄을 나눈다. 한 칸에 묶으면 골이 많은 쪽이 길어지면서 점수가 한쪽으로 쏠린다. */}
      <div className="fc-sb2-main">
        {[a, b].map((side, i) => side && <div className="fc-sb2-side" data-side={i} data-win={side.outcome === "win"} key={side.ouid}>
          <div className="fc-sb2-avatar">
            <Avatar name={side.name} src={side.image} channelId={side.channelId} />
            {side.outcome === "win" && <span className="fc-sb2-win">WIN</span>}
          </div>
          <b className="fc-sb2-name">{side.name}</b>
          {side.divisionName && <span className="fc-sb2-div">{side.divisionName}</span>}
        </div>)}

        <div className="fc-sb2-center">
          <div className="fc-sb2-score">
            <span data-win={a?.outcome === "win"}>{a?.score ?? "?"}</span>
            <i>VS</i>
            <span data-win={b?.outcome === "win"}>{b?.score ?? "?"}</span>
          </div>
          <span className="fc-sb2-state" data-tone={state.tone}>{state.label}</span>
          {state.shootout && <span className="fc-sb2-pens">{state.shootout}</span>}
          <span className="fc-sb2-date">{date}</span>
        </div>

        {[a, b].map((side, i) => side && <ul className="fc-sb2-scorers" data-side={i} key={`s-${side.ouid}`} aria-label={`${side.name} 득점`}>
          {scorersOf(side, sides[1 - i]).map((g) => <li key={g.key} data-own={g.ownGoal}>
            <BallIcon />
            <span>{g.name}</span>
            {g.time && <small>{g.time}</small>}
          </li>)}
        </ul>)}

        {mvp && <div className="fc-sb2-mvp" data-side={mvp.sideIndex}>
          <PlayerShot className="fc-sb2-mvp-shot" action={mvp.action} face={mvp.face} alt={`${mvp.name} 액션샷`} />
          <div>
            <span className="fc-sb2-mvp-label">MATCH MVP</span>
            <b className="fc-sb2-mvp-name">
              {mvp.seasonIcon && <img className="fc-sb2-season" src={mvp.seasonIcon} alt={mvp.seasonName ?? ""} title={mvp.seasonName ?? undefined} />}
              {mvp.name}
            </b>
            <small>{mvp.sideName} · {mvp.position}{mvp.goal ? ` · ${mvp.goal}골` : ""}{mvp.assist ? ` ${mvp.assist}도움` : ""}</small>
          </div>
          <strong className="fc-sb2-mvp-rating">{mvp.rating?.toFixed(1)}</strong>
        </div>}
      </div>

      {state.tone === "forfeit" && <p className="fc-sb2-forfeit">몰수 경기 — 아래 지표는 끝까지 치른 경기와 다릅니다</p>}
    </div>
  </section>;
}
