"use client";

/**
 * VOD 찾기 화면 — VOD 하나를 시간 순으로 훑으며 **사진을 경기에 잇고, 없는 경기를 만든다.**
 *
 *   ┌──────────────┬────────────────────────────┬──────────────┐
 *   │ 큐(이 VOD)    │  프리뷰 (사진)               │  선택 요약    │
 *   │ 경기·미연결·메모│  사진 줄 · 미니맵 · 사진의 경기 │  → 경기 화면  │
 *   └──────────────┴────────────────────────────┴──────────────┘
 *
 * ★ 경기 값은 여기서 고치지 않는다(2026-10-12). 편집은 경기 화면(/admin/ck/match/[id]) 한 곳 — 그 화면이 모든 방송의
 *   근거를 보여 주고 목록과 같은 작업 목록을 쓴다. 여기서 고치면 이 VOD 의 근거만 보고 고치게 되고, 완료 후 이동도
 *   VOD 순서라 목록과 어긋났다.
 * ★ 사람에게 조사 기록(관찰문·후보 판단·탐색 상태)을 읽히거나 쓰게 하지 않는다. 그건 CLI(`npm run ck:record`)로 본다.
 * ★ 선택은 클라이언트 상태다. 프레임을 옮겨 다니는 것은 저장이 아니므로 왕복할 이유가 없다.
 */

import { useRouter, useSearchParams } from "next/navigation";
import { adminHref } from "@/lib/admin-navigation";
import { useActionState, useEffect, useMemo, useState } from "react";

import { relinkFrameAction, createMatchFromFrameAction } from "@/app/admin/ck/actions";
import { IDLE, type ActionState } from "@/lib/action-state";

import { framesForSelection, resolveSelection, timelineSpan, type Picked } from "./ck-selection";
import { projectReviewQueue, chronologicalReviewQueue, activeQueueIndex, UNPLACED, type ProjectedMatch } from "./ck-review-queue";
import {
  compactKst, frameThumbUrl, frameUrl, hms, inputClass, KIND_LABEL, matchSetLabel, vodAt,
  type ReviewEvent, type ReviewFrame, type ReviewMatch,
} from "./ck-review-shared";

import { ActionMessage, SubmitButton } from "./Field";
import { MemoReferenceControls, useMemoReferences, type MemoReferenceState } from "./MemoReferences";

export type { ReviewEvent, ReviewFrame, ReviewMatch, ReviewParticipant, ReviewStreamer, PovDiffRowView } from "./ck-review-shared";

interface Props {
  leadId: string;
  vodUrl?: string | null;
  initialMatchId?: string;
  /** 고른 경기를 주소(`match`)에 적는다 — 새로고침·뒤로 가기에도 같은 경기를 연다. */
  syncUrl?: boolean;
  frames: ReviewFrame[];
  matches: ReviewMatch[];
  events: ReviewEvent[];
  /** 확인된 값이 있을 때만 절대 경기 시각을 VOD 상대 초로 바꾼다. */
  vodStartedAt?: string | null;
}

// ── 본체 ────────────────────────────────────────────────────────────

type Projected = ProjectedMatch<ReviewMatch, ReviewFrame>;

export function CkReviewer({ leadId, frames, matches, events, vodStartedAt, vodUrl, initialMatchId, syncUrl = false }: Props) {
  const router = useRouter(), params = useSearchParams();
  const memo = useMemoReferences(vodUrl);
  const projection = useMemo(
    () => projectReviewQueue(frames, matches, { vodStartedAt }),
    [frames, matches, vodStartedAt],
  );
  // ★ 선택은 프레임·경기 두 칸이다 — 근거 프레임이 안 붙은 경기도 고를 수 있어야 한다.
  //   규칙 자체는 `ck-selection.ts` 의 순수 함수에 있다(회귀 검사가 거기를 잰다).
  //   큐에서 경기를 고르면 둘 다 그 경기로 가고, 미연결 사진·메모장을 넘기면 사진만 바뀐다.
  const [picked, setPicked] = useState<Picked>({ matchId: initialMatchId });
  const [zoom, setZoom] = useState(false);
  const [matchesOnly, setMatchesOnly] = useState(false);
  const sel = resolveSelection(matchesOnly ? frames.filter(frame => frame.match_id != null) : frames, matches, picked);
  const selected = sel.frame ?? (!matchesOnly && sel.match
    ? projection.find(item => item.match.match_id === sel.match!.match_id)?.frames[0] ?? null : null);
  const selectedId = selected?.id ?? null;
  const selectedMatch = sel.match;
  const previewAt = memo.active ? memo.at : selected?.at_sec ?? null;
  const previewImage = memo.active ? memo.image : selected ? frameUrl(selected.frame_path) : null;

  const syncedMatchId = selectedMatch?.match_id ?? null;
  useEffect(() => {
    if (!syncUrl) return;
    const url = new URL(window.location.href);
    if (syncedMatchId) url.searchParams.set("match", syncedMatchId); else url.searchParams.delete("match");
    if (url.href !== window.location.href) window.history.replaceState(null, "", url);
  }, [syncUrl, syncedMatchId]);
  /** 경기 값은 경기 화면에서 고친다. 돌아갈 목록(`from`)을 그대로 넘겨 작업 목록이 이어지게 한다. */
  const matchHref = (id: string, tab?: "roster") =>
    adminHref(`/admin/ck/match/${encodeURIComponent(id)}`, { from: params.get("from"), tab });

  const pickMatch = (id: string) => {
    memo.clear();
    setPicked({ matchId: id });
    requestAnimationFrame(() => {
      document.getElementById(`ck-review-queue-match:${id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  };
  /** 썸네일·좌우 키는 선택한 큐 항목 안에서만 움직인다. 큐 자체는 모든 항목을 유지한다. */
  const focusFrames = useMemo(
    () => framesForSelection(frames, { frame: selected, match: selectedMatch }, projection)
      .filter(frame => !matchesOnly || frame.match_id != null),
    [frames, selected, selectedMatch, projection, matchesOnly],
  );
  const pickFocusFrame = (id: string) => { memo.clear(); setPicked({ matchId: selectedMatch?.match_id, frameId: id }); };
  const pickQueueFrame = (id: string) => { memo.clear(); setPicked({ matchId: selectedMatch?.match_id, frameId: id }); };
  const changeQueueFilter = (value: boolean) => {
    memo.clear();
    setMatchesOnly(value);
    if (value && !selectedMatch) setPicked({ matchId: projection[0]?.match.match_id });
  };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable=true]") || target?.closest("dialog")) return;
      if (memo.active) { event.preventDefault(); memo.step(event.key === "ArrowRight" ? 1 : -1); return; }
      const index = focusFrames.findIndex((frame) => frame.id === selectedId);
      if (index < 0) return;
      const next = event.key === "ArrowRight" ? Math.min(index + 1, focusFrames.length - 1) : Math.max(index - 1, 0);
      event.preventDefault();
      if (next === index) return;
      setPicked({ matchId: selectedMatch?.match_id, frameId: focusFrames[next].id });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [focusFrames, selectedId, selectedMatch, memo.active, memo.step]);

  const span = timelineSpan(frames, projection
    .filter((item) => item.at !== UNPLACED)
    .map((item) => [item.at, item.end] as [number, number]));

  return (
    <div className="ck-review-workbench" data-memo-active={memo.active || undefined}>
      {/* ── 프리뷰 + 인스펙터 ─────────────────────────────────── */}
      <div className="ck-review-stage">
        <section className="ck-review-preview">
          <header className="flex items-center justify-between gap-3 border-b border-ink-800 px-4 py-2">
            <div className="min-w-0 text-xs text-ink-400">
              {memo.active ? <>
                <span className="font-mono text-accent-400">{hms(memo.at)}</span> · 메모장 참고
              </> : selected ? (
                <>
                  <span className="font-mono text-accent-400">{hms(selected.at_sec)}</span>
                  <span className="mx-2 text-ink-600">·</span>
                  {KIND_LABEL[selected.kind]}
                </>
              ) : selectedMatch ? "이 경기에 연결된 비교 프레임이 없습니다." : "이 VOD 에 검수할 경기가 없습니다."}
            </div>
            <div className="flex items-center gap-2">
            {vodUrl && <a href={vodAt(vodUrl, previewAt)} target="_blank" rel="noreferrer" className="text-xs text-accent-400">{previewAt != null ? "이 시점 VOD ↗" : "VOD 열기 ↗"}</a>}
            {previewImage && (
              <div className="flex shrink-0 gap-2 text-xs">
                <button
                  onClick={() => setZoom((z) => !z)}
                  className="rounded border border-ink-700 px-2 py-1 text-ink-400 hover:text-ink-200"
                >
                  {zoom ? "맞추기" : "원본 크기"}
                </button>
                <a
                  href={previewImage}
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
          <div data-zoom={zoom} className={`ck-review-frame bg-ink-950 ${zoom ? "max-h-[70vh] overflow-auto" : ""}`}>
            {memo.active && memo.failed ? <p className="p-4 text-xs">썸네일을 불러올 수 없습니다. 위 VOD 링크에서 확인하세요.</p> : previewImage ? (
              // eslint-disable-next-line @next/next/no-img-element -- out/ 밖의 로컬 파일이라 next/image 로 최적화하지 않는다
              <img
                key={previewImage}
                src={previewImage}
                alt={`${hms(previewAt)} ${memo.active ? "메모장 후보" : "프레임"}`}
                onLoad={() => { if (memo.active) memo.setLoadedImage(previewImage); }}
                onError={() => { if (memo.active) memo.setFailed(true); }}
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
            {memo.active && <MemoReferenceControls memo={memo} />}
            {!memo.active && selected && <FrameStrip frames={focusFrames} selectedId={selectedId} onPick={pickFocusFrame} />}
            <ReviewMinimap span={span} projection={projection}
              selectedMatchId={memo.active ? null : selectedMatch?.match_id ?? null} onPickMatch={pickMatch} />

            {!memo.active && selected && (
              <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[11px]">{selected.frame_path}</span>
              <span className="ml-auto flex items-center gap-2">
                이 프레임의 경기
                {/* 미연결 프레임을 연결하거나, 잘못 연결한 프레임을 미배정으로 되돌린다. */}
                <form action={relinkFrameAction} className="flex items-center gap-1">
                  <input type="hidden" name="lead_id" value={leadId} />
                  <input type="hidden" name="frame_id" value={selected.id} />
                  <select
                    name="match_id"
                    defaultValue={selected.match_id ?? ""}
                    key={`${selected.id}:${selected.match_id ?? ""}`}
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

        <aside className="ck-review-inspector" aria-label="선택한 항목">
          <div className="ck-review-inspector-shell">
            <div className="ck-review-inspector-body grid content-start gap-3">
              {selectedMatch ? <div className="ck-review-panel p-4 text-xs leading-relaxed">
                <p className="text-ink-400">선택한 경기</p>
                <h3 className="mt-1 break-all font-mono text-ink-200">{selectedMatch.match_id}</h3>
                <p className="mt-1 text-ink-200">{matchSetLabel(selectedMatch)} · {compactKst(selectedMatch.game_creation, selectedMatch.game_creation_precision)}</p>
                <p className="mt-1 text-ink-400">
                  {selectedMatch.visibility === "hidden" ? "공개 제외" : selectedMatch.review_completed_at ? "검수 완료" : "미검수"}
                  {` · 참가자 연결 ${selectedMatch.linked_count}/10 · 포지션 ${selectedMatch.position_count}/10 · 챔피언 ${selectedMatch.champion_count}/10 · KDA ${selectedMatch.kda_count}/10`}
                </p>
                <a href={matchHref(selectedMatch.match_id)} className="mt-3 inline-block rounded border border-accent-600 px-3 py-1.5 text-accent-400 hover:bg-accent-600/10">경기 화면에서 검수 →</a>
              </div> : <div className="ck-review-panel p-4 text-xs leading-relaxed text-ink-400">
                {matches.length ? "큐에서 경기를 고르면 요약과 검수 링크가 나옵니다." : "이 VOD 에서 저장된 경기가 없습니다. 결과 프레임에서 새 경기를 만들 수 있습니다."}
              </div>}
              {!memo.active && selected && !selected.match_id && <CreateMatchFromFrame key={selected.id} frame={selected} matches={matches} events={events}
                onCreated={(matchId) => router.push(matchHref(matchId, "roster"))} />}
            </div>
          </div>
        </aside>
      </div>

      <ReviewQueue memo={memo} matchesOnly={matchesOnly} onFilterChange={changeQueueFilter} projection={projection} frames={frames} selectedFrameId={memo.active ? null : selectedId}
        onPickFrame={pickQueueFrame} selectedMatchId={memo.active ? null : selectedMatch?.match_id ?? null} onPickMatch={pickMatch} />
    </div>
  );
}

function CreateMatchFromFrame({ frame, matches, events, onCreated }: {
  frame: ReviewFrame; matches: ReviewMatch[]; events: ReviewEvent[]; onCreated: (id: string) => void;
}) {
  const [seriesId, setSeriesId] = useState("");
  const [state, action] = useActionState<ActionState & { matchId?: string; existingMatchId?: string }, FormData>(async (
    prev: ActionState & { matchId?: string; existingMatchId?: string }, form: FormData,
  ) => {
    const result = await createMatchFromFrameAction(prev, form);
    if (result.matchId) onCreated(result.matchId);
    return result;
  }, IDLE);
  const series = [...new Map(matches.filter(m => m.series_id).map(m => [m.series_id!, m])).values()];
  const reference = matches.find(m => m.series_id === seriesId);
  return <details className="ck-review-panel mb-3 p-3 text-xs">
    <summary className="cursor-pointer text-accent-400">이 프레임으로 새 경기 만들기</summary>
    <form action={action} className="mt-3 grid gap-3">
      <input type="hidden" name="frame_id" value={frame.id} />
      <label>시리즈<select name="series_id" value={seriesId} onChange={e => setSeriesId(e.target.value)} className={inputClass}>
        <option value="">시리즈 없이 생성</option>
        {series.map(m => <option key={m.series_id} value={m.series_id!}>
          {events.find(e => e.id === m.event_id)?.name ?? "대회 미지정"} · {m.series_id}
        </option>)}
      </select></label>
      {seriesId ? <label>세트 번호<input name="series_game_no" type="number" min="1" step="1" required className={inputClass} placeholder="예: 3" /></label>
        : <label>대회<select name="event_id" className={inputClass}><option value="">연결 없음</option>
          {events.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select></label>}
      <label>경기 날짜 (한국 시간)<input key={seriesId} name="played_on" type="date" required
        defaultValue={reference?.game_creation.slice(0, 10) ?? ""} className={inputClass} /></label>
      <label>승리 팀<select name="winning_team" className={inputClass}>
        <option value="">미상</option><option value="100">1팀 (블루)</option><option value="200">2팀 (레드)</option>
      </select></label>
      <p className="text-ink-400">확인한 날짜와 세트를 지정하세요. 생성 후 빈 로스터를 입력할 수 있으며, 검수 완료로 처리되지는 않습니다.</p>
      <SubmitButton>경기 생성·프레임 연결</SubmitButton>
      <ActionMessage state={state} />
    </form>
    {state.existingMatchId && <form action={async form => {
      await relinkFrameAction(form);
      onCreated(state.existingMatchId!);
    }} className="mt-2">
      <input type="hidden" name="frame_id" value={frame.id} />
      <input type="hidden" name="match_id" value={state.existingMatchId} />
      <SubmitButton>기존 세트에 연결</SubmitButton>
    </form>}
  </details>;
}

// ── 경기 큐 + 위치 미니맵 ─────────────────────────────────────────────

function ReviewQueue({ memo, projection, frames, selectedFrameId, onPickFrame, selectedMatchId, onPickMatch, matchesOnly, onFilterChange }: {
  memo: MemoReferenceState;
  frames: ReviewFrame[];
  selectedFrameId: string | null;
  onPickFrame: (id: string) => void;
  matchesOnly: boolean;
  onFilterChange: (value: boolean) => void;
  projection: Projected[];
  selectedMatchId: string | null;
  onPickMatch: (id: string) => void;
}) {
  const visible = chronologicalReviewQueue(projection, frames, memo.data?.groups ?? [], matchesOnly);
  const activeIndex = activeQueueIndex(visible, { memoKey: memo.active ? memo.picked?.key ?? null : null, frameId: selectedFrameId, matchId: selectedMatchId });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable=true]") || target?.closest("dialog")) return;
      if (!visible.length) return;
      event.preventDefault();
      const current = activeIndex;
      const next = event.key === "ArrowDown"
        ? Math.min(current < 0 ? 0 : current + 1, visible.length - 1)
        : Math.max(current < 0 ? visible.length - 1 : current - 1, 0);
      const entry = visible[next];
      if (entry.kind === "memo") memo.open(entry.group);
      else if (entry.kind === "frame") onPickFrame(entry.id); else onPickMatch(entry.id);
      requestAnimationFrame(() => document.getElementById(`ck-review-queue-${entry.kind}:${entry.id}`)?.scrollIntoView({ block: "nearest" }));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onPickMatch, onPickFrame, visible, activeIndex, memo.open]);
  return (
    <section className="ck-review-timeline" aria-label="검수 큐">
      <header className="ck-review-queue-head">
        <div><h3>검수 큐</h3></div>
        <div className="flex gap-2 text-xs">{[false, true].map(value => <button key={String(value)} type="button" aria-pressed={matchesOnly === value}
          className={matchesOnly === value ? "text-accent-400" : "text-ink-400"} onClick={() => onFilterChange(value)}>{value ? "경기" : "전체"}</button>)}</div>
      </header>

      <ul className="ck-review-queue-list">
        {visible.map(entry => {
          if (entry.kind === "memo") return (
            <li key={`memo:${entry.id}`} id={`ck-review-queue-memo:${entry.id}`}>
              <button type="button" className="ck-review-queue-item" data-kind="memo"
                aria-current={visible[activeIndex] === entry ? "true" : undefined}
                onClick={() => memo.open(entry.group)} title="자동 수집한 메모장 참고 후보">
                <time>{hms(entry.group.from)}{entry.group.to !== entry.group.from ? `–${hms(entry.group.to)}` : ""}</time>
                <span className="ck-review-queue-kind">메모장 후보 · {entry.group.frames.length}장</span>
              </button>
            </li>
          );
          if (entry.kind === "frame") return (
            <li key={`frame:${entry.id}`} id={`ck-review-queue-frame:${entry.id}`}>
              <button type="button" className="ck-review-queue-item" data-kind="frame"
                aria-current={visible[activeIndex] === entry ? "true" : undefined}
                onClick={() => onPickFrame(entry.id)} title={entry.frame.frame_path}>
                <time>{entry.at === UNPLACED ? "시각 미상" : hms(entry.at)}</time>
                <span className="ck-review-queue-kind">미연결 프레임 · {KIND_LABEL[entry.frame.kind]}</span>
              </button>
            </li>
          );
          const { match, at, end } = entry.item;
          return (
          <li key={match.match_id} id={`ck-review-queue-match:${match.match_id}`}>
            <button type="button" className="ck-review-queue-item" data-kind="match"
              aria-current={visible[activeIndex]?.kind === "match" && visible[activeIndex].id === match.match_id ? "true" : undefined}
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
        );
        })}
        {visible.length === 0 && <li className="ck-review-queue-empty">해당하는 경기나 프레임이 없습니다.</li>}
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
      <img loading="lazy" decoding="async" src={frameThumbUrl(frame.frame_path)} alt={`${hms(frame.at_sec)} 프레임`} />
      <span>{hms(frame.at_sec)}</span>
    </button>)}
  </div>;
}
