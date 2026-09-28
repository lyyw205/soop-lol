"use client";

/**
 * CK 판독 검수대 — 사람이 **공개될 값**을 **비교 프레임**과 대조해 고치는 자리.
 *
 *   ┌────────────────────────────┬──────────────┐
 *   │  프리뷰 (비교 프레임)        │  인스펙터     │
 *   │                            │  경기·로스터  │
 *   ├────────────────────────────┴──────────────┤
 *   │  큐 — 이 VOD 의 경기                         │
 *   └───────────────────────────────────────────┘
 *
 * ★ 사람에게 조사 기록(관찰문·후보 판단·탐색 상태)을 읽히거나 쓰게 하지 않는다. 그건 LLM 조사의
 *   몫이고 CLI(`npm run ck:record`)로 본다. 여기는 공개 값 확인·수정·공개 제외만 한다.
 * ★ 선택은 클라이언트 상태다. 프레임을 옮겨 다니는 것은 저장이 아니므로 왕복할 이유가 없다.
 * ★ 저장은 서버 액션이다. 원본 수정·조우 재파생·통계 재계산이 한 트랜잭션으로 돈다.
 */

import { useActionState, useEffect, useMemo, useRef, useState } from "react";

import {
  relinkFrameAction,
  saveMatchMetaAction,
  saveRosterAction,
  setMatchVisibilityAction,
} from "@/app/admin/ck/actions";
import { IDLE } from "@/lib/action-state";
import { CHAMPIONS, championById } from "@soop-lol/core/lib/riot/champions";
import { setLabel } from "@soop-lol/core/lib/metrics/set-label";

import { resolveSelection, timelineSpan, type Picked } from "./ck-selection";
import { projectReviewQueue, UNPLACED, type ProjectedMatch } from "./ck-review-queue";

import { ActionMessage, SubmitButton } from "./Field";
import { useCkForm } from "./use-ck-form";
import { metaFormValues, participantFormValues, type CkActionState } from "@/lib/ck-review-form";
import { matchOriginLabel } from "@/lib/admin-labels";
import { rosterFocus, type RosterFocus } from "@/lib/ck-review-progress";
import { ReviewCompletion } from "./ReviewCompletion";

function CkFeedback({ state, reload, pending }: { state: CkActionState; reload: () => void; pending: boolean }) {
  return <><ActionMessage state={state} />{!state.ok && state.latest && <button type="button" disabled={pending} onClick={reload} className="text-xs text-accent-400">최신 값 불러오기</button>}</>;
}

// ── 화면이 받는 모양 (서버가 core 의 행을 그대로 넘긴다) ─────────────

export interface ReviewFrame {
  id: string;
  match_id: string | null;
  frame_path: string;
  at_sec: number | null;
  kind: "result" | "roster" | "other";
}

export interface ReviewParticipant {
  account_streamer_id?: string | null;
  participant_id: number;
  puuid: string | null;
  streamer_id: string | null;
  observed_name: string | null;
  team_id: number;
  team_position: string | null;
  champion_id: number;
  champion_name: string | null;
  kills: number | null;
  deaths: number | null;
  assists: number | null;
}

export interface ReviewMatch {
  match_id: string;
  game_creation: string;
  /** datetime-local 문자열의 브라우저 시간대 해석에 기대지 않는 타임라인 계산값. */
  game_creation_epoch_ms: number;
  game_duration: number | null;
  winning_team: number | null;
  visibility: "public" | "hidden";
  review_completed_at: string | null;
  review_version: number;
  position_count: number;
  linked_count: number;
  champion_count: number;
  kda_count: number;
  origin: string | null;
  source: string | null;
  event_id: string | null;
  series_id: string | null;
  series_game_no: number | null;
  best_of: number | null;
  best_of_evidence: string | null;
  /** 'date' 면 시각은 모른다 — 날짜만 보여준다(0035). */
  game_creation_precision: "datetime" | "date";
  /** 세트 순서를 출처에서 확인했나. false 면 "N세트" 로 단정하지 않는다. */
  set_order_known: boolean;
  source_url: string | null;
  participants: ReviewParticipant[];
}

export interface ReviewStreamer {
  id: string;
  slug: string;
  display_name: string;
}

/** 경기를 붙일 대회. 분류(내전/대회)가 여기서 나온다. */
export interface ReviewEvent {
  id: string;
  slug: string | null;
  name: string;
  kind: string;
}

interface Props {
  leadId: string;
  vodUrl?: string | null;
  initialMatchId?: string;
  initialFocus?: string;
  initialPending?: boolean;
  frames: ReviewFrame[];
  matches: ReviewMatch[];
  streamers: ReviewStreamer[];
  events: ReviewEvent[];
  /** 확인된 값이 있을 때만 절대 경기 시각을 VOD 상대 초로 바꾼다. */
  vodStartedAt?: string | null;
  /**
   * 다시점 대회 화면에서만 준다 — 이 VOD(시점)가 직접 읽은 값 중 경기 값과 다른 칸, 경기별.
   * 경기 값은 한 벌이라 어느 시점에서 고쳐도 같은 경기가 고쳐진다. docs/CK-MULTI-POV-PLAN.md §6
   */
  povDiffs?: Record<string, { compared: number; rows: PovDiffRowView[] }>;
}

export interface PovDiffRowView {
  participant_id: number | null;
  who: string;
  field: string;
  stored: unknown;
  observed: unknown;
  status: "mismatch_open" | "mismatch_reviewed" | "pending" | "empty";
}

// ── 작은 조각 ────────────────────────────────────────────────────────

function vodAt(url: string, seconds: number | null): string {
  if (seconds == null) return url;
  try {
    const target = new URL(url);
    target.searchParams.set("change_second", String(Math.floor(seconds)));
    return target.toString();
  } catch { return url; }
}

const hms = (sec: number | null) => {
  if (sec == null) return "--:--:--";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};

/** 날짜만 아는 경기는 시각을 내지 않는다(0035) — 시드 생성기가 19시·20시를 지어 넣는다. */
const compactKst = (value: string, precision: string = "datetime") =>
  !value ? "—" : precision === "date" ? value.slice(0, 10) : value.replace("T", " ");

/** 세트 이름은 core 의 setLabel 하나로 낸다 — 화면마다 규칙이 다르면 같은 판이 다르게 불린다. */
const matchSetLabel = (m: { series_id: string | null; best_of: number | null; set_order_known: boolean; series_game_no: number | null }) =>
  setLabel({ standalone: !m.series_id, best_of: m.best_of, set_order_known: m.set_order_known, series_game_no: m.series_game_no });
const durationLabel = (sec: number | null) => sec == null
  ? "—"
  : `${Math.floor(sec / 60)}분${sec % 60 ? ` ${sec % 60}초` : ""}`;

/** 프레임 파일을 서빙하는 라우트. `out/` 밖은 라우트가 거부한다. */
const frameUrl = (path: string) => `/admin/ck/frame/${path.split("/").map(encodeURIComponent).join("/")}`;

const KIND_LABEL: Record<ReviewFrame["kind"], string> = {
  result: "결과창",
  roster: "로스터",
  other: "그 밖",
};

const inputClass =
  "w-full rounded border border-ink-700 bg-ink-950 px-2 py-1 text-xs text-ink-200 " +
  "placeholder:text-ink-400/50 outline-none focus:border-accent-600";

const POSITIONS = ["", "TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"];

// ── 본체 ────────────────────────────────────────────────────────────

type Projected = ProjectedMatch<ReviewMatch, ReviewFrame>;

export function CkReviewer({ leadId, frames, matches, streamers, events, vodStartedAt, vodUrl, initialMatchId, initialFocus, initialPending = false, povDiffs }: Props) {
  const projection = useMemo(
    () => projectReviewQueue(frames, matches, { vodStartedAt }),
    [frames, matches, vodStartedAt],
  );
  // ★ 선택은 프레임·경기를 따로 들고 있다 — 근거 프레임이 안 붙은 경기도 고칠 수 있어야 한다.
  //   규칙 자체는 `ck-selection.ts` 의 순수 함수에 있다(회귀 검사가 거기를 잰다).
  const [picked, setPicked] = useState<Picked>({ matchId: initialMatchId });
  const rosterField = rosterFocus(initialFocus)?.focus;
  const [zoom, setZoom] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<"game" | "roster">(rosterFocus(initialFocus) ? "roster" : "game");

  // ★ 탭(경기/로스터)은 여기서 강제로 바꾸지 않는다 — 로스터를 고치다가 다른 경기로 넘어가면
  //   조건부 렌더라 마운트가 날아가며 아직 저장 안 한 로스터 편집도 같이 사라졌다.
  const sel = resolveSelection(frames, matches, picked);
  const selected = sel.frame;
  const selectedId = selected?.id ?? null;
  const selectedMatch = sel.match;

  const pickMatch = (id: string) => {
    setPicked({ matchId: id });
    requestAnimationFrame(() => {
      document.getElementById(`ck-review-queue-match:${id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  };
  /** 비교 프레임은 고른 경기의 프레임 안에서만 넘긴다. */
  const focusFrames = useMemo(
    () => (selectedMatch ? projection.find((item) => item.match.match_id === selectedMatch.match_id)?.frames : null)
      ?? (selected ? [selected] : []),
    [projection, selected, selectedMatch],
  );
  const pickFocusFrame = (id: string) => setPicked({ matchId: selectedMatch?.match_id ?? null, frameId: id });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable=true]")) return;
      const index = focusFrames.findIndex((frame) => frame.id === selectedId);
      if (index < 0) return;
      const next = event.key === "ArrowRight" ? Math.min(index + 1, focusFrames.length - 1) : Math.max(index - 1, 0);
      if (next === index) return;
      event.preventDefault();
      setPicked({ matchId: selectedMatch?.match_id ?? null, frameId: focusFrames[next].id });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [focusFrames, selectedId, selectedMatch]);

  const span = timelineSpan(frames, projection
    .filter((item) => item.at !== UNPLACED)
    .map((item) => [item.at, item.end] as [number, number]));

  return (
    <div className="ck-review-workbench">
      {/* ── 프리뷰 + 인스펙터 ─────────────────────────────────── */}
      <div className="ck-review-stage">
        <section className="ck-review-preview">
          <header className="flex items-center justify-between gap-3 border-b border-ink-800 px-4 py-2">
            <div className="min-w-0 text-xs text-ink-400">
              {selected ? (
                <>
                  <span className="font-mono text-accent-400">{hms(selected.at_sec)}</span>
                  <span className="mx-2 text-ink-600">·</span>
                  {KIND_LABEL[selected.kind]}
                </>
              ) : selectedMatch ? "이 경기에 연결된 비교 프레임이 없습니다." : "이 VOD 에 검수할 경기가 없습니다."}
            </div>
            <div className="flex items-center gap-2">
            {vodUrl && <a href={vodAt(vodUrl, selected?.at_sec ?? null)} target="_blank" rel="noreferrer" className="text-xs text-accent-400">{selected?.at_sec != null ? "이 시점 VOD ↗" : "VOD 열기 ↗"}</a>}
            {selected && (
              <div className="flex shrink-0 gap-2 text-xs">
                <button
                  onClick={() => setZoom((z) => !z)}
                  className="rounded border border-ink-700 px-2 py-1 text-ink-400 hover:text-ink-200"
                >
                  {zoom ? "맞추기" : "원본 크기"}
                </button>
                <a
                  href={frameUrl(selected.frame_path)}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded border border-ink-700 px-2 py-1 text-ink-400 hover:text-ink-200"
                >
                  새 탭 ↗
                </a>
              </div>
            )}
            </div>
          </header>

          {/* 원본 크기 모드에서는 스크롤로 이름 칸을 들여다본다 —
              긴 이름이 잘렸는지, 닉네임을 잘못 읽었는지는 확대해야 보인다. */}
          <div className={`ck-review-frame bg-ink-950 ${zoom ? "max-h-[70vh] overflow-auto" : ""}`}>
            {selected ? (
              // eslint-disable-next-line @next/next/no-img-element -- out/ 밖의 로컬 파일이라 next/image 로 최적화하지 않는다
              <img
                src={frameUrl(selected.frame_path)}
                alt={`${hms(selected.at_sec)} 프레임`}
                className={`ck-review-frame-image ${zoom ? "max-w-none" : "w-full"}`}
              />
            ) : (
              <p className="px-4 py-16 text-center text-sm text-ink-400">
                {matches.length === 0
                  ? "경기가 아직 없습니다. 경기는 CK 조사(ck-research 스킬 · npm run ck:merge)가 만듭니다."
                  : "비교할 프레임이 없습니다. VOD나 출처를 열어 확인하세요."}
              </p>
            )}
          </div>

          <footer className="grid gap-2 border-t border-ink-800 px-4 py-2 text-xs text-ink-400">
            {selected && <FrameStrip frames={focusFrames} selectedId={selectedId} onPick={pickFocusFrame} />}
            <ReviewMinimap span={span} projection={projection}
              selectedMatchId={selectedMatch?.match_id ?? null} onPickMatch={pickMatch} />

            {selected && (
              <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[11px]">{selected.frame_path}</span>
              <span className="ml-auto flex items-center gap-2">
                이 프레임의 경기
                {/* ★ 잘못 붙은 비교 프레임을 바로잡는 자리. 미배정으로 돌리면 이 화면에서 빠진다. */}
                <form action={relinkFrameAction} className="flex items-center gap-1">
                  <input type="hidden" name="lead_id" value={leadId} />
                  <input type="hidden" name="frame_id" value={selected.id} />
                  <select
                    name="match_id"
                    defaultValue={selected.match_id ?? ""}
                    key={selected.id}
                    className="rounded border border-ink-700 bg-ink-950 px-1.5 py-1 text-xs text-ink-200"
                  >
                    <option value="">— 미배정 —</option>
                    {matches.map((m) => (
                      <option key={m.match_id} value={m.match_id}>
                        {m.match_id}
                      </option>
                    ))}
                  </select>
                  <button className="rounded border border-ink-700 px-2 py-1 hover:text-ink-200">옮기기</button>
                </form>
              </span>
              </div>
            )}
          </footer>
        </section>

        <aside className="ck-review-inspector" aria-label="검수 인스펙터">
          <div className="ck-review-inspector-shell">
            <div className="ck-review-inspector-tabs" role="tablist" aria-label="검수 정보">
              <button type="button" role="tab" aria-selected={inspectorTab === "game"}
                onClick={() => setInspectorTab("game")}>경기</button>
              <button type="button" role="tab" aria-selected={inspectorTab === "roster"}
                onClick={() => setInspectorTab("roster")}>로스터</button>
            </div>

            <div className="ck-review-inspector-body">
              {selectedMatch && povDiffs && (
                <PovDiffBox diff={povDiffs[selectedMatch.match_id]} match={selectedMatch} streamers={streamers} />
              )}
              {!selectedMatch ? (
                <div className="ck-review-panel p-4 text-xs leading-relaxed text-ink-400">
                  아직 경기로 반영된 항목이 없습니다.
                </div>
              ) : inspectorTab === "game" ? (
                <div className="ck-review-tab-stack">
                  <MatchInspector key={`meta:${selectedMatch.match_id}`} leadId={leadId} match={selectedMatch} events={events} />

                </div>
              ) : (
                <div className="ck-review-tab-stack">
                  <RosterInspector key={`roster:${selectedMatch.match_id}`} leadId={leadId} match={selectedMatch} streamers={streamers} focus={rosterField} />
                </div>
              )}
            </div>
          </div>
        </aside>
      </div>

      <ReviewQueue initialPending={initialPending} projection={projection} selectedMatchId={selectedMatch?.match_id ?? null} onPickMatch={pickMatch} />
    </div>
  );
}

// ── 이 시점이 읽은 값과 다른 칸 (다시점 대회 화면) ───────────────────────

const POV_FIELD: Record<string, string> = {
  winning_team: "승리 팀", duration: "경기 길이", series_game_no: "세트",
  team: "팀", position: "포지션", champion_id: "챔피언", kills: "킬", deaths: "데스", assists: "어시스트",
};
const POV_STATUS: Record<PovDiffRowView["status"], { label: string; cls: string }> = {
  mismatch_open: { label: "미해결", cls: "text-amber-300" },
  mismatch_reviewed: { label: "검수 완료", cls: "text-ink-400" },
  pending: { label: "대응 보류", cls: "text-ink-400" },
  empty: { label: "경기 칸 빈", cls: "text-ink-400" },
};

function PovDiffBox({ diff, match, streamers }: {
  diff: { compared: number; rows: PovDiffRowView[] } | undefined;
  match: ReviewMatch;
  streamers: ReviewStreamer[];
}) {
  if (!diff) {
    return <div className="ck-review-panel mb-3 p-3 text-[11px] text-ink-400">이 시점은 이 경기 값을 제출하지 않았습니다(사진·연결만).</div>;
  }
  const nameOf = (row: PovDiffRowView) => {
    if (row.who === "경기") return "경기";
    const p = match.participants.find((x) => x.participant_id === row.participant_id);
    const person = p?.account_streamer_id ?? p?.streamer_id;
    return (person && streamers.find((s) => s.id === person)?.display_name) ?? p?.observed_name ?? row.who.replace(/^n:/, "");
  };
  const show = (field: string, v: unknown) => v == null ? "비어 있음"
    : field === "winning_team" || field === "team" ? (v === 100 ? "1팀" : v === 200 ? "2팀" : String(v))
    : field === "champion_id" ? (championById(Number(v))?.name ?? `#${v}`)
    : field === "duration" ? durationLabel(Number(v)) : String(v);
  const open = diff.rows.filter((r) => r.status === "mismatch_open").length;
  return (
    <div className="ck-review-panel mb-3 p-3 text-[11px]">
      <p className={open ? "text-amber-300" : "text-ink-400"}>
        이 시점이 읽은 {diff.compared}칸 중 {diff.rows.length ? `다른 칸 ${diff.rows.length}` : "모두 경기 값과 일치"}
        {open ? ` · 미해결 ${open}` : ""}
      </p>
      {diff.rows.length > 0 && (
        <table className="mt-2 w-full">
          <thead className="text-left text-ink-400"><tr><th className="pr-2 font-normal">자리</th><th className="pr-2 font-normal">칸</th>
            <th className="pr-2 font-normal">경기 값</th><th className="pr-2 font-normal">이 시점</th><th className="font-normal">상태</th></tr></thead>
          <tbody>{diff.rows.map((r) => (
            <tr key={`${r.who}:${r.field}`} className="border-t border-ink-800">
              <td className="pr-2 text-ink-200">{nameOf(r)}</td><td className="pr-2 text-ink-400">{POV_FIELD[r.field] ?? r.field}</td>
              <td className="pr-2 tabular-nums text-ink-200">{show(r.field, r.stored)}</td>
              <td className="pr-2 tabular-nums text-ink-200">{show(r.field, r.observed)}</td>
              <td className={POV_STATUS[r.status].cls}>{POV_STATUS[r.status].label}</td>
            </tr>))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── 경기 큐 + 위치 미니맵 ─────────────────────────────────────────────

function ReviewQueue({ projection, selectedMatchId, onPickMatch, initialPending }: {
  initialPending: boolean;
  projection: Projected[];
  selectedMatchId: string | null;
  onPickMatch: (id: string) => void;
}) {
  const [pendingOnly, setPendingOnly] = useState(initialPending);
  const visible = pendingOnly ? projection.filter(item => !item.match.review_completed_at) : projection;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable=true]")) return;
      if (!visible.length) return;
      event.preventDefault();
      const current = visible.findIndex((item) => item.match.match_id === selectedMatchId);
      const next = event.key === "ArrowDown"
        ? Math.min(current < 0 ? 0 : current + 1, visible.length - 1)
        : Math.max(current < 0 ? visible.length - 1 : current - 1, 0);
      onPickMatch(visible[next].match.match_id);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onPickMatch, visible, selectedMatchId]);
  return (
    <section className="ck-review-timeline" aria-label="검수 큐">
      <header className="ck-review-queue-head">
        <div><h3>검수 큐</h3></div>
        <div className="flex gap-2 text-xs">{[false, true].map(value => <button key={String(value)} type="button" aria-pressed={pendingOnly === value}
          className={pendingOnly === value ? "text-accent-400" : "text-ink-400"} onClick={() => setPendingOnly(value)}>{value ? "미검수" : "전체"}</button>)}</div>
      </header>

      <ul className="ck-review-queue-list">
        {visible.map(({ match, at, end }) => (
          <li key={match.match_id} id={`ck-review-queue-match:${match.match_id}`}>
            <button type="button" className="ck-review-queue-item" data-kind="match"
              aria-current={selectedMatchId === match.match_id ? "true" : undefined}
              onClick={() => onPickMatch(match.match_id)} title={`${matchSetLabel(match)} · ${match.match_id}`}>
              <time>{at === UNPLACED
                ? "시각 미상"
                : <>{hms(at)}{end !== at ? `–${hms(end)}` : ""}</>}</time>
              <span className="ck-review-queue-kind">
                {matchSetLabel(match)}
                {match.visibility === "hidden" ? " · 공개 제외" : match.review_completed_at ? " · 검수 완료" : " · 미검수"}
              </span>
            </button>
          </li>
        ))}
        {visible.length === 0 && <li className="ck-review-queue-empty">해당하는 경기가 없습니다.</li>}
      </ul>
    </section>
  );
}

function ReviewMinimap({ span, projection, selectedMatchId, onPickMatch }: {
  span: number; projection: Projected[]; selectedMatchId: string | null; onPickMatch: (id: string) => void;
}) {
  return <div className="ck-review-minimap" aria-label="VOD 위치 미니맵">
    {projection.map(({ match, at, end }, index) => {
      if (at === UNPLACED) return <button key={`match:${match.match_id}`} type="button"
        data-kind="match-unplaced" data-selected={selectedMatchId === match.match_id || undefined}
        aria-label={`시각 미상 경기 ${match.match_id}`} title={`시각 미상 경기 · ${match.match_id}`}
        onClick={() => onPickMatch(match.match_id)} style={{ right: `${3 + projection.slice(0, index).filter((item) => item.at === UNPLACED).length * 5}px` }} />;
      return <button key={`match:${match.match_id}`} type="button" data-kind="match"
        data-selected={selectedMatchId === match.match_id || undefined} title={`${hms(at)} 경기 · ${match.match_id}`}
        onClick={() => onPickMatch(match.match_id)} style={{ left: `${(at / span) * 100}%`, width: `${Math.max(.35, ((end - at) / span) * 100)}%` }} />;
    })}
  </div>;
}

function FrameStrip({ frames, selectedId, onPick }: { frames: ReviewFrame[]; selectedId: string | null; onPick: (id: string) => void }) {
  if (frames.length < 2) return null;
  return <div className="ck-review-frame-strip" aria-label={`비교 프레임 ${frames.length}장`}>
    {frames.map((frame) => <button key={frame.id} type="button" aria-current={frame.id === selectedId ? "true" : undefined}
      title={`${hms(frame.at_sec)} · ${KIND_LABEL[frame.kind]}`}
      onClick={() => onPick(frame.id)}>
      {/* eslint-disable-next-line @next/next/no-img-element -- 로컬 검수 프레임 */}
      <img src={frameUrl(frame.frame_path)} alt={`${hms(frame.at_sec)} 프레임`} />
      <span>{hms(frame.at_sec)}</span>
    </button>)}
  </div>;
}

// ── 인스펙터: 경기 메타 ─────────────────────────────────────────────

function MatchInspector({
  leadId,
  match,
  events,
}: {
  leadId: string;
  match: ReviewMatch;
  events: ReviewEvent[];
}) {
  const { base, draft, setDraft, field, state, action, pending, reload } = useCkForm(metaFormValues(match), saveMatchMetaAction);
  const hidden = match.visibility === "hidden";
  const formRef = useRef<HTMLFormElement>(null);
  const [activeField, setActiveField] = useState<MatchMetaField | null>(null);
  const selectedEvent = events.find((event) => event.id === draft.event_id) ?? null;

  const openField = (name: MatchMetaField) => {
    if (pending) return;
    if (activeField && activeField !== name) {
      setDraft((current) => ({ ...current, [activeField]: base[activeField] }));
    }
    setActiveField(name);
  };
  const cancelField = (name: MatchMetaField) => {
    setDraft((current) => ({ ...current, [name]: base[name] }));
    setActiveField(null);
  };
  const commitField = (name: MatchMetaField, value?: string) => {
    const form = formRef.current;
    if (!form || pending) return;
    if (value !== undefined) {
      const control = form.elements.namedItem(name);
      if (control instanceof HTMLInputElement) control.value = value;
      setDraft((current) => ({ ...current, [name]: value }));
    }
    setActiveField(null);
    form.requestSubmit();
  };
  const fieldKeys = (name: MatchMetaField) => (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitField(name);
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancelField(name);
    }
  };
  const seriesFormatKeys = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      setActiveField(null);
      formRef.current?.requestSubmit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      setDraft((current) => ({ ...current, best_of: base.best_of, best_of_evidence: base.best_of_evidence }));
      setActiveField(null);
    }
  };

  return (
    <div className="ck-review-panel p-4">
      <header className="mb-3 grid gap-2">
        <div className="min-w-0">
          <h3 className="break-all font-mono text-xs leading-relaxed text-ink-200">{match.match_id}</h3>
        </div>
        <div className="grid gap-2">
          <p className="mt-0.5 text-[11px] text-ink-400">
            {matchOriginLabel(match)}

          </p>
          <div className="flex flex-wrap items-center gap-2">
          <ReviewCompletion matchId={match.match_id} version={match.review_version} completed={!!match.review_completed_at} disabled={pending || activeField != null} />
          <form action={setMatchVisibilityAction}>
            <input type="hidden" name="lead_id" value={leadId} />
            <input type="hidden" name="match_id" value={match.match_id} />
            <input type="hidden" name="visibility" value={hidden ? "public" : "hidden"} />
            <button
              className={`shrink-0 rounded border px-2 py-1 text-[11px] ${
                hidden
                  ? "border-win/40 text-win hover:bg-win/10"
                  : "border-lose/40 text-lose hover:bg-lose/10"
              }`}
              title={hidden ? "공개로 되돌린다" : "무효판·중복판·시청 구간이면 공개에서 뺀다"}
            >
              {hidden ? "되살리기" : "공개에서 빼기"}
            </button>
          </form>
          </div>
        </div>
      </header>

      {hidden && (
        <p className="mb-3 rounded border border-lose/30 bg-lose/5 px-2 py-1.5 text-[11px] text-ink-400">
          <b className="text-lose">공개에서 빠진 경기입니다.</b> 지워지지 않았고 조우·챔피언 통계에서도
          빠져 있습니다. 되살리면 그대로 돌아옵니다.
        </p>
      )}

      <form ref={formRef} action={action} className="grid gap-2">
        <input type="hidden" name="base" value={JSON.stringify(base)} />
        <input type="hidden" name="lead_id" value={leadId} />
        <input type="hidden" name="match_id" value={match.match_id} />
        {activeField !== "winning_team" && <input type="hidden" name="winning_team" value={draft.winning_team} />}
        {activeField !== "event_id" && <input type="hidden" name="event_id" value={draft.event_id} />}
        {activeField !== "series_id" && <input type="hidden" name="series_id" value={draft.series_id} />}
        {activeField !== "series_game_no" && <input type="hidden" name="series_game_no" value={draft.series_game_no} />}
        {activeField !== "best_of" && <input type="hidden" name="best_of" value={draft.best_of} />}
        {activeField !== "best_of" && <input type="hidden" name="best_of_evidence" value={draft.best_of_evidence} />}
        {activeField !== "game_creation" && <input type="hidden" name="game_creation" value={draft.game_creation} />}
        {activeField !== "game_duration" && <input type="hidden" name="game_duration" value={draft.game_duration} />}
        <input type="hidden" name="game_creation_precision" value={draft.game_creation_precision} />
        <input type="hidden" name="set_order_known" value={draft.set_order_known} />

        <fieldset disabled={pending} className="contents">
          <dl className="ck-review-match-summary">
            <div>
              <dt>승자</dt>
              <dd className="ck-review-winner-toggle">
                {[["100", "1팀"], ["200", "2팀"]].map(([value, label]) => <button key={value} type="button"
                  aria-pressed={draft.winning_team === value} onClick={() => commitField("winning_team", value)}>{label}</button>)}
              </dd>
            </div>
            <div className="has-left-border">
              <dt>세트</dt>
              <dd>{activeField === "series_game_no"
                ? <input autoFocus name="series_game_no" inputMode="numeric" aria-label="세트 번호" {...field("series_game_no")}
                    onKeyDown={fieldKeys("series_game_no")} className={inputClass} />
                : <button type="button" className="ck-review-match-cell-button" onClick={() => openField("series_game_no")}>
                    {(() => {
                      const label = matchSetLabel({
                        series_id: draft.series_id || null, best_of: draft.best_of ? Number(draft.best_of) : null,
                        set_order_known: draft.set_order_known === "true", series_game_no: draft.series_game_no ? Number(draft.series_game_no) : null,
                      });
                      // 순서를 모르면 저장된 번호는 정렬용일 뿐이다 — 그렇다고 말한다.
                      return label === "세트" && draft.series_game_no ? `세트 · 저장 번호 ${draft.series_game_no} (순서 미확정)` : label;
                    })()}
                  </button>}</dd>
            </div>
            <div className="is-wide">
              <dt>대회</dt>
              <dd>{activeField === "event_id"
                ? <EventLinkPicker value={draft.event_id} events={events}
                    onCommit={(value) => commitField("event_id", value)} onCancel={() => cancelField("event_id")} />
                : <button type="button" className="ck-review-match-cell-button" onClick={() => openField("event_id")}>
                    {selectedEvent?.name ?? "연결 없음"}
                  </button>}</dd>
            </div>
            <div>
              <dt>경기 시각 · KST</dt>
              <dd>{activeField === "game_creation"
                ? <input autoFocus name="game_creation" type="datetime-local" step={1} aria-label="경기 시각 KST"
                    {...field("game_creation")} onKeyDown={fieldKeys("game_creation")} className={inputClass} />
                : <button type="button" className="ck-review-match-cell-button" onClick={() => openField("game_creation")}>
                    {compactKst(draft.game_creation, draft.game_creation_precision)}
                  </button>}</dd>
            </div>
            <div>
              <dt>시각 정확도</dt>
              {/* 기본값이 없는 값이다. 시각을 VOD 로 보정했으면 여기서 "시각까지" 로 바꿔야 공개 화면이 시각을 낸다. */}
              <dd className="ck-review-winner-toggle">
                {[["datetime", "시각까지"], ["date", "날짜만"]].map(([value, label]) => <button key={value} type="button"
                  aria-pressed={draft.game_creation_precision === value}
                  onClick={() => commitField("game_creation_precision", value)}>{label}</button>)}
              </dd>
            </div>
            <div>
              <dt>세트 순서</dt>
              <dd className="ck-review-winner-toggle">
                {[["true", "확인"], ["false", "모름"]].map(([value, label]) => <button key={value} type="button"
                  aria-pressed={draft.set_order_known === value} disabled={!draft.series_id}
                  title={draft.series_id ? "세트 순서를 출처에서 확인했나 — 모르면 N세트 대신 「세트」로 표시한다" : "시리즈가 있는 경기만"}
                  onClick={() => commitField("set_order_known", value)}>{label}</button>)}
              </dd>
            </div>
            <div className="has-left-border">
              <dt>길이</dt>
              <dd>{activeField === "game_duration"
                ? <input autoFocus name="game_duration" inputMode="numeric" aria-label="경기 길이 초" {...field("game_duration")}
                    onKeyDown={fieldKeys("game_duration")} className={inputClass} />
                : <button type="button" className="ck-review-match-cell-button" onClick={() => openField("game_duration")}>
                    {durationLabel(draft.game_duration ? Number(draft.game_duration) : null)}
                  </button>}</dd>
            </div>
            <div className="is-wide">
              <dt>시리즈 키</dt>
              <dd>{activeField === "series_id"
                ? <input autoFocus name="series_id" aria-label="시리즈 키" {...field("series_id")}
                    onKeyDown={fieldKeys("series_id")} className={`${inputClass} font-mono`} />
                : <button type="button" className="ck-review-match-cell-button font-mono" onClick={() => openField("series_id")}>
                    {draft.series_id || "연결 없음"}
                  </button>}</dd>
            </div>
            <div className="is-wide">
              <dt>다전제 · 근거</dt>
              <dd>{activeField === "best_of"
                ? <span className="grid gap-1">
                    <input autoFocus name="best_of" inputMode="numeric" aria-label="최대 세트 수" placeholder="예: 3 (비우려면 -)"
                      {...field("best_of")} onKeyDown={seriesFormatKeys} className={inputClass} />
                    <input name="best_of_evidence" aria-label="다전제 근거" placeholder="규정 URL 또는 VOD 시각"
                      {...field("best_of_evidence")} onKeyDown={seriesFormatKeys} className={inputClass} />
                  </span>
                : <button type="button" className="ck-review-match-cell-button" onClick={() => openField("best_of")}
                    disabled={!draft.series_id}>{draft.best_of ? `Bo${draft.best_of} · ${draft.best_of_evidence || "근거 없음"}` : "미확정"}</button>}</dd>
            </div>
          </dl>
        </fieldset>
        <div className="min-h-4"><CkFeedback state={state} reload={reload} pending={pending} /></div>
      </form>
    </div>
  );
}

type MatchMetaField = "winning_team" | "event_id" | "series_id" | "series_game_no" | "best_of" | "game_creation" | "game_duration"
  | "game_creation_precision" | "set_order_known";

function EventLinkPicker({ value, events, onCommit, onCancel }: {
  value: string;
  events: ReviewEvent[];
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const selected = events.find((event) => event.id === value) ?? null;
  const matches = query.trim().length >= 1
    ? events.filter((event) => event.name.toLowerCase().includes(query.trim().toLowerCase()) || (event.slug ?? "").toLowerCase().includes(query.trim().toLowerCase())).slice(0, 8)
    : [];
  useEffect(() => { setActiveIndex(0); }, [query]);
  const keys = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" && matches.length) {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, matches.length - 1));
    } else if (event.key === "ArrowUp" && matches.length) {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (matches[activeIndex]) onCommit(matches[activeIndex].id);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
  };

  return <div className="ck-event-link-editor">
    <input type="hidden" name="event_id" value={value} />
    <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={keys}
      placeholder="대회명 검색" aria-label="대회명 검색" className={inputClass} />
    {matches.length > 0 && <div className="ck-event-suggestions" role="listbox" aria-label="일치하는 대회">
        {matches.map((event, index) => <button key={event.id} type="button" role="option" aria-selected={activeIndex === index}
          data-selected={activeIndex === index || undefined} onMouseEnter={() => setActiveIndex(index)} onMouseDown={(mouseEvent) => mouseEvent.preventDefault()}
          onClick={() => onCommit(event.id)}>
          <span className="text-[11px] text-ink-200">{event.name}</span><small className="text-[10px] text-ink-500">{event.kind}</small>
        </button>)}
    </div>}
    {query.trim().length >= 1 && matches.length === 0 && <p className="text-[10px] text-ink-500">일치하는 대회가 없습니다.</p>}
    <div className="flex items-center gap-3 text-[10px]">
      {selected && <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => onCommit("")} className="text-lose hover:text-lose/80">연결 해제</button>}
      <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={onCancel} className="ml-auto text-ink-500 hover:text-ink-200">취소</button>
    </div>
  </div>;
}

// ── 인스펙터: 로스터 ────────────────────────────────────────────────

function RosterInspector({
  leadId,
  match,
  streamers,
  focus,
}: {
  leadId: string;
  match: ReviewMatch;
  streamers: ReviewStreamer[];
  focus?: RosterFocus;
}) {
  const bySlug = useMemo(() => new Map(streamers.map((s) => [s.id, s.slug])), [streamers]);
  const signature = JSON.stringify(match.participants);
  const makeRows = () => rosterRows(match, bySlug);
  const [rows, setRows] = useState<RosterDraftRow[]>(makeRows);
  const [activeCell, setActiveCell] = useState<string | null>(null);
  const [state, action, pending] = useActionState(saveRosterAction, IDLE);

  // 서버 액션 뒤 갱신된 로스터가 들어오면 그 값을 새 편집 기준으로 삼는다.
  useEffect(() => {
    setRows(makeRows());
    setActiveCell(null);
    // signature는 참가자 값이 실제로 바뀌었을 때만 달라진다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  useEffect(() => {
    const field = rosterFocus(focus);
    if (!field) return;
    const missing = makeRows().find(row => !row.remove && (
      focus === "position" ? !POSITIONS.slice(1).includes(row.team_position)
        : focus === "identity" ? !row.streamer_slug && !row.account_streamer_id
        : focus === "champion" ? !(match.participants.find(p => p.participant_id === row.participant_id)?.champion_id)
        : [row.kills, row.deaths, row.assists].some(value => value.trim() === "")
    ));
    setActiveCell(missing ? `${missing.participant_id}:${field.cell}` : null);
    // 입력 중에 다른 칸으로 이동하지 않는다. 항목 선택이나 저장된 값의 갱신 때만 고른다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, signature]);

  const update = (participantId: number, changes: Partial<RosterDraftRow>) => {
    setRows((current) => current.map((row) => row.participant_id === participantId ? { ...row, ...changes } : row));
  };

  return (
    <div className="ck-review-panel p-4">
      <header className="mb-3">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-xs text-ink-200">로스터</h3>
          <span className="text-[10px] text-ink-500">{match.participants.length}/10 판독</span>
        </div>
        <p className="mt-1 text-[11px] leading-relaxed text-ink-400">행을 눌러 수정하세요. 비어 있는 행은 누락 선수 추가용이며, 이름을 적은 행만 저장됩니다.</p>
      </header>

      <form action={action} className="grid gap-3">
        <input type="hidden" name="lead_id" value={leadId} />
        <input type="hidden" name="match_id" value={match.match_id} />
        <input type="hidden" name="roster" value={JSON.stringify(rows)} />
        {[100, 200].map((team) => (
          <RosterTeam key={team} team={team} rows={rows.filter((row) => row.team_id === String(team))}
            winner={match.winning_team === team} activeCell={activeCell} onOpen={setActiveCell} onChange={update} streamers={streamers} />
        ))}
        <div className="sticky bottom-0 -mx-1 flex items-center gap-3 border-t border-ink-800 bg-ink-900/95 px-1 pt-3">
          <SubmitButton>변경사항 저장</SubmitButton>
          <ActionMessage state={state} />
        </div>
      </form>

      <datalist id="ck-streamers">{streamers.map((s) => <option key={s.id} value={s.slug}>{s.display_name}</option>)}</datalist>
    </div>
  );
}

type RosterDraftRow = {
  participant_id: number;
  base: ReturnType<typeof participantFormValues> | null;
  streamer_slug: string;
  team_id: string;
  team_position: string;
  observed_name: string;
  champion_name: string;
  kills: string;
  deaths: string;
  assists: string;
  clear_puuid: boolean;
  account_streamer_id?: string | null;
  remove: boolean;
};

function rosterRows(match: ReviewMatch, bySlug: Map<string, string>): RosterDraftRow[] {
  const taken = new Set(match.participants.map((participant) => participant.participant_id));
  const spareIds = Array.from({ length: 10 }, (_, index) => index + 1).filter((id) => !taken.has(id));
  let spare = 0;
  return [100, 200].flatMap((team) => {
    const existing = match.participants.filter((participant) => participant.team_id === team)
      .sort((a, b) => a.participant_id - b.participant_id)
      .map((participant) => {
        const base = participantFormValues(participant, participant.streamer_id ? bySlug.get(participant.streamer_id) ?? "" : "");
        // ★ DB엔 영문 정본(champion_name = resolveChampion 이 저장한 en 값)이 들어 있다.
        //   그대로 보여주면 편집창이 매번 영어로 뜬다 — 화면에서 읽는 값은 한글이니
        //   champion_id 로 한글 이름을 되찾아 보여준다. 못 찾으면(0/미확인) 저장된 값 그대로.
        const championDisplayName = championById(participant.champion_id)?.name ?? base.champion_name;
        return { participant_id: participant.participant_id, base, account_streamer_id: participant.account_streamer_id,
          streamer_slug: base.streamer_slug, team_id: base.team_id,
          team_position: base.team_position, observed_name: base.observed_name, champion_name: championDisplayName,
          kills: base.kills, deaths: base.deaths, assists: base.assists, clear_puuid: false, remove: false };
      });
    const empty = Array.from({ length: Math.max(0, 5 - existing.length) }, () => ({
      participant_id: spareIds[spare++] ?? 100 + spare, base: null, streamer_slug: "", team_id: String(team),
      team_position: "", observed_name: "", champion_name: "", kills: "", deaths: "", assists: "", clear_puuid: false, remove: false,
    }));
    return [...existing, ...empty];
  });
}

function RosterTeam({ team, rows, winner, activeCell, onOpen, onChange, streamers }: {
  team: number; rows: RosterDraftRow[]; winner: boolean; activeCell: string | null;
  onOpen: (id: string | null) => void; onChange: (id: number, changes: Partial<RosterDraftRow>) => void; streamers: ReviewStreamer[];
}) {
  return <section className="ck-roster-team">
    <header><b>{team === 100 ? "1팀" : "2팀"}</b>{winner && <span>승리</span>}</header>
    <div className="ck-roster-table" role="table" aria-label={`${team === 100 ? "1팀" : "2팀"} 로스터`}>
      <div className="ck-roster-head" role="row"><span>포지션</span><span>이름</span><span>챔피언</span><span>KDA</span></div>
      {rows.map((row) => <RosterRow key={row.participant_id} row={row} activeCell={activeCell}
        onOpen={onOpen} onChange={onChange} streamers={streamers} />)}
    </div>
  </section>;
}

type RosterCell = "team_position" | "identity" | "champion_name" | "kda";
const POSITION_KEYS: { key: string; label: string; value: string }[] = [
  { key: "q", label: "탑", value: "TOP" },
  { key: "w", label: "정글", value: "JUNGLE" },
  { key: "e", label: "미드", value: "MIDDLE" },
  { key: "r", label: "원딜", value: "BOTTOM" },
  { key: "t", label: "서폿", value: "UTILITY" },
];

function RosterRow({ row, activeCell, onOpen, onChange, streamers }: {
  row: RosterDraftRow; activeCell: string | null; onOpen: (id: string | null) => void;
  onChange: (id: number, changes: Partial<RosterDraftRow>) => void; streamers: ReviewStreamer[];
}) {
  const known = streamers.find((streamer) => streamer.slug === row.streamer_slug.trim());
  const accountLinked = !row.clear_puuid && !!row.account_streamer_id;
  const accountOwner = accountLinked ? streamers.find(streamer => streamer.id === row.account_streamer_id) : undefined;
  const empty = !row.base && !row.observed_name && !row.streamer_slug;
  const unlinked = !empty && !row.remove && !known && !accountLinked;
  const [championIndex, setChampionIndex] = useState(0);
  const set = (key: keyof RosterDraftRow, value: string | boolean) => onChange(row.participant_id, { [key]: value } as Partial<RosterDraftRow>);
  const selected = (cell: RosterCell) => activeCell === `${row.participant_id}:${cell}`;
  const toggle = (cell: RosterCell) => onOpen(selected(cell) ? null : `${row.participant_id}:${cell}`);
  const championQuery = row.champion_name.replace(/\s+/g, "").toLowerCase();
  const championMatches = championQuery
    ? CHAMPIONS.filter((champion) => champion.name.replace(/\s+/g, "").toLowerCase().includes(championQuery) || champion.en.toLowerCase().includes(championQuery)).slice(0, 6)
    : [];
  const chooseChampion = (name: string) => {
    set("champion_name", name);
    onOpen(null);
  };
  useEffect(() => { setChampionIndex(0); }, [activeCell]);
  const championKeys = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" && championMatches.length) {
      event.preventDefault();
      setChampionIndex((index) => Math.min(index + 1, championMatches.length - 1));
    } else if (event.key === "ArrowUp" && championMatches.length) {
      event.preventDefault();
      setChampionIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter" && championMatches[championIndex]) {
      event.preventDefault();
      chooseChampion(championMatches[championIndex].name);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onOpen(null);
    }
  };
  const choosePosition = (value: string) => {
    set("team_position", value);
    onOpen(null);
  };
  const closeKdaOnEnter = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    onOpen(null);
  };
  useEffect(() => {
    if (!selected("team_position")) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable=true]")) return;
      const position = POSITION_KEYS.find((item) => item.key === event.key.toLowerCase());
      if (!position) return;
      event.preventDefault();
      choosePosition(position.value);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });
  return <div data-participant-id={row.participant_id} className={`ck-roster-row ${activeCell?.startsWith(`${row.participant_id}:`) ? "is-open" : ""} ${row.remove ? "is-removed" : ""}`}>
    <div className="ck-roster-summary">
      <button type="button" aria-label={`참가자 ${row.participant_id} 포지션`} onClick={() => toggle("team_position")} aria-expanded={selected("team_position")}>{row.team_position || "—"}</button>
      <button type="button" aria-label={`참가자 ${row.participant_id} 이름${unlinked ? " · 스트리머 미연결" : ""}`} onClick={() => toggle("identity")} aria-expanded={selected("identity")}
        data-unlinked={unlinked || undefined}
        title={unlinked ? "스트리머 미연결: 이름을 눌러 연결하세요. 개인 전적·상대전적 집계에 포함되지 않습니다." : undefined}
        className={empty ? "text-ink-600" : "text-ink-200"}>{row.remove ? "삭제 예정" : accountOwner?.display_name || known?.display_name || row.observed_name || row.streamer_slug || (row.base ? "미확인" : "+ 누락 선수")}</button>
      <button type="button" aria-label={`참가자 ${row.participant_id} 챔피언`} onClick={() => toggle("champion_name")} aria-expanded={selected("champion_name")}>{row.champion_name || "—"}</button>
      <button type="button" aria-label={`참가자 ${row.participant_id} KDA`} onClick={() => toggle("kda")} aria-expanded={selected("kda")}>{[row.kills, row.deaths, row.assists].some(Boolean) ? `${row.kills || "–"}/${row.deaths || "–"}/${row.assists || "–"}` : "—"}</button>
    </div>
    {selected("team_position") && <div className="ck-roster-cell-editor">
      <div className="ck-roster-position-choices">
        {POSITION_KEYS.map((position) => <button key={position.value} type="button" onClick={() => choosePosition(position.value)}>
          <kbd>{position.key.toUpperCase()}</kbd>{position.label}
        </button>)}
      </div>
    </div>}
    {selected("identity") && <div className="ck-roster-cell-editor grid gap-2">
      {unlinked && <p className="text-[10px] text-amber-300">스트리머 미연결 · 등록 스트리머를 선택하고 저장하세요.</p>}
      <input list="ck-streamers" value={row.streamer_slug} onChange={(event) => set("streamer_slug", event.target.value)} placeholder="등록 스트리머(slug)" className={inputClass} />
      <input value={row.observed_name} onChange={(event) => set("observed_name", event.target.value)} placeholder="화면에서 읽은 인게임명" className={inputClass} />
      {row.base?.puuid && <label className="flex items-center gap-1.5 text-[10px] text-ink-500"><input type="checkbox" checked={row.clear_puuid} onChange={(event) => set("clear_puuid", event.target.checked)} className="accent-lose" />계정 연결 비우기</label>}
      {row.base && <button type="button" onClick={() => set("remove", !row.remove)} className="text-left text-[10px] text-ink-500 hover:text-lose">{row.remove ? "삭제 취소" : "이 자리 삭제"}</button>}
    </div>}
    {selected("champion_name") && <div className="ck-roster-cell-editor">
      <input autoFocus value={row.champion_name} onChange={(event) => { set("champion_name", event.target.value); setChampionIndex(0); }} onKeyDown={championKeys} placeholder="챔피언 이름 입력" className={inputClass} />
      {championMatches.length > 0 && <div className="ck-champion-suggestions" role="listbox" aria-label="일치하는 챔피언">
        {championMatches.map((champion, index) => <button key={champion.id} type="button" role="option" aria-selected={championIndex === index} data-selected={championIndex === index || undefined} onMouseEnter={() => setChampionIndex(index)} onClick={() => chooseChampion(champion.name)}>
          <img src={`/images/champions/${champion.en}.png`} alt="" />
          <span>{champion.name}</span><small>{champion.en}</small>
        </button>)}
      </div>}
    </div>}
    {selected("kda") && <div className="ck-roster-cell-editor grid grid-cols-3 gap-2"><input autoFocus value={row.kills} onChange={(event) => set("kills", event.target.value)} onKeyDown={closeKdaOnEnter} placeholder="K" inputMode="numeric" className={inputClass} /><input value={row.deaths} onChange={(event) => set("deaths", event.target.value)} onKeyDown={closeKdaOnEnter} placeholder="D" inputMode="numeric" className={inputClass} /><input value={row.assists} onChange={(event) => set("assists", event.target.value)} onKeyDown={closeKdaOnEnter} placeholder="A" inputMode="numeric" className={inputClass} /></div>}
  </div>;
}
