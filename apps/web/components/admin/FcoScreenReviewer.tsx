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

import { useActionState, useMemo, useState } from "react";

import type { ScreenCandidate, ScreenMatchView, ScreenWorkspace } from "@soop-lol/core/lib/games/fconline/screen-review";

import {
  linkScreenAction, saveScreenSidesAction, setScreenCompletedAction, unlinkScreenAction,
} from "@/app/admin/fco/screen/actions";
import { IDLE } from "@/lib/action-state";

import { ActionMessage, SubmitButton } from "./Field";

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

export function FcoScreenReviewer({ ws, initialMatchId }: { ws: ScreenWorkspace; initialMatchId?: string }) {
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

  const pick = (id: string) => { setSelectedId(id); setFrameKey(null); };
  const FILTERS: [Filter, string][] = [["all", "전체"], ["todo", "미완료"], ["unlinked", "연결 안 됨"], ["candidates", "후보 있음"]];

  return (
    <div className="ck-review-workbench">
      <div className="ck-review-stage">
      {/* ── ① 프레임 ───────────────────────────────────────────── */}
      <section className="ck-review-preview">
        <header className="flex items-center justify-between gap-3 border-b border-ink-800 px-4 py-2">
          <div className="min-w-0 text-xs text-ink-400">
            {frame ? <><span className="font-mono text-accent-400">{hms(frame.at_sec)}</span><span className="mx-2 text-ink-600">·</span>{frame.role === "result" ? "결과 화면" : (frame.role ?? "프레임")}</>
              : selected ? "이 경기에 근거 프레임이 없습니다." : "검수할 경기가 없습니다."}
          </div>
          <div className="flex shrink-0 items-center gap-2 text-xs">
            <a href={vodAt(ws.url, frame?.at_sec ?? selected?.at_sec ?? null)} target="_blank" rel="noreferrer" className="text-accent-400">이 시점 VOD ↗</a>
            {frame && <>
              <button type="button" onClick={() => setZoom((z) => !z)} className="rounded border border-ink-700 px-2 py-1 text-ink-400 hover:text-ink-200">{zoom ? "맞추기" : "원본 크기"}</button>
              <a href={frameUrl(frame.frame_path)} target="_blank" rel="noreferrer" className="rounded border border-ink-700 px-2 py-1 text-ink-400 hover:text-ink-200">새 탭 ↗</a>
            </>}
          </div>
        </header>
        {/* 원본 크기에서는 스크롤로 닉네임 칸을 들여다본다 — 오독은 확대해야 보인다. */}
        <div className={`ck-review-frame bg-ink-950 ${zoom ? "max-h-[75vh] overflow-auto" : ""}`}>
          {frame ? (
            // eslint-disable-next-line @next/next/no-img-element -- out/ 밖의 로컬 파일이라 next/image 로 최적화하지 않는다
            <img src={frameUrl(frame.frame_path)} alt={`${hms(frame.at_sec)} 프레임`} className={`ck-review-frame-image ${zoom ? "max-w-none" : "w-full"}`} />
          ) : <p className="px-4 py-16 text-center text-sm text-ink-400">보여 줄 프레임이 없습니다.</p>}
        </div>
        {selected && selected.frames.length > 1 && (
          <footer className="flex flex-wrap gap-1.5 border-t border-ink-800 px-4 py-2">
            {selected.frames.map((f) => (
              <button key={f.evidence_key} type="button" onClick={() => setFrameKey(f.evidence_key)}
                className={`rounded border px-2 py-1 font-mono text-[11px] ${f.evidence_key === frame?.evidence_key ? "border-accent-600 text-accent-400" : "border-ink-700 text-ink-400 hover:text-ink-200"}`}>
                {hms(f.at_sec)}
              </button>
            ))}
          </footer>
        )}
        {frame?.observed && (
          <p className="border-t border-ink-800 px-4 py-2 text-[11px] leading-relaxed text-ink-400">
            <b className="text-ink-200">조사가 읽은 것</b> — {frame.observed}
          </p>
        )}
      </section>

      {/* ── ② 값 설정 ──────────────────────────────────────────── */}
      <aside className="ck-review-inspector" aria-label="값 설정">
        <div className="ck-review-inspector-shell">
          <div className="ck-review-inspector-body">
            {selected ? <MatchPanel key={`${selected.match_id}:${selected.review_version}`} m={selected} ws={ws} />
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

function MatchPanel({ m, ws }: { m: ScreenMatchView; ws: ScreenWorkspace }) {
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
