"use client";

/**
 * FC 화면 경기 검수 작업대 — LoL 경기 검수(CkReviewer)와 같은 3칸 구조.
 *
 *   ┌──────────────┬───────────────────────┬──────────────────┐
 *   │ 큐            │ 프레임                  │ 값 설정            │
 *   │ 이 VOD 의 경기 │ 근거 사진을 본다         │ 닉네임·점수·사람    │
 *   │              │                        │ 같은 경기 연결·완료 │
 *   └──────────────┴───────────────────────┴──────────────────┘
 *   칸 배치·크기는 CK 검수(ck-review-*)의 CSS 를 그대로 쓴다 — 두 화면이 어긋나지 않게 새 격자를 만들지 않았다.
 *
 * ★ 선택·프레임 이동은 클라이언트 상태다(저장이 아니므로 왕복하지 않는다). 저장은 서버 액션이고 core 함수를 그대로 부른다.
 * ★ 이 화면은 공개 여부를 바꾸지 않는다. 완료는 "사람이 봤다"는 도장이다(core/screen-review.ts 머리말).
 */

import { useActionState, useEffect, useMemo, useRef, useState } from "react";

import type { FcoEventOption } from "@soop-lol/core/lib/games/fconline/context";
import type { ScreenCandidate, ScreenMatchView, ScreenWorkspace } from "@soop-lol/core/lib/games/fconline/screen-review";

import {
  linkScreenAction, saveScreenSidesAction, setScreenCompletedAction, unlinkScreenAction,
} from "@/app/admin/fco/screen/actions";
import { IDLE } from "@/lib/action-state";
import type { VodFrame } from "@/lib/vod-frames";

import { ActionMessage, SubmitButton } from "./Field";
import { FcoReviewControls, type ReviewControlsUnit } from "./FcoWorkspace";

const inputClass =
  "w-full rounded border border-ink-700 bg-ink-950 px-2 py-1 text-xs text-ink-200 " +
  "placeholder:text-ink-400/50 outline-none focus:border-accent-600";

const frameUrl = (path: string) => `/admin/ck/frame/${path.split("/").map(encodeURIComponent).join("/")}`;
const kst = (iso: string) => new Date(iso).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const hms = (sec: number | null) => {
  if (sec == null) return "—";
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};
const vodAt = (url: string, sec: number | null) => (sec == null ? url : `${url}?change_second=${sec}`);

type Filter = "all" | "todo" | "unlinked" | "candidates";
type MatchStatus = "linked" | "candidates" | "solo";
const statusOf = (m: ScreenMatchView): MatchStatus => (m.link ? "linked" : m.candidates.some((c) => c.verdict !== "none") ? "candidates" : "solo");
const STATUS_LABEL: Record<MatchStatus, string> = { linked: "연결됨", candidates: "후보 있음", solo: "단독" };
const VERDICT_LABEL: Record<ScreenCandidate["verdict"], string> = { same: "일치", maybe: "일부 일치", none: "같은 사람이 낀 가까운 경기" };

const scoreText = (m: ScreenMatchView) => m.sides.map((s) => s.score ?? "?").join(" : ");
const sideName = (s: ScreenMatchView["sides"][number]) => s.streamer_name ?? s.nickname;

/** 이동 간격(초). 3초가 시트 한 칸이다. 큰 간격으로 맥락을 훑고 작은 간격으로 정확한 순간을 잡는다. */
/** 0 = 원본 프레임만(미리 뽑아 둔 앞뒤 원본 — npm run fco:frames). 나머지는 시간 간격(썸네일 칸, 원본이 있으면 원본). */
const STEPS = [0, 3, 10, 30, 60, 300] as const;
const STEP_LABEL: Record<number, string> = { 0: "원본", 3: "3초", 10: "10초", 30: "30초", 60: "1분", 300: "5분" };
/** 띠는 지금 보는 지점 앞뒤로 이만큼 칸을 보여 준다. */
const STRIP_SIDE = 12;
const offsetLabel = (sec: number) => `${sec < 0 ? "−" : "+"}${String(Math.floor(Math.abs(sec) / 60)).padStart(2, "0")}:${String(Math.abs(sec) % 60).padStart(2, "0")}`;

export function FcoScreenReviewer({ ws, vodFrames, vodLengthSec, eventOptions, initialMatchId }: { ws: ScreenWorkspace; vodFrames: VodFrame[]; vodLengthSec: number | null; eventOptions: FcoEventOption[]; initialMatchId?: string }) {
  const first = ws.matches.find((m) => m.match_id === initialMatchId) ?? ws.matches.find((m) => !m.review_completed_at) ?? ws.matches[0];
  const [selectedId, setSelectedId] = useState(first?.match_id ?? null);
  const [frameKey, setFrameKey] = useState<string | null>(null);
  const [zoom, setZoom] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");

  const selected = ws.matches.find((m) => m.match_id === selectedId) ?? null;
  const frame = selected ? (selected.frames.find((f) => f.evidence_key === frameKey) ?? selected.frames[0] ?? null) : null;
  const done = ws.matches.filter((m) => m.review_completed_at).length;

  const visible = useMemo(() => ws.matches.filter((m) => {
    if (filter === "todo") return !m.review_completed_at;
    if (filter === "unlinked") return !m.link;
    if (filter === "candidates") return statusOf(m) === "candidates";
    return true;
  }), [ws.matches, filter]);

  // ── 프레임 이동 ──────────────────────────────────────────────
  // viewSec: 지금 크게 보는 지점(null = 이 경기의 결과 프레임). 원본 프레임이 있는 초면 원본을, 없으면 3초 썸네일 칸을 보여 준다.
  const [viewSec, setViewSec] = useState<number | null>(null);
  const [stepSec, setStepSec] = useState<number | null>(null); // null = 아직 안 골랐다 → 원본이 있으면 원본, 없으면 30초
  const stripRef = useRef<HTMLDivElement>(null);
  // 불러오지 못한 그림(파일이 지워졌거나 서버 오류). 깨진 아이콘 대신 이유를 말한다.
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const markFailed = (src: string) => setFailed((prev) => new Set(prev).add(src));
  const pick = (id: string) => { setSelectedId(id); setFrameKey(null); setViewSec(null); };

  const allFrames = useMemo(() => {
    const byPath = new Map<string, VodFrame>(vodFrames.map((f) => [f.path, f]));
    for (const m of ws.matches) for (const f of m.frames) if (f.at_sec != null && !byPath.has(f.frame_path)) byPath.set(f.frame_path, { sec: f.at_sec, path: f.frame_path });
    return [...byPath.values()].sort((a, b) => a.sec - b.sec);
  }, [vodFrames, ws.matches]);
  const resultPaths = useMemo(() => new Set(ws.matches.flatMap((m) => m.frames.map((f) => f.frame_path))), [ws.matches]);
  const resultSecs = useMemo(() => new Set(allFrames.filter((f) => resultPaths.has(f.path)).map((f) => f.sec)), [allFrames, resultPaths]);
  const minePaths = new Set(selected?.frames.map((f) => f.frame_path) ?? []);

  const center = frame?.at_sec ?? selected?.at_sec ?? null;
  const shownSec = viewSec ?? center;
  const cellsOk = vodLengthSec != null;
  const clampSec = (sec: number) => Math.max(0, Math.min(sec, cellsOk ? Math.floor(vodLengthSec! - 1) : sec));
  // 원본 프레임이 그 초(±1)에 있으면 원본, 없으면 썸네일 칸
  const fullRes = shownSec == null ? null : allFrames.find((f) => Math.abs(f.sec - shownSec) <= 1) ?? null;
  const shownIsCell = shownSec != null && !fullRes && cellsOk;
  const shownSrc = fullRes ? frameUrl(fullRes.path) : shownIsCell ? `/admin/fco/screen/cell/${ws.vod}/${shownSec}` : null;
  // 원본이 이 경기 근처(±5분)에 3장 이상 있으면 기본을 "원본"으로 — 읽을 수 있는 화면부터 넘긴다.
  const hasOriginals = center != null && allFrames.filter((f) => Math.abs(f.sec - center) <= 300).length >= 3;
  const stepNow = stepSec ?? (hasOriginals ? 0 : 30);
  const step = (dir: -1 | 1) => {
    if (shownSec == null) return;
    if (stepNow === 0) {
      const next = dir === 1 ? allFrames.find((f) => f.sec > shownSec + 1) : [...allFrames].reverse().find((f) => f.sec < shownSec - 1);
      if (next) setViewSec(next.sec);
    } else setViewSec(clampSec(shownSec + dir * stepNow));
  };
  const thumbSrc = (t: number) => { const f = allFrames.find((x) => Math.abs(x.sec - t) <= 1); return f ? frameUrl(f.path) : `/admin/fco/screen/cell/${ws.vod}/${t}`; };

  // 띠: 지금 보는 지점 앞뒤. 원본 모드는 원본 프레임만, 시간 모드는 같은 간격의 칸(원본이 있으면 원본으로). ★ = 결과 화면.
  const strip = useMemo(() => {
    if (shownSec == null) return [];
    if (stepNow === 0) return allFrames.filter((f) => Math.abs(f.sec - shownSec) <= 900).map((f) => f.sec);
    if (!cellsOk) return [];
    const out: number[] = [];
    for (let k = -STRIP_SIDE; k <= STRIP_SIDE; k++) { const t = shownSec + k * stepNow; if (t >= 0 && t < vodLengthSec!) out.push(t); }
    return out;
  }, [shownSec, stepNow, cellsOk, vodLengthSec, allFrames]);
  const isResultAt = (t: number) => [...resultSecs].some((r) => Math.abs(r - t) <= Math.max(1, stepNow / 2));

  // ← → 로 앞뒤. 입력칸에 글을 쓰는 중에는 가로채지 않는다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;
      if (e.key === "ArrowLeft") { e.preventDefault(); step(-1); }
      if (e.key === "ArrowRight") { e.preventDefault(); step(1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  useEffect(() => {
    stripRef.current?.querySelector<HTMLElement>('[data-current="true"]')?.scrollIntoView({ inline: "center", block: "nearest" });
  }, [shownSec, selectedId, stepNow]);

  const FILTERS: [Filter, string][] = [["all", "전체"], ["todo", "미완료"], ["unlinked", "연결 안 됨"], ["candidates", "후보 있음"]];

  return (
    <div className="ck-review-workbench">
      <div className="ck-review-stage">
      {/* ── ① 프레임 ───────────────────────────────────────────── */}
      <section className="ck-review-preview">
        <header className="flex items-center justify-between gap-3 border-b border-ink-800 px-4 py-2">
          <div className="min-w-0 text-xs text-ink-400">
            {shownSec != null && shownSrc ? <>
              <span className="font-mono text-accent-400">{hms(shownSec)}</span>
              {center != null && shownSec !== center && <span className="ml-1.5 font-mono text-ink-200">(결과 {offsetLabel(shownSec - center)})</span>}
              <span className="mx-2 text-ink-600">·</span>
              {fullRes && minePaths.has(fullRes.path) ? "결과 화면 — 조사가 확정한 프레임"
                : fullRes && resultPaths.has(fullRes.path) ? "다른 경기의 결과 화면"
                : fullRes ? "원본 프레임"
                : "썸네일(3초 칸·저해상도) — 원본은 아직 뽑지 않았습니다"}
            </> : selected ? "이 경기에 근거 프레임이 없습니다." : "검수할 경기가 없습니다."}
          </div>
          <div className="flex shrink-0 items-center gap-2 text-xs">
            <a href={vodAt(ws.url, shownSec ?? selected?.at_sec ?? null)} target="_blank" rel="noreferrer" className="text-accent-400">이 시점 VOD ↗</a>
            {shownSrc && <>
              <button type="button" onClick={() => setZoom((z) => !z)} className="rounded border border-ink-700 px-2 py-1 text-ink-400 hover:text-ink-200">{zoom ? "맞추기" : "원본 크기"}</button>
              <a href={shownSrc} target="_blank" rel="noreferrer" className="rounded border border-ink-700 px-2 py-1 text-ink-400 hover:text-ink-200">새 탭 ↗</a>
            </>}
          </div>
        </header>
        {/* 원본 크기에서는 스크롤로 닉네임 칸을 들여다본다 — 오독은 확대해야 보인다. */}
        <div className={`ck-review-frame bg-ink-950 ${zoom ? "max-h-[75vh] overflow-auto" : ""}`}>
          {shownSrc && !failed.has(shownSrc) ? (
            // eslint-disable-next-line @next/next/no-img-element -- out/ 밖의 로컬 파일이라 next/image 로 최적화하지 않는다
            <img src={shownSrc} alt={`${hms(shownSec ?? 0)} 프레임`} onError={() => markFailed(shownSrc)} className={`ck-review-frame-image ${zoom ? "max-w-none" : "w-full"}`} />
          ) : shownSrc ? (
            <div className="grid gap-2 px-6 py-14 text-center text-sm text-ink-400">
              <p className="text-ink-200">{hms(shownSec ?? 0)} 의 {fullRes ? "원본 프레임 파일" : "썸네일 칸"}을 불러오지 못했습니다.</p>
              <p className="text-xs">{fullRes ? "파일이 지워졌거나 경로가 바뀌었습니다." : "이 칸이 들어 있는 썸네일 시트가 지워졌거나 범위 밖입니다."} 같은 지점을 다시 뽑으려면:</p>
              <code className="mx-auto rounded bg-ink-800 px-2 py-1 text-xs">npm run ck:probe -- --vod {ws.vod} --at {shownSec}</code>
            </div>
          ) : <p className="px-4 py-16 text-center text-sm text-ink-400">보여 줄 프레임이 없습니다.{selected && !cellsOk ? " 이 VOD 의 썸네일 시트가 지워져 앞뒤 칸도 볼 수 없습니다." : ""}</p>}
        </div>
        {shownSec != null && (
          <footer className="grid gap-2 border-t border-ink-800 px-4 py-2">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <button type="button" onClick={() => step(-1)} disabled={shownSec <= 0} className="rounded border border-ink-700 px-2 py-1 text-ink-200 hover:border-accent-400 disabled:opacity-40">← {stepNow === 0 ? "이전 원본" : `${STEP_LABEL[stepNow]} 전`}</button>
              <button type="button" onClick={() => step(1)} className="rounded border border-ink-700 px-2 py-1 text-ink-200 hover:border-accent-400">{stepNow === 0 ? "다음 원본" : `${STEP_LABEL[stepNow]} 후`} →</button>
              <button type="button" onClick={() => setViewSec(null)} disabled={viewSec == null} className="rounded border border-ink-700 px-2 py-1 text-ink-400 hover:text-ink-200 disabled:opacity-40">결과 화면으로</button>
              <span className="ml-auto flex items-center gap-1 text-[11px] text-ink-400">
                간격
                {STEPS.map((n) => (
                  <button key={n} type="button" onClick={() => setStepSec(n)}
                    className={`rounded border px-1.5 py-0.5 ${n === stepNow ? "border-accent-600 text-accent-400" : "border-ink-700 hover:text-ink-200"}`}>{STEP_LABEL[n]}</button>
                ))}
              </span>
            </div>
            {/* 지금 보는 지점 앞뒤의 칸 띠 — 직전의 선택·직후의 반응 같은 맥락. 가운데가 지금 보는 곳, ★ 은 결과 화면. 누르면 그 지점을 크게 본다. */}
            {cellsOk || stepNow === 0 ? (
              <div ref={stripRef} className="flex gap-1.5 overflow-x-auto pb-1" aria-label="앞뒤 프레임">
                {strip.map((t) => {
                  const current = t === shownSec;
                  const isResult = isResultAt(t);
                  return (
                    <button key={t} type="button" data-current={current} onClick={() => setViewSec(t)}
                      className={`relative shrink-0 overflow-hidden rounded border ${current ? "border-accent-600" : isResult ? "border-amber-400/60" : "border-ink-700 hover:border-ink-500"}`}>
                      {failed.has(thumbSrc(t))
                        ? <span className="grid h-[68px] w-[120px] place-items-center bg-ink-900 text-[10px] text-ink-500">없음</span>
                        // eslint-disable-next-line @next/next/no-img-element -- 로컬 파일
                        : <img src={thumbSrc(t)} alt="" loading="lazy" onError={() => markFailed(thumbSrc(t))} className="block h-[68px] w-[120px] object-cover" />}
                      <span className="absolute inset-x-0 bottom-0 bg-ink-950/80 px-1 text-center font-mono text-[10px] text-ink-200">
                        {isResult ? "★ " : ""}{center != null ? offsetLabel(t - center) : hms(t)}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="text-[11px] text-amber-400">이 VOD 의 썸네일 시트가 지워져 시간 간격 띠는 못 보여 줍니다. 위 간격에서 「원본」을 고르면 뽑아 둔 원본 {allFrames.length}장을 넘겨 볼 수 있습니다.</p>
            )}
            <p className="text-[11px] text-ink-400">
              키보드 ← →. 「원본」 간격은 뽑아 둔 원본 프레임만 넘깁니다(결과 화면 앞뒤 2분). 썸네일 칸은 저해상도라 닉네임·점수는 읽기 어렵습니다 —
              원본이 더 필요하면 <code className="rounded bg-ink-800 px-1">npm run fco:frames -- --vod {ws.vod}</code>
            </p>
            {selected && selected.frames.length > 1 && (
              <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-ink-400">
                이 경기의 결과 프레임
                {selected.frames.map((f) => (
                  <button key={f.evidence_key} type="button" onClick={() => { setFrameKey(f.evidence_key); setViewSec(null); }}
                    className={`rounded border px-2 py-0.5 font-mono ${f.evidence_key === frame?.evidence_key ? "border-accent-600 text-accent-400" : "border-ink-700 hover:text-ink-200"}`}>{hms(f.at_sec)}</button>
                ))}
              </div>
            )}
          </footer>
        )}
        {frame?.observed && fullRes && minePaths.has(fullRes.path) && (
          <p className="border-t border-ink-800 px-4 py-2 text-[11px] leading-relaxed text-ink-400">
            <b className="text-ink-200">조사가 읽은 것</b> — {frame.observed}
          </p>
        )}
      </section>

      {/* ── ② 값 설정 ──────────────────────────────────────────── */}
      <aside className="ck-review-inspector" aria-label="값 설정">
        <div className="ck-review-inspector-shell">
          <div className="ck-review-inspector-body">
            {selected ? <MatchPanel key={`${selected.match_id}:${selected.review_version}`} m={selected} ws={ws} eventOptions={eventOptions} />
              : <div className="ck-review-panel p-4 text-xs text-ink-400">큐에서 경기를 고르세요.</div>}
          </div>
        </div>
      </aside>

      </div>

      {/* ── ③ 큐 ───────────────────────────────────────────────── */}
      <section className="ck-review-timeline" aria-label="검수 큐">
        <header className="ck-review-queue-head">
          <h3>이 VOD 의 경기</h3>
          <p>완료 {done} / {ws.matches.length}</p>
          <div className="flex flex-wrap gap-1">
            {FILTERS.map(([key, label]) => (
              <button key={key} type="button" onClick={() => setFilter(key)}
                className={`rounded border px-2 py-0.5 text-[11px] ${filter === key ? "border-accent-600 text-accent-400" : "border-ink-700 text-ink-400 hover:text-ink-200"}`}>{label}</button>
            ))}
          </div>
        </header>
        <ul className="ck-review-queue-list">
          {visible.map((m) => (
            <li key={m.match_id}>
              <button type="button" className="ck-review-queue-item" data-selected={m.match_id === selectedId || undefined} onClick={() => pick(m.match_id)}>
                <span className="min-w-0">
                  <span className="block truncate text-xs text-ink-200">{m.sides.length === 2 ? `${sideName(m.sides[0])} ${scoreText(m)} ${sideName(m.sides[1])}` : m.match_id}</span>
                  <span className="block font-mono text-[10px] text-ink-400">{hms(m.at_sec)} · {kst(m.ended_at)}</span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-0.5 text-[10px]">
                  <span className={m.review_completed_at ? "text-win" : "text-ink-400"}>{m.review_completed_at ? "완료" : "미검수"}</span>
                  <span className={statusOf(m) === "candidates" ? "text-amber-400" : "text-ink-400"}>{STATUS_LABEL[statusOf(m)]}</span>
                </span>
              </button>
            </li>
          ))}
          {visible.length === 0 && <li className="ck-review-queue-empty">해당하는 경기가 없습니다.</li>}
        </ul>
      </section>
    </div>
  );
}

// ── 값 설정 칸 ─────────────────────────────────────────────────────

function MatchPanel({ m, ws, eventOptions }: { m: ScreenMatchView; ws: ScreenWorkspace; eventOptions: FcoEventOption[] }) {
  const [saveState, saveAction] = useActionState(saveScreenSidesAction, IDLE);
  const [doneState, doneAction, donePending] = useActionState(setScreenCompletedAction, IDLE);
  const completed = m.review_completed_at != null;
  const locked = m.link != null;
  const [a, b] = m.sides;
  const outcomeDefault = "auto";

  return (
    <div className="grid gap-3">
      <div className="ck-review-panel p-3">
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink-400">
          <span className="font-mono text-accent-400">{hms(m.at_sec)}</span>
          <span>{kst(m.ended_at)}</span>
          {m.mode_key && <span>모드 {m.mode_key}</span>}
          <span className="ml-auto rounded border border-amber-400/40 px-1.5 py-0.5 text-amber-400">수기 · 숨김</span>
        </div>
        <p className="mt-1 break-all font-mono text-[10px] text-ink-400">{m.match_id}</p>
      </div>

      <form action={saveAction} className="ck-review-panel grid gap-3 p-3">
        <input type="hidden" name="match_id" value={m.match_id} />
        <input type="hidden" name="version" value={m.review_version} />
        {[a, b].map((s, i) => s && (
          <fieldset key={s.side_no} className="grid gap-1.5" disabled={locked}>
            <legend className="mb-0.5 text-[11px] font-semibold text-ink-200">{i === 0 ? "1팀" : "2팀"}</legend>
            <div className="grid grid-cols-[1fr_56px] gap-1.5">
              <input name={`nickname${i + 1}`} defaultValue={s.nickname} className={inputClass} placeholder="화면 닉네임" aria-label={`${i + 1}팀 닉네임`} />
              <input name={`score${i + 1}`} defaultValue={s.score ?? ""} inputMode="numeric" className={`${inputClass} text-center font-mono`} placeholder="점수" aria-label={`${i + 1}팀 점수`} />
            </div>
            <select name={`streamer${i + 1}`} defaultValue={s.identity_basis === "manual" ? (s.streamer_slug ?? "") : ""} className={inputClass} aria-label={`${i + 1}팀 사람`}>
              <option value="">{s.streamer_name ? `자동 — ${s.streamer_name} (${s.identity_basis === "vod_owner" ? "방송 주인" : "닉네임 일치"})` : "자동 — 사람 없음"}</option>
              {ws.streamers.map((st) => <option key={st.slug} value={st.slug}>{st.display_name}</option>)}
            </select>
          </fieldset>
        ))}
        <label className="grid gap-1 text-[11px] text-ink-400">
          결과
          <select name="outcome" defaultValue={outcomeDefault} disabled={locked} className={inputClass}>
            <option value="auto">점수로 정함 (같으면 모름)</option>
            <option value="first_win">1팀 승 (승부차기 등)</option>
            <option value="second_win">2팀 승 (승부차기 등)</option>
            <option value="draw">무승부</option>
          </select>
        </label>
        <div className="flex items-center gap-2">
          <SubmitButton tone="ghost">값 저장</SubmitButton>
          <ActionMessage state={saveState} />
        </div>
        {locked && <p className="text-[11px] text-amber-400">다른 경기에 연결돼 있어 값을 고칠 수 없습니다. 연결을 풀고 고치세요.</p>}
      </form>

      <ContextPanel m={m} eventOptions={eventOptions} />

      <LinkPanel m={m} />

      <form action={doneAction} className="ck-review-panel flex flex-wrap items-center gap-2 p-3">
        <input type="hidden" name="match_id" value={m.match_id} />
        <input type="hidden" name="version" value={m.review_version} />
        <input type="hidden" name="completed" value={completed ? "0" : "1"} />
        <span className={`text-xs ${completed ? "text-win" : "text-ink-400"}`}>{completed ? "검수 완료" : "미검수"}</span>
        <button type="submit" disabled={donePending} className="rounded border border-ink-700 px-2 py-1 text-xs text-ink-200 hover:border-accent-400 disabled:opacity-50">
          {donePending ? "저장 중" : completed ? "완료 취소" : "검수 완료"}
        </button>
        <ActionMessage state={doneState} />
        <p className="w-full text-[11px] text-ink-400">완료해도 공개되지 않습니다. 공개 표시는 별도 단계입니다.</p>
      </form>
    </div>
  );
}

/**
 * 맥락(무슨 판이었나) — 기존 FC 맥락 검수와 **같은 컨트롤**(`FcoReviewControls`)이고 같은 저장 함수를 부른다.
 * 다른 경기에 연결된 화면 경기는 맥락을 그쪽이 가진다 — 여기서 따로 정하면 두 벌이 된다.
 */
function ContextPanel({ m, eventOptions }: { m: ScreenMatchView; eventOptions: FcoEventOption[] }) {
  const unit: ReviewControlsUnit = {
    kind: "match", status: m.context.status, confirmed: m.review_completed_at != null,
    event: m.context.event, judgment: m.context.judgment,
    matches: [{ provider_match_id: m.match_id, participants: m.sides.map((x) => ({ name: sideName(x) })) }],
  };
  return (
    <div className="ck-review-panel grid gap-2 p-3">
      <p className="text-[11px] font-semibold text-ink-200">맥락 — 무슨 판이었나</p>
      {m.link ? (
        <p className="text-[11px] text-ink-400">다른 경기에 연결돼 있어 맥락은 그 경기가 가집니다. 바꾸려면 연결을 풀거나 그 경기에서 정하세요.</p>
      ) : (<>
        {m.context.event && <p className="text-xs text-ink-200">현재: <b className="text-accent-400">{m.context.event.name}</b> <span className="text-ink-400">({m.context.event.kind})</span></p>}
        {!m.context.event && m.context.judgment && (
          <p className="text-xs text-ink-200">현재: <b className={m.context.judgment.judgment === "casual" ? "text-ink-300" : "text-amber-400"}>{m.context.judgment.judgment === "casual" ? "단순 친선" : "미해결"}</b>
            <span className="ml-1 text-ink-400">— {m.context.judgment.note}</span></p>
        )}
        {m.context.status === "uninvestigated" && <p className="text-xs text-ink-400">아직 맥락을 정하지 않았습니다.</p>}
        <FcoReviewControls compact unit={unit} eventOptions={eventOptions} activeMatch={unit.matches[0]} />
      </>)}
    </div>
  );
}

function LinkPanel({ m }: { m: ScreenMatchView }) {
  const [linkState, linkAction] = useActionState(linkScreenAction, IDLE);
  const [unlinkState, unlinkAction] = useActionState(unlinkScreenAction, IDLE);

  if (m.link) {
    return (
      <form action={unlinkAction} className="ck-review-panel grid gap-2 p-3">
        <input type="hidden" name="match_id" value={m.match_id} />
        <input type="hidden" name="version" value={m.review_version} />
        <p className="text-[11px] text-ink-400">
          <b className="text-ink-200">연결됨</b> — {m.link.decided_by === "admin" ? "사람이" : "자동으로"} 같은 경기로 이었습니다.
        </p>
        <p className="break-all font-mono text-[10px] text-ink-400">{m.link.api_match_id}</p>
        <div className="flex items-center gap-2"><SubmitButton tone="danger">연결 풀기</SubmitButton><ActionMessage state={unlinkState} /></div>
      </form>
    );
  }
  return (
    <div className="ck-review-panel grid gap-2 p-3">
      <p className="text-[11px] font-semibold text-ink-200">같은 경기일 수 있는 기록</p>
      {m.candidates.length === 0 && <p className="text-[11px] text-ink-400">근처(±30분)에 후보가 없습니다. 이 경기는 단독으로 남습니다.</p>}
      {m.candidates.map((c) => (
        <form key={c.match_id} action={linkAction} className="grid gap-1 rounded border border-ink-800 p-2">
          <input type="hidden" name="match_id" value={m.match_id} />
          <input type="hidden" name="version" value={m.review_version} />
          <input type="hidden" name="target_id" value={c.match_id} />
          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
            <span className={c.verdict === "same" ? "text-win" : c.verdict === "maybe" ? "text-amber-400" : "text-ink-400"}>{VERDICT_LABEL[c.verdict]}</span>
            <span className="text-ink-400">· {c.source === "provider_api" ? "API" : "화면"} · {c.gap_sec >= 0 ? "+" : ""}{Math.round(c.gap_sec / 60)}분</span>
          </div>
          <p className="text-xs text-ink-200">{c.sides.map((s) => `${s.streamer_name ?? s.nickname} ${s.score ?? "?"}`).join(" : ")}</p>
          <p className="break-all font-mono text-[10px] text-ink-400">{c.match_id}</p>
          <div className="flex items-center gap-2"><SubmitButton tone="ghost">같은 경기로 연결</SubmitButton></div>
        </form>
      ))}
      <ActionMessage state={linkState} />
    </div>
  );
}
