"use client";

import type { FcoSideView, FcoSquadPlayerView } from "@/lib/fco-match-view";
import { BallIcon } from "./fco-scoreboard";

/**
 * 스쿼드 카드 — 라인업 시트. 두 팀을 좌우 두 컬럼으로.
 * 팀마다 포메이션·평균 평점·평균 강화를 머리에, 선수는 GK / 수비 / 미드필드 / 공격 / 교체로 묶는다.
 */

/* ── 판정 ──────────────────────────────────────── */

type Line = "GK" | "수비" | "미드필드" | "공격";
function lineOf(pos: number): Line {
  if (pos === 0) return "GK";
  if (pos <= 8) return "수비";
  if (pos <= 19) return "미드필드";
  return "공격";
}

/** 포메이션 문자열 — 뒤에서부터 줄별 인원(GK 제외). 예: 4-2-2-2. 줄 구분은 PITCH_ROWS 그대로. */
function formationOf(squad: FcoSquadPlayerView[]): string {
  const field = squad.filter((p) => p.positionId !== 28 && p.positionId !== 0);
  const lines = [[1, 2, 3, 4, 5, 6, 7, 8], [9, 10, 11], [12, 13, 14, 15, 16], [17, 18, 19], [20, 21, 22, 23, 24, 25, 26, 27]];
  const counts = lines.map((ids) => field.filter((p) => ids.includes(p.positionId)).length).filter((n) => n > 0);
  return counts.length ? counts.join("-") : "—";
}

function tone(rating: number | null): "top" | "good" | "low" | "mid" | "none" {
  if (rating == null) return "none";
  return rating >= 8 ? "top" : rating >= 7 ? "good" : rating < 6 ? "low" : "mid";
}

const avg = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;

function teamFacts(side: FcoSideView) {
  const starters = side.squad.filter((p) => p.positionId !== 28);
  return {
    formation: formationOf(side.squad),
    rating: avg(side.squad.filter((p) => p.rating != null).map((p) => p.rating!)),
    grade: avg(starters.map((p) => p.grade)),
  };
}

/** 양 팀 통틀어 평점 1위. 동점이면 먼저 나온 선수. */
function motmKey(sides: FcoSideView[]): string | null {
  let best: FcoSquadPlayerView | null = null;
  for (const side of sides) for (const p of side.squad) if (p.rating != null && (!best || p.rating > (best.rating ?? 0))) best = p;
  return best?.key ?? null;
}

/* ── 버전 1 · 정보 — 라인업 시트 ────────────────────────────────────────
   팀마다 포메이션·평균 평점·평균 강화를 머리에, 선수는 GK / 수비 / 미드필드 / 공격 / 교체로 묶는다. */

export function FcoSquad({ sides }: { sides: FcoSideView[] }) {
  const [a, b] = sides;
  if (!a || !b) return <div className="fc-empty">이 경기의 선수 기록이 없습니다.</div>;
  const motm = motmKey([a, b]);
  return <div className="fc-sq1">
    {[a, b].map((side, i) => {
      const facts = teamFacts(side);
      const groups: { label: string; players: FcoSquadPlayerView[] }[] = [
        ...(["GK", "수비", "미드필드", "공격"] as Line[]).map((line) => ({
          label: line,
          // 같은 줄 안에서는 피치 위 왼쪽 → 오른쪽 순서로 읽히게 번호 내림차순 (번호는 오른쪽에서 왼쪽으로 커진다)
          players: side.squad.filter((p) => p.positionId !== 28 && lineOf(p.positionId) === line).sort((x, y) => y.positionId - x.positionId),
        })),
        { label: "교체", players: side.squad.filter((p) => p.positionId === 28).sort((x, y) => (y.rating ?? -1) - (x.rating ?? -1)) },
      ].filter((g) => g.players.length);
      return <section className="fc-sq1-team" data-side={i} key={side.ouid}>
        <header>
          <b>{side.name}</b>
          <span className="fc-sq1-formation">{facts.formation}</span>
          <span className="fc-sq1-facts">평균 평점 <b>{facts.rating?.toFixed(1) ?? "—"}</b> · 평균 강화 <b>+{facts.grade?.toFixed(1) ?? "—"}</b></span>
        </header>
        {groups.map((group) => <div className="fc-sq1-group" key={group.label}>
          <h4>{group.label}</h4>
          <ul>{group.players.map((p) => <li key={p.key} data-unused={p.rating == null}>
            <span className="fc-sq1-pos">{p.position}</span>
            {p.seasonIcon ? <img className="fc-sq1-season" src={p.seasonIcon} alt={p.seasonName ?? ""} title={p.seasonName ?? undefined} /> : <i className="fc-sq1-season" />}
            <span className="fc-sq1-name">{p.name}{p.key === motm && <em className="fc-sq-motm">MOTM</em>}</span>
            <span className="fc-sq1-grade">+{p.grade}</span>
            <span className="fc-sq1-contrib">
              {p.goal > 0 && <span title={`${p.goal}골`}><BallIcon className="fc-sq1-ball" />{p.goal > 1 && p.goal}</span>}
              {p.assist > 0 && <span className="fc-sq1-assist" title={`${p.assist}도움`}>A{p.assist > 1 && p.assist}</span>}
            </span>
            <span className="fc-sq1-rating" data-tone={tone(p.rating)}>{p.rating == null ? "미출전" : p.rating.toFixed(1)}</span>
          </li>)}</ul>
        </div>)}
      </section>;
    })}
  </div>;
}
