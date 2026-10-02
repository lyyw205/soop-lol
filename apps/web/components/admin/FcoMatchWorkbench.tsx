"use client";

/**
 * FC 검수 작업대 — 방송·대회·단독 경기 **세 단위가 같이 쓰는 하나**. 경기 하나 = 키 하나, 그 경기를 본 것들은 **시점 칩**.
 *
 *   ┌──────────────┬──────────────────────────────────┬────────────────────┐
 *   │ 큐(↑↓)        │ [넥슨 기록] [스맵임 VOD ●] [상대 VOD]   │ (대회면 [대회]/[경기] 탭)│
 *   │ 대회면 「대회   │  고른 시점의 VOD 프레임(← →)           │ 이 시점 · 경기 값 ·    │
 *   │ 공통」+포함/제외 │                                    │ 대회 결정 · 맥락 · 완료 │
 *   └──────────────┴──────────────────────────────────┴────────────────────┘
 *
 * ★ 묶음 규칙은 core 하나다 — 정본 경기·시점은 match-units.ts, 대전(목록 단위)은 sessions.ts. 이 화면은 그 결과를 보여 줄 뿐이다.
 * ★ 대회 단위는 예전 맥락 검수 작업대(FcoWorkspace)의 기능을 그대로 옮겼다 — 대회 공통 화면, 포함/제외·브래킷, 대회 승인/보류,
 *   행사 정보, 다전제 집계, 조사 기록, 근거 직접 추가(2026-10-02, 작업대 두 벌을 하나로).
 * ★ 고친 값을 저장하지 않은 채 완료하거나 다른 경기로 가지 못하게 한다 — 「저장하고 검수 완료」가 주 동작이다.
 * ★ 공개 여부는 바꾸지 않는다. 완료는 "사람이 봤다"는 도장이다(대회 포함/제외는 원래대로 곧바로 공개에 반영된다).
 */

import { useActionState, useEffect, useMemo, useState } from "react";

import type { FcoEventOption, FcoReviewUnit } from "@soop-lol/core/lib/games/fconline/context";
import type { FcoCandidate, FcoMatchUnit, FcoMatchView, FcoSide, FcoViewFrame } from "@soop-lol/core/lib/games/fconline/match-units";
import { fcoSeriesScore, fcoSeriesStanding } from "@soop-lol/core/lib/games/fconline/series";

import {
  linkScreenAction, saveAndCompleteAction, saveScreenSidesAction, setMatchCompletedAction, unlinkScreenAction,
} from "@/app/admin/fco/vod/actions";
import { IDLE } from "@/lib/action-state";

import { FcoContextReviewer } from "./FcoContextReviewer";
import { ActionMessage, SubmitButton } from "./Field";
import { decisionBadge, EventDecision, EventTab, FcoReviewControls, type ReviewControlsUnit } from "./FcoReviewParts";
import { VodFrameViewer, type ViewerVod } from "./VodFrameViewer";

const inputClass =
  "w-full rounded border border-ink-700 bg-ink-950 px-2 py-1 text-xs text-ink-200 " +
  "placeholder:text-ink-400/50 outline-none focus:border-accent-600";
const kst = (iso: string) => new Date(iso).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const hms = (sec: number | null) => {
  const v = sec ?? 0;
  return `${Math.floor(v / 3600)}:${String(Math.floor((v % 3600) / 60)).padStart(2, "0")}:${String(v % 60).padStart(2, "0")}`;
};
const BASIS_LABEL: Record<string, string> = { vod_owner: "방송 주인", nickname_match: "닉네임 일치", manual: "사람이 지정" };
const OUTCOME_LABEL: Record<string, string> = { win: "승", loss: "패", draw: "무", unknown: "?" };
const VERDICT_LABEL: Record<FcoCandidate["verdict"], string> = { same: "일치", maybe: "일부 일치", none: "같은 사람이 낀 가까운 경기" };
const UNSAVED = "저장하지 않은 값이 있습니다. 버리고 이동할까요?";
const COMMON = "__common";

const sidesText = (sides: FcoSide[]) => sides.map((s) => `${s.name} ${s.score ?? "?"}`).join(" : ");
const viewLabel = (v: FcoMatchView) => (v.kind === "api" ? "넥슨 기록" : `${v.streamer ?? "VOD"} · ${v.vod}`);
const hasMismatch = (m: FcoMatchUnit) => m.views.some((v) => v.mismatches.length > 0);
/** 저장된 결과를 편집 선택지로. 점수로 정해지는 결과와 같으면 auto, 아니면 직접 본 결과(승부차기 등). */
function outcomeEditOf(scoreA: number | null, scoreB: number | null, outcomeA: string | null): "auto" | "first_win" | "second_win" | "draw" {
  const byScore = scoreA == null || scoreB == null || scoreA === scoreB ? "unknown" : scoreA > scoreB ? "win" : "loss";
  if (outcomeA == null || outcomeA === byScore) return "auto";
  return outcomeA === "win" ? "first_win" : outcomeA === "loss" ? "second_win" : outcomeA === "draw" ? "draw" : "auto";
}
/** 처음 보여 줄 시점 — 결과 화면 사진이 있는 VOD 시점, 없으면 첫 VOD 시점, 그것도 없으면 넥슨 기록 */
const firstView = (m: FcoMatchUnit) =>
  m.views.find((v) => v.kind === "vod" && v.frames.some((f) => f.result)) ?? m.views.find((v) => v.kind === "vod") ?? m.views[0];

/**
 * 대회 단위 — 사진을 시간으로 다시 묶는다(예전 맥락 검수와 같은 규칙).
 *   경기 시간대 = [시작 3분 전, 종료 2분 후]. 시작 = 넥슨 matchId 앞 8자리(유닉스 초, 실측), 종료 = 기록 시각.
 *   사진이 그 경기 시간대 밖이면 시간이 맞는 다른 경기로, 어느 경기에도 안 들면 「대회 공통」(오프닝·소개·명단·브래킷·순위·마무리).
 *   VOD 시작 시각이나 넥슨 번호를 모르면 원래 자리에 둔다.
 */
function regroupEventFrames(matches: FcoMatchUnit[], vodStarts: Record<number, number>): { matches: FcoMatchUnit[]; common: FcoViewFrame[] } {
  const windows = matches.filter((m) => m.provider_match_id).map((m) => ({
    id: m.match_id, a: parseInt(m.provider_match_id!.slice(0, 8), 16) * 1000 - 180_000, b: Date.parse(m.played_at) + 120_000,
  }));
  const moved = new Map<string, FcoViewFrame[]>();
  const common: FcoViewFrame[] = [];
  const kept = matches.map((m) => ({
    ...m,
    views: m.views.map((v) => ({
      ...v,
      frames: v.frames.filter((f) => {
        const start = f.vod ? vodStarts[Number(f.vod)] : undefined;
        if (start == null || f.sec == null || !m.provider_match_id) return true;
        const t = start + f.sec * 1000;
        const own = windows.find((w) => w.id === m.match_id);
        if (own && t >= own.a && t <= own.b) return true;
        const other = windows.find((w) => t >= w.a && t <= w.b);
        if (other) (moved.get(other.id) ?? moved.set(other.id, []).get(other.id)!).push(f); else common.push(f);
        return false;
      }),
    })),
  }));
  const out = kept.map((m) => {
    const extra = moved.get(m.match_id);
    if (!extra?.length) return m;
    const views = [...m.views];
    for (const f of extra) {
      const key = `vod:${f.vod}`;
      const i = views.findIndex((v) => v.key === key);
      if (i >= 0) views[i] = { ...views[i], frames: [...views[i].frames, f].sort((x, y) => (x.sec ?? 0) - (y.sec ?? 0)) };
      else views.push({ key, kind: "vod", vod: f.vod, streamer: null, screen: null, sides: null, frames: [f], mismatches: [] });
    }
    return { ...m, views };
  });
  return { matches: out, common: common.sort((x, y) => (x.sec ?? 0) - (y.sec ?? 0)) };
}

type Filter = "all" | "todo" | "mismatch" | "lonely";

export interface WorkbenchEvent {
  /** 대회 결정·후보·행사 정보(예전 맥락 검수 단위 그대로) */
  unit: FcoReviewUnit;
  vodStarts: Record<number, number>;
}

/** 대전 단위면 준다 — 오른쪽에 [대전]/[경기] 탭, 대전 전체에 맥락 한 번에 적용 */
export interface WorkbenchSession {
  /** pair = 스트리머 vs 스트리머(맥락을 가른다) · 그 밖은 일반 유저전(값만 확인) */
  kind: "meet" | "solo" | "names";
  /** 모임 안의 두 사람 대전들 */
  pairs: { title: string; total: number }[];
  title: string;
  people: { slug: string; name: string }[];
  vods: string[];
}

export function FcoMatchWorkbench({ matches: rawMatches, streamers, vods, eventOptions, initialMatchId, event, session, queueTitle }: {
  matches: FcoMatchUnit[];
  streamers: { slug: string; display_name: string; has_fc: boolean }[];
  vods: Record<string, ViewerVod>;
  eventOptions: FcoEventOption[];
  initialMatchId?: string;
  /** 대회 단위면 준다 — 큐에 대회 공통·포함/제외, 오른쪽에 [대회]/[경기] 탭 */
  event?: WorkbenchEvent;
  session?: WorkbenchSession;
  queueTitle: string;
}) {
  const { matches, common } = useMemo(
    () => (event ? regroupEventFrames(rawMatches, event.vodStarts) : { matches: rawMatches, common: [] as FcoViewFrame[] }),
    [rawMatches, event],
  );
  const decisionOf = (id: string) => event?.unit.matches.find((x) => x.match_id === id) ?? null;
  const first = matches.find((m) => m.match_id === initialMatchId) ?? (common.length && event ? null : matches.find((m) => !m.review_completed_at) ?? matches[0]);
  const [selectedId, setSelectedId] = useState<string | null>(first?.match_id ?? (event && common.length ? COMMON : matches[0]?.match_id ?? null));
  const [viewKey, setViewKey] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState<"event" | "match">(selectedId === COMMON ? "event" : "match");

  const selected = selectedId === COMMON ? null : matches.find((m) => m.match_id === selectedId) ?? null;
  const view = selected ? selected.views.find((v) => v.key === viewKey) ?? firstView(selected) ?? null : null;
  const done = matches.filter((m) => m.review_completed_at).length;
  const visible = useMemo(() => matches.filter((m) => {
    if (filter === "todo") return !m.review_completed_at;
    if (filter === "mismatch") return hasMismatch(m);
    if (filter === "lonely") return m.source === "manual" && m.views.length <= 1;
    return true;
  }), [matches, filter]);
  const rows = [...(event && common.length ? [COMMON] : []), ...visible.map((m) => m.match_id)];

  // 고친 값을 저장하지 않았으면 다른 경기로 가기 전에 묻는다.
  const pick = (id: string) => {
    if (id === selectedId) return;
    if (dirty && !window.confirm(UNSAVED)) return;
    setDirty(false); setSelectedId(id); setViewKey(null); setTab(id === COMMON ? "event" : "match");
  };
  // ↑↓ — 큐 이동(← → 는 뷰어의 프레임 이동). 입력칸에서는 가로채지 않는다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      const t = e.target as HTMLElement | null;
      if (t?.matches("input, textarea, select, [contenteditable=true]")) return;
      const i = rows.indexOf(selectedId ?? "");
      const next = rows[e.key === "ArrowDown" ? Math.min(i + 1, rows.length - 1) : Math.max(i - 1, 0)];
      if (!next) return;
      e.preventDefault();
      pick(next);
      requestAnimationFrame(() => document.getElementById(`fcb-${next}`)?.scrollIntoView({ block: "nearest" }));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  // 저장 안 한 채 페이지를 떠나려 할 때도 묻는다.
  useEffect(() => {
    if (!dirty) return;
    const onLeave = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [dirty]);

  // 뷰어 재료 — VOD 마다 결과 화면 초(★)
  const resultSecs = useMemo(() => {
    const out: Record<string, number[]> = {};
    for (const m of matches) for (const v of m.views) for (const f of v.frames) if (f.result && f.vod && f.sec != null) (out[f.vod] ??= []).push(f.sec);
    return out;
  }, [matches]);
  const evidence = useMemo(() => (selectedId === COMMON ? common : view?.frames ?? []).map((f) => ({ ...f })), [view, selectedId, common]);

  // 대회 안의 다전제 — 세트를 모아 집계한다. 규칙은 core 하나다.
  const seriesStandings = useMemo(() => {
    if (!event) return [];
    const by = new Map<string, FcoReviewUnit["matches"]>();
    for (const m of event.unit.matches) if (m.series_id) by.set(m.series_id, [...(by.get(m.series_id) ?? []), m]);
    return [...by].map(([id, sets]) => ({
      id,
      standing: fcoSeriesStanding(sets.map((m) => ({
        series_id: m.series_id, series_game_no: m.series_game_no, best_of: m.best_of,
        participants: m.participants.map((p) => ({ ouid: p.ouid, nickname: p.name, outcome: p.outcome, side_no: 0 })),
      }))),
    }));
  }, [event]);

  const FILTERS: [Filter, string][] = [["all", "전체"], ["todo", "미완료"], ["mismatch", "시점 불일치"], ["lonely", "화면으로만 본 경기"]];
  const grouped = !!event || !!session;
  const showEventTab = grouped && (tab === "event" || !selected);

  return (
    <div className="ck-review-workbench">
      <div className="ck-review-stage">
        {/* ── 가운데: 시점 칩 + 그 시점의 프레임 ── */}
        {/* ★ 세로 flex — 격자로 감싸면 프레임 칸의 CSS(grid-column: 2)가 이 안에서 칸을 하나 더 만든다 */}
        <div className="flex min-h-0 min-w-0 flex-col gap-2 [&>section]:min-h-0 [&>section]:flex-1" style={{ gridColumn: 2, gridRow: 1 }}>
          {selected && (
            <nav className="flex flex-wrap gap-1.5" aria-label="시점 선택">
              {selected.views.map((v) => (
                <button key={v.key} type="button" onClick={() => setViewKey(v.key)} aria-current={v.key === view?.key ? "true" : undefined}
                  title={v.kind === "api" ? "넥슨 API 가 준 공식 값" : `${v.vod} 방송 화면${v.screen ? " — 화면에서 읽은 값 있음" : " — 근거 사진만"}`}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs ${v.key === view?.key
                    ? "border-accent-600/60 bg-accent-600/15 text-accent-400" : "border-ink-700 text-ink-300 hover:text-ink-100"}`}>
                  {viewLabel(v)}
                  {v.kind === "vod" && <span className="text-[10px] text-ink-500">{v.frames.length}장</span>}
                  {v.mismatches.length > 0 && <span className="h-1.5 w-1.5 rounded-full bg-amber-400" aria-label={`경기 값과 다른 곳 ${v.mismatches.length}`} />}
                </button>
              ))}
            </nav>
          )}
          {selectedId === COMMON && <p className="text-xs text-ink-400">대회 공통 — 어느 경기 시간대에도 안 드는 화면(오프닝·소개·명단·브래킷·순위·마무리)</p>}
          {view?.kind === "api" && selectedId !== COMMON ? (
            <section className="ck-review-preview p-4 text-sm">
              <p className="text-xs text-ink-400">넥슨 기록은 사진이 없습니다 — API 가 준 공식 값입니다. VOD 시점 칩을 고르면 그 방송 화면을 봅니다.</p>
              <table className="mt-3 text-sm"><tbody>
                {(view.sides ?? []).map((s, i) => (
                  <tr key={i}><td className="pr-4 text-ink-200">{s.name}{s.name !== s.nickname && <span className="ml-1 text-[11px] text-ink-500">({s.nickname})</span>}</td>
                    <td className="pr-4 font-mono">{s.score ?? "?"}</td><td className="text-ink-400">{OUTCOME_LABEL[s.outcome ?? "unknown"]}</td></tr>
                ))}
              </tbody></table>
            </section>
          ) : (
            <VodFrameViewer key={`${selectedId ?? "none"}:${view?.key ?? ""}`} evidence={evidence} vods={vods} resultSecs={resultSecs}
              emptyText={selectedId === COMMON ? "대회 공통 화면이 없습니다." : selected ? "이 시점에는 사진이 없습니다." : "검수할 경기가 없습니다."} />
          )}
        </div>

        {/* ── 오른쪽: (대회면 [대회]/[경기] 탭) 이 시점 · 경기 값 · 대회 결정 · 맥락 · 완료 ── */}
        <aside className="ck-review-inspector" aria-label="검수 정보">
          <div className="ck-review-inspector-shell">
            {grouped && (
              <div className="ck-review-inspector-tabs" role="tablist" aria-label="검수 정보">
                <button type="button" role="tab" aria-selected={showEventTab} onClick={() => setTab("event")}>{event ? "대회" : session && session.pairs.length > 1 ? "모임" : "대전"}</button>
                <button type="button" role="tab" aria-selected={!showEventTab} disabled={!selected} onClick={() => setTab("match")}>경기</button>
              </div>
            )}
            <div className="ck-review-inspector-body">
              {showEventTab && session ? (
                <SessionTab session={session} matches={matches} eventOptions={eventOptions} onPick={(id) => pick(id)} />
              ) : showEventTab ? (
                <div className="grid gap-4 p-1 text-sm">
                  <EventTab unit={event!.unit}>
                    {seriesStandings.map(({ id, standing }) => (
                      <section key={id} className="grid gap-1 rounded-lg border border-ink-800 bg-ink-900/40 px-3 py-2">
                        <h4 className="text-[11px] font-semibold text-ink-400">다전제 {standing.best_of ? `Bo${standing.best_of}` : "(형식 미확인)"} · {standing.sets}세트</h4>
                        <p className="text-sm text-ink-200">{standing.sides.map((side) => side.name).join(" vs ")}<b className="ml-2 tabular-nums text-accent-400">{fcoSeriesScore(standing)}</b></p>
                      </section>
                    ))}
                  </EventTab>
                </div>
              ) : selected ? (
                <MatchPanel key={`${selected.match_id}:${selected.review_version}`} m={selected} view={view} streamers={streamers}
                  eventOptions={eventOptions} dirty={dirty} onDirty={setDirty}
                  decision={event && decisionOf(selected.match_id) ? <EventDecision unit={event.unit} match={decisionOf(selected.match_id)!} matchRef={selected.provider_match_id ?? selected.match_id} /> : null} />
              ) : <div className="ck-review-panel p-4 text-xs text-ink-400">큐에서 경기를 고르세요.</div>}
            </div>
          </div>
        </aside>
      </div>

      {/* ── 왼쪽: 큐 ── */}
      <section className="ck-review-timeline" aria-label="검수 큐">
        <header className="ck-review-queue-head">
          <h3>{queueTitle}</h3>
          <p>완료 {done} / {matches.length} · ↑↓ 이동</p>
          <div className="flex flex-wrap gap-1">
            {FILTERS.map(([key, label]) => (
              <button key={key} type="button" onClick={() => setFilter(key)}
                className={`rounded border px-2 py-0.5 text-[11px] ${filter === key ? "border-accent-600 text-accent-400" : "border-ink-700 text-ink-400 hover:text-ink-200"}`}>{label}</button>
            ))}
          </div>
        </header>
        <ul className="ck-review-queue-list">
          {event && common.length > 0 && (
            <li id={`fcb-${COMMON}`}>
              <button type="button" className="ck-review-queue-item" aria-current={selectedId === COMMON ? "true" : undefined} onClick={() => pick(COMMON)}
                title="어느 경기 시간대에도 안 드는 화면 — 오프닝·선수 소개·명단·브래킷·순위·마무리">
                <span className="min-w-0"><span className="block text-xs text-ink-200">대회 공통</span><span className="block text-[10px] text-ink-400">경기 밖 화면 · {common.length}장</span></span>
                <span />
              </button>
            </li>
          )}
          {visible.map((m, i) => {
            const d = decisionOf(m.match_id);
            const firstExcluded = d?.decision === "exclude" && decisionOf(visible[i - 1]?.match_id ?? "")?.decision !== "exclude";
            const badge = d ? decisionBadge(d) : null;
            return (
              <li key={m.match_id} id={`fcb-${m.match_id}`} className={d?.decision === "exclude" ? "opacity-60" : undefined}>
                {firstExcluded && <p className="px-2.5 pb-1 pt-3 text-[10px] font-semibold text-ink-500">대회 밖으로 뺀 경기</p>}
                <button type="button" className="ck-review-queue-item" aria-current={m.match_id === selectedId ? "true" : undefined} onClick={() => pick(m.match_id)}>
                  <span className="min-w-0">
                    <span className="block truncate text-xs text-ink-200">
                      {d?.bracket_label ? `${d.bracket_label} · ` : d?.series_id ? `${d.series_game_no ?? "?"}세트 · ` : ""}{m.sides.length === 2 ? sidesText(m.sides) : m.match_id}
                    </span>
                    <span className="block truncate text-[10px] text-ink-400">
                      {kst(m.played_at)} · {m.source === "provider_api" ? "넥슨" : "화면"}{m.views.length > 1 ? ` · 시점 ${m.views.length}` : ""}
                    </span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-0.5 text-[10px]">
                    {badge && <span className={`font-bold ${badge.cls}`} title={badge.text}>{d!.decision === "include" ? "포함" : d!.decision === "exclude" ? "제외" : "미정"}{d!.decision_by === "admin" ? " ✓" : ""}</span>}
                    <span className={m.review_completed_at ? "text-win" : "text-ink-400"}>{m.review_completed_at ? "완료" : "미검수"}</span>
                    {hasMismatch(m) && <span className="text-amber-400">불일치</span>}
                  </span>
                </button>
              </li>
            );
          })}
          {visible.length === 0 && <li className="ck-review-queue-empty">해당하는 경기가 없습니다.</li>}
        </ul>
      </section>
    </div>
  );
}

// ── 오른쪽 칸 ─────────────────────────────────────────────────────────

function MatchPanel({ m, view, streamers, eventOptions, dirty, onDirty, decision }: {
  m: FcoMatchUnit; view: FcoMatchView | null; streamers: { slug: string; display_name: string; has_fc: boolean }[];
  eventOptions: FcoEventOption[]; dirty: boolean; onDirty: (v: boolean) => void;
  /** 대회 단위면 이 경기의 포함/제외 결정 폼 */
  decision?: React.ReactNode;
}) {
  const [saveState, saveAction] = useActionState(saveScreenSidesAction, IDLE);
  const [bothState, bothAction] = useActionState(saveAndCompleteAction, IDLE);
  const [doneState, doneAction, donePending] = useActionState(setMatchCompletedAction, IDLE);
  const completed = m.review_completed_at != null;
  const [a, b] = m.sides;
  const outcomeDefault = outcomeEditOf(a?.score ?? null, b?.score ?? null, a?.outcome ?? null);

  return (
    <div className="grid gap-3">
      <div className="ck-review-panel p-3">
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink-400">
          <span>{kst(m.played_at)}</span>
          {m.mode_key && <span>모드 {m.mode_key}</span>}
          <span className={`ml-auto rounded border px-1.5 py-0.5 ${m.editable ? "border-amber-400/40 text-amber-400" : "border-accent-600/40 text-accent-400"}`}>
            {m.editable ? "화면 기록이 정본 · 수기 · 숨김" : "넥슨 기록이 정본"}
          </span>
        </div>
        <p className="mt-1 break-all font-mono text-[10px] text-ink-400">{m.match_id}</p>
      </div>

      {view && <ViewPanel view={view} />}

      {decision}

      {m.editable ? (
        <form action={saveAction} onChange={() => onDirty(true)} className="ck-review-panel grid gap-3 p-3">
          <p className="text-[11px] font-semibold text-ink-200">경기 값</p>
          <input type="hidden" name="match_id" value={m.match_id} />
          <input type="hidden" name="version" value={m.review_version} />
          {[a, b].map((s, i) => s && (
            <fieldset key={i} className="grid gap-1.5">
              <legend className="mb-0.5 text-[11px] font-semibold text-ink-200">{i === 0 ? "1팀" : "2팀"}</legend>
              <div className="grid grid-cols-[1fr_56px] gap-1.5">
                <input name={`nickname${i + 1}`} defaultValue={s.nickname} className={inputClass} placeholder="화면 닉네임" aria-label={`${i + 1}팀 닉네임`} />
                <input name={`score${i + 1}`} defaultValue={s.score ?? ""} inputMode="numeric" className={`${inputClass} text-center font-mono`} placeholder="점수" aria-label={`${i + 1}팀 점수`} />
              </div>
              <select name={`streamer${i + 1}`} defaultValue="" className={inputClass} aria-label={`${i + 1}팀 사람`}>
                <option value="">{s.streamer_id ? `그대로 — ${s.name} (${BASIS_LABEL[s.identity_basis ?? ""] ?? "근거 없음"})` : "그대로 — 사람 없음"}</option>
                <option value="__auto">닉네임으로 다시 판정 (등록 계정과 하나만 일치할 때)</option>
                {s.streamer_id && <option value="__none">사람 떼기</option>}
                <optgroup label="FC 계정 등록됨">
                  {streamers.filter((st) => st.has_fc).map((st) => <option key={st.slug} value={st.slug}>{st.display_name}</option>)}
                </optgroup>
                <optgroup label="그 밖의 공개 스트리머">
                  {streamers.filter((st) => !st.has_fc).map((st) => <option key={st.slug} value={st.slug}>{st.display_name}</option>)}
                </optgroup>
              </select>
            </fieldset>
          ))}
          <label className="grid gap-1 text-[11px] text-ink-400">
            결과
            <select name="outcome" defaultValue={outcomeDefault} className={inputClass}>
              <option value="auto">점수로 정함 (같으면 모름)</option>
              <option value="first_win">1팀 승 (승부차기 등)</option>
              <option value="second_win">2팀 승 (승부차기 등)</option>
              <option value="draw">무승부</option>
            </select>
          </label>
          <div className="flex flex-wrap items-center gap-2">
            {/* 주 동작: 저장과 완료를 한 번에 — 고친 값을 저장하지 않고 완료하는 일이 없게 */}
            <button type="submit" formAction={bothAction} className="rounded-lg bg-accent-600 px-3 py-2 text-sm font-medium text-ink-950 hover:bg-accent-500">
              저장하고 검수 완료
            </button>
            <SubmitButton tone="ghost">값만 저장</SubmitButton>
            {dirty && <span className="text-[11px] text-amber-400">저장하지 않은 값이 있습니다</span>}
          </div>
          <ActionMessage state={bothState.message ? bothState : saveState} />
        </form>
      ) : (
        <div className="ck-review-panel grid gap-1 p-3 text-xs">
          <p className="text-[11px] font-semibold text-ink-200">경기 값 — 넥슨 기록(고치지 않음)</p>
          <p className="text-ink-200">{sidesText(m.sides)}</p>
          <p className="text-[11px] text-ink-400">점수·승패는 넥슨 API 가 정본입니다. 화면 시점이 다르게 읽었으면 그 시점의 오독입니다.</p>
        </div>
      )}

      {m.editable && <CandidatePanel m={m} />}

      <ContextPanel m={m} eventOptions={eventOptions} />

      <form action={doneAction} className="ck-review-panel flex flex-wrap items-center gap-2 p-3">
        <input type="hidden" name="match_id" value={m.match_id} />
        <input type="hidden" name="version" value={m.review_version} />
        <input type="hidden" name="completed" value={completed ? "0" : "1"} />
        <span className={`text-xs ${completed ? "text-win" : "text-ink-400"}`}>{completed ? "검수 완료" : "미검수"}</span>
        <button type="submit" disabled={donePending || (dirty && !completed)} title={dirty && !completed ? "고친 값을 먼저 저장하세요 — 위의 「저장하고 검수 완료」" : undefined}
          className="rounded border border-ink-700 px-2 py-1 text-xs text-ink-200 hover:border-accent-400 disabled:opacity-40">
          {donePending ? "저장 중" : completed ? "완료 취소" : "검수 완료"}
        </button>
        <ActionMessage state={doneState} />
        {dirty && !completed && <p className="w-full text-[11px] text-amber-400">고친 값이 저장되지 않았습니다 — 「저장하고 검수 완료」를 쓰세요.</p>}
        <p className="w-full text-[11px] text-ink-400">완료해도 공개되지 않습니다. 공개 표시는 별도 단계입니다.</p>
      </form>

      {m.notes.length > 0 && (
        <section className="ck-review-panel grid gap-1.5 p-3">
          <h4 className="text-[11px] font-semibold text-ink-200">조사 기록 — 사진 없는 근거 ({m.notes.length})</h4>
          {m.notes.map((n) => (
            <div key={n.key} className="rounded-md border border-ink-800 bg-ink-900/40 px-2.5 py-1.5 text-[12px]">
              <span className="font-mono text-[10px] text-ink-500">{n.vod ? `${n.vod} ${hms(n.sec)} ` : ""}{n.kind}</span>
              <p className="text-ink-200">{n.observed}</p>
              {n.why && <p className="text-ink-400">판단: {n.why}</p>}
              {n.url && <a href={n.url} target="_blank" rel="noreferrer" className="text-[11px] text-accent-400">출처 ↗</a>}
            </div>
          ))}
        </section>
      )}
      <details className="ck-review-panel p-3">
        <summary className="cursor-pointer text-[11px] text-ink-400 hover:text-ink-200">근거 직접 추가</summary>
        <div className="mt-3"><FcoContextReviewer providerMatchId={m.match_id} /></div>
      </details>
    </div>
  );
}

/** 고른 시점이 읽은 값과, 경기 값과 다른 곳. 이어 붙은 화면 기록이면 떼어 낼 수 있다(잘못 이었을 때). */
function ViewPanel({ view }: { view: FcoMatchView }) {
  const [state, detach] = useActionState(unlinkScreenAction, IDLE);
  if (view.kind === "api") return null;
  return (
    <div className="ck-review-panel grid gap-1.5 p-3 text-xs">
      <p className="text-[11px] font-semibold text-ink-200">이 시점 — {viewLabel(view)}</p>
      {view.sides ? (
        <p className="text-ink-200">화면에서 읽은 값: {view.sides.map((s) => `${s.nickname} ${s.score ?? "?"}`).join(" : ")}</p>
      ) : <p className="text-ink-400">이 시점은 근거 사진만 있습니다(값을 따로 읽지 않았습니다).</p>}
      {view.mismatches.length > 0 ? (
        <ul className="grid gap-0.5 text-[11px]">
          {view.mismatches.map((x, i) => <li key={i} className="text-amber-400">● {x.field}: 경기 {x.match} · 이 시점 {x.view}</li>)}
        </ul>
      ) : view.sides && view.screen?.linked ? <p className="text-[11px] text-win">경기 값과 같습니다.</p> : null}
      {view.screen?.linked && (
        <form action={detach} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="match_id" value={view.screen.match_id} />
          <input type="hidden" name="version" value={view.screen.review_version} />
          <span className="text-[11px] text-ink-400">{view.screen.linked.decided_by === "admin" ? "사람이" : "자동으로(참가자·시각 ±3분·스코어)"} 이 경기에 붙였습니다.</span>
          <SubmitButton tone="danger">이 시점 떼기</SubmitButton>
          <ActionMessage state={state} />
        </form>
      )}
    </div>
  );
}

function CandidatePanel({ m }: { m: FcoMatchUnit }) {
  const [state, link] = useActionState(linkScreenAction, IDLE);
  return (
    <div className="ck-review-panel grid gap-2 p-3">
      <p className="text-[11px] font-semibold text-ink-200">같은 경기일 수 있는 기록 — 붙이면 이 경기의 시점이 됩니다</p>
      {m.candidates.length === 0 && <p className="text-[11px] text-ink-400">근처(±30분)에 후보가 없습니다.</p>}
      {m.candidates.map((c) => (
        <form key={c.match_id} action={link} className="grid gap-1 rounded border border-ink-800 p-2">
          <input type="hidden" name="match_id" value={m.match_id} />
          <input type="hidden" name="version" value={m.review_version} />
          <input type="hidden" name="target_id" value={c.match_id} />
          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
            <span className={c.verdict === "same" ? "text-win" : c.verdict === "maybe" ? "text-amber-400" : "text-ink-400"}>{VERDICT_LABEL[c.verdict]}</span>
            <span className="text-ink-400">· {c.source === "provider_api" ? "넥슨 기록" : "화면 기록"} · {c.gap_sec >= 0 ? "+" : ""}{Math.round(c.gap_sec / 60)}분</span>
          </div>
          <p className="text-xs text-ink-200">{c.sides.map((s) => `${s.streamer_name ?? s.nickname} ${s.score ?? "?"}`).join(" : ")}</p>
          <div className="flex items-center gap-2"><SubmitButton tone="ghost">같은 경기로 붙이기</SubmitButton></div>
        </form>
      ))}
      <ActionMessage state={state} />
    </div>
  );
}

/** 맥락 — 기존 FC 맥락 검수와 같은 컨트롤·같은 저장 함수. 정본 경기 하나에 저장된다. */
function ContextPanel({ m, eventOptions }: { m: FcoMatchUnit; eventOptions: FcoEventOption[] }) {
  const ctx = m.context;
  const unit: ReviewControlsUnit = {
    kind: "match", status: ctx.status, confirmed: m.review_completed_at != null, event: ctx.event, judgment: ctx.judgment,
    matches: [{ provider_match_id: m.match_id, participants: m.sides.map((x) => ({ name: x.name })) }],
  };
  return (
    <div className="ck-review-panel grid gap-2 p-3">
      <p className="text-[11px] font-semibold text-ink-200">맥락 — 무슨 판이었나</p>
      {ctx.event && <p className="text-xs text-ink-200">현재: <b className="text-accent-400">{ctx.event.name}</b> <span className="text-ink-400">({ctx.event.kind})</span></p>}
      {!ctx.event && ctx.judgment && (
        <p className="text-xs text-ink-200">현재: <b className={ctx.judgment.judgment === "casual" ? "text-ink-300" : "text-amber-400"}>{ctx.judgment.judgment === "casual" ? "단순 친선" : "미해결"}</b>
          <span className="ml-1 text-ink-400">— {ctx.judgment.note}</span></p>
      )}
      {ctx.status === "uninvestigated" && <p className="text-xs text-ink-400">아직 맥락을 정하지 않았습니다.</p>}
      <FcoReviewControls compact unit={unit} eventOptions={eventOptions} activeMatch={unit.matches[0]} />
    </div>
  );
}

/**
 * [대전] 탭 — 한 자리에서 연달아 한 판들을 한 번에 본다. 맥락(친선·CK·대회)은 대전 단위로 정하는 경우가 많아
 * 전체 적용을 둔다(저장은 판마다 같은 함수 — FcoReviewControls 의 targets). 값 확인·완료는 판마다 한다.
 */
function SessionTab({ session, matches, eventOptions, onPick }: {
  session: WorkbenchSession; matches: FcoMatchUnit[]; eventOptions: FcoEventOption[]; onPick: (id: string) => void;
}) {
  const done = matches.filter((m) => m.review_completed_at).length;
  const ctxCount = new Map<string, number>();
  for (const m of matches) {
    const label = m.context.event ? `${m.context.event.name}(${m.context.event.kind})` : m.context.judgment?.judgment === "casual" ? "단순 친선"
      : m.context.judgment?.judgment === "unresolved" ? "미해결" : "미조사";
    ctxCount.set(label, (ctxCount.get(label) ?? 0) + 1);
  }
  const firstTodo = matches.find((m) => !m.review_completed_at);
  const unit: ReviewControlsUnit = {
    kind: "match", status: "uninvestigated", confirmed: false, event: null, judgment: null,
    matches: matches.map((m) => ({ provider_match_id: m.match_id, participants: m.sides.map((x) => ({ name: x.name })) })),
  };
  return (
    <div className="grid gap-3 text-sm">
      <section className="ck-review-panel grid gap-1.5 p-3">
        <p className="text-[13px] font-semibold text-ink-200">{session.title}</p>
        <p className="text-xs text-ink-400">{matches.length}판 · 완료 <b className={done === matches.length ? "text-win" : "text-ink-200"}>{done}/{matches.length}</b>
          {matches.length > 0 && <> · {kst(matches[0].played_at)} ~ {kst(matches[matches.length - 1].played_at)}</>}</p>
        {session.people.length > 0 && <p className="text-[11px] text-ink-400">나온 사람: {session.people.map((p) => p.name).join(", ")}</p>}
        {session.vods.length > 0 && <p className="text-[11px] text-ink-400">본 방송: {session.vods.length}개 — 경기마다 위 시점 칩으로 바꿔 봅니다</p>}
        {session.pairs.length > 1 && <PairTable matches={matches} />}
        {firstTodo && <button type="button" onClick={() => onPick(firstTodo.match_id)} className="justify-self-start rounded border border-ink-700 px-2 py-1 text-xs text-ink-200 hover:border-accent-400">미검수 첫 판 보기 →</button>}
      </section>
      {session.kind !== "meet" ? (
        <section className="ck-review-panel grid gap-1 p-3 text-[11px] text-ink-400">
          <p className="font-semibold text-ink-200">일반 유저전 — 맥락을 가르지 않습니다</p>
          <p>일반 유저와는 CK·대회가 없습니다. 판마다 스코어·결과 화면만 보고 값이 맞으면 「검수 완료」를 누르세요.</p>
        </section>
      ) : (
      <section className="ck-review-panel grid gap-2 p-3">
        <p className="text-[11px] font-semibold text-ink-200">맥락 — 이 {session.pairs.length > 1 ? "모임" : "대전"} 전체({matches.length}판)에 한 번에</p>
        {session.pairs.length > 1 && <p className="text-[11px] text-amber-400">CK·대회로 정하면 이 {matches.length}판이 전부 공개 대회에 붙습니다 — 다른 판이 섞이지 않았는지 위 대진을 보고 누르세요.</p>}
        <p className="text-[11px] text-ink-400">지금: {[...ctxCount].map(([k, n]) => `${k} ${n}`).join(" · ")}</p>
        <FcoReviewControls compact unit={unit} eventOptions={eventOptions} activeMatch={unit.matches[0] ?? null} targets={matches.map((m) => m.match_id)} />
        <p className="text-[11px] text-ink-500">한 판만 다르면 그 판의 [경기] 탭에서 따로 바꾸세요. 값 확인과 검수 완료는 판마다 합니다.</p>
      </section>
      )}
    </div>
  );
}

/** 모임 대진 — 두 사람마다 몇 판·몇 승. 리그(다 같이 돌아가며)인지 토너먼트인지 몇 사람끼리만인지 한눈에. */
function PairTable({ matches }: { matches: FcoMatchUnit[] }) {
  const rows = new Map<string, { a: string; b: string; aw: number; bw: number; d: number; n: number }>();
  for (const m of matches) {
    if (m.sides.length !== 2) continue;
    const [x, y] = [...m.sides].sort((p, q) => p.name.localeCompare(q.name));
    const key = `${x.name}|${y.name}`;
    const r = rows.get(key) ?? { a: x.name, b: y.name, aw: 0, bw: 0, d: 0, n: 0 };
    r.n++;
    if (x.outcome === "win") r.aw++; else if (y.outcome === "win") r.bw++; else if (x.outcome === "draw") r.d++;
    rows.set(key, r);
  }
  const people = new Set([...rows.values()].flatMap((r) => [r.a, r.b]));
  return (
    <div className="mt-1 grid gap-0.5 text-[11px]">
      <p className="text-ink-400">{people.size}명 · 대진 {rows.size}개</p>
      {[...rows.values()].map((r) => (
        <p key={`${r.a}|${r.b}`} className="text-ink-200">
          {r.a} <b className="tabular-nums text-accent-400">{r.aw}</b> : <b className="tabular-nums text-accent-400">{r.bw}</b> {r.b}
          <span className="ml-1 text-ink-500">({r.n}판{r.d ? ` · 무 ${r.d}` : ""})</span>
        </p>
      ))}
    </div>
  );
}
