"use client";

/**
 * 경기 검수 화면의 **시리즈 칸** — 지금 경기가 속한 시리즈를 세트 순서대로 보여 주고(스코어·팀 구성 변화·이상 신호),
 * 시리즈 미지정이면 같은 대회의 앞뒤 경기를 묶을 후보로 보여 준다.
 * 판정은 metrics/series-check.ts(시리즈 비교 화면과 같은 함수), 묶기는 assignMatchSeries 한 곳이다.
 */

import Link from "next/link";
import { useActionState, useEffect, useRef } from "react";

import { assignSeriesAction } from "@/app/admin/ck/actions";
import { IDLE } from "@/lib/action-state";
import { adminHref } from "@/lib/admin-navigation";
import type { MatchSeriesContext, SeriesContextSet } from "@soop-lol/core/lib/db/match-series-review";
import { checkSeries } from "@soop-lol/core/lib/metrics/series-check";
import { isStandaloneSet, isUnbundledSet, setLabel } from "@soop-lol/core/lib/metrics/set-label";

import { ActionMessage } from "./Field";

const clock = (set: SeriesContextSet) => {
  const wall = new Date(set.game_creation_epoch_ms + 9 * 3600_000).toISOString();
  return set.game_creation_precision === "date" ? wall.slice(5, 10).replace("-", ".") : wall.slice(11, 16);
};
// 판은 언제나 시리즈 안에 있다(0089) — 묶지 않은 판은 한 판짜리 시리즈(`set:<경기>`)다.
const unbundled = (set: SeriesContextSet) => isUnbundledSet(set.match_id, set.series_id);
const label = (set: SeriesContextSet) => setLabel({ standalone: isStandaloneSet(set.match_id, set.series_id), unassigned: unbundled(set),
  best_of: set.best_of, set_order_known: set.set_order_known, series_game_no: set.series_game_no, set_role: set.set_role, set_label: set.set_label });
const status = (set: SeriesContextSet) => set.visibility === "hidden" ? "공개 제외" : set.completed ? "검수 완료" : "미검수";
const winner = (set: SeriesContextSet) => set.winning_team ? `${set.winning_team === 100 ? "1팀" : "2팀"} 승` : "승자 미정";
/** 이름이 같은 후보끼리 구별하는 짧은 경기 ID(마지막 토막). 전체 ID 는 title 에 둔다. */
const shortId = (id: string) => id.split(/[-:]/).pop() ?? id;

export function SeriesPanel({ context, matchId, from, compareHref }: {
  context: MatchSeriesContext; matchId: string; from: string; compareHref: string | null;
}) {
  const [state, assign, pending] = useActionState(assignSeriesAction, IDLE);
  // 세트·후보가 많으면 지금 경기 줄이 칸 밖에 있다 — 열 때 그 줄이 보이게 맞춘다(칸 안에서만 스크롤).
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const box = panel.current, row = box?.querySelector<HTMLElement>('li[aria-current="true"]');
    if (box && row && (row.offsetTop < box.scrollTop || row.offsetTop + row.offsetHeight > box.scrollTop + box.clientHeight)) {
      box.scrollTop = row.offsetTop - box.clientHeight / 2;
    }
  }, [matchId]);
  const href = (id: string) => adminHref(`/admin/ck/match/${encodeURIComponent(id)}`, { from });
  const { series } = context;

  if (series) {
    const check = checkSeries(context.sets, series.best_of);
    return <section ref={panel} className="ck-series-panel" aria-label="시리즈">
      <h3>시리즈</h3>
      <p className="ck-series-meta" title={series.best_of_evidence ?? undefined}>
        {series.best_of ? `${series.best_of}판 ${Math.ceil(series.best_of / 2)}선승` : "형식 미확정"}
        {series.best_of_evidence ? ` · 근거 ${series.best_of_evidence.length > 40 ? `${series.best_of_evidence.slice(0, 40)}…` : series.best_of_evidence}` : ""}
        {` · 세트 순서 ${series.set_order_known ? "확인" : "모름"}`}
      </p>
      <ol className="ck-series-sets">
        {context.sets.map((set, index) => {
          const row = check.sets[index];
          return <li key={set.match_id} aria-current={set.match_id === matchId ? "true" : undefined}>
            <Link href={href(set.match_id)} title={set.match_id}>
              <b>{label(set)}</b><time>{clock(set)}</time>
              <span>{winner(set)}</span>
              <span className="tabular-nums">{row.bonus ? "보너스" : row.score ? row.score.join(":") : "?"}</span>
              <span className={set.completed ? "text-win" : "text-ink-400"}>{status(set)}</span>
            </Link>
            {row.changes.map((change) => <p key={change.side} className="ck-series-warn">
              {change.side === 100 ? "1팀" : "2팀"} 교체: {change.left.join(", ") || "—"} → {change.joined.map((p) => p.name).join(", ") || "—"}
            </p>)}
          </li>;
        })}
      </ol>
      {check.warnings.map((warning) => <p key={warning} className="ck-series-warn">⚠ {warning}</p>)}
      <p className="ck-series-meta">스코어는 첫 세트 1팀 기준 — 진영이 바뀌어도 로스터로 팀을 잇는다.</p>
      {compareHref && <a href={compareHref} target="_blank" rel="noreferrer" className="text-[11px] text-accent-400">시리즈 비교로 보기 ↗</a>}
    </section>;
  }

  return <section ref={panel} className="ck-series-panel" aria-label="시리즈">
    <h3>시리즈</h3>
    <p className="ck-series-warn">시리즈 미지정 — 단판인지 다전제의 한 판인지 아직 모릅니다.</p>
    <p className="ck-series-meta">같은 행사의 앞뒤 경기 · 함께 나온 선수 수. 단판이면 경기 정보의 세트 칸에서 &ldquo;단판으로 확인&rdquo;.
      자동 미분류 묶음(분류 대기)의 판은 묶지 않습니다 — 먼저 경기 정보에서 실제 행사로 옮깁니다.</p>
    {/* 지금 경기를 시각 순서 자리에 끼워 둔다 — 앞뒤 어느 경기와 묶을지 한눈에 보이게. */}
    <ol className="ck-series-sets">
      {[...context.candidates, { ...context.sets[0], shared: null }]
        .sort((a, b) => a.game_creation_epoch_ms - b.game_creation_epoch_ms || a.match_id.localeCompare(b.match_id))
        .map((candidate) => candidate.shared == null ? <li key={candidate.match_id} aria-current="true">
          <span className="ck-series-sets-self"><b>지금 경기</b><time>{clock(candidate)}</time><span>{shortId(candidate.match_id)} · {winner(candidate)}</span></span>
        </li> : <li key={candidate.match_id}>
        <Link href={href(candidate.match_id)} title={candidate.match_id}>
          <b>{label(candidate)}</b><time>{clock(candidate)}</time>
          <span>{shortId(candidate.match_id)} · {winner(candidate)}</span>
          <span>같은 선수 {candidate.shared}/{Math.max(candidate.participants.length, context.sets[0].participants.length)}</span>
        </Link>
        <form action={assign}>
          <input type="hidden" name="match_id" value={matchId} />
          <input type="hidden" name={unbundled(candidate) ? "pair_with" : "join_series"} value={unbundled(candidate) ? candidate.match_id : candidate.series_id!} />
          <button disabled={pending} className="text-[11px] text-accent-400 disabled:text-ink-600">
            {unbundled(candidate) ? "이 경기와 새 시리즈로 묶기" : "이 시리즈에 넣기"}
          </button>
        </form>
      </li>)}
      {context.candidates.length === 0 && <li className="ck-series-meta">같은 행사의 앞뒤 12시간 안에 다른 경기가 없습니다.</li>}
    </ol>
    <ActionMessage state={state} />
  </section>;
}
