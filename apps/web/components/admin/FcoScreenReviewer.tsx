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

import type { FcoEventOption } from "@soop-lol/core/lib/games/fconline/context";
import type { ScreenCandidate, ScreenMatchView, ScreenWorkspace } from "@soop-lol/core/lib/games/fconline/screen-review";

import {
  linkScreenAction, saveScreenSidesAction, setScreenCompletedAction, unlinkScreenAction,
} from "@/app/admin/fco/screen/actions";
import { IDLE } from "@/lib/action-state";

import { ActionMessage, SubmitButton } from "./Field";
import { FcoReviewControls, type ReviewControlsUnit } from "./FcoWorkspace";
import { VodFrameViewer, type ViewerVod } from "./VodFrameViewer";

const inputClass =
  "w-full rounded border border-ink-700 bg-ink-950 px-2 py-1 text-xs text-ink-200 " +
  "placeholder:text-ink-400/50 outline-none focus:border-accent-600";

const kst = (iso: string) => new Date(iso).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const hms = (sec: number | null) => {
  if (sec == null) return "—";
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};

type Filter = "all" | "todo" | "unlinked" | "candidates";
type MatchStatus = "linked" | "candidates" | "solo";
const statusOf = (m: ScreenMatchView): MatchStatus => (m.link ? "linked" : m.candidates.some((c) => c.verdict !== "none") ? "candidates" : "solo");
const STATUS_LABEL: Record<MatchStatus, string> = { linked: "연결됨", candidates: "후보 있음", solo: "단독" };
const VERDICT_LABEL: Record<ScreenCandidate["verdict"], string> = { same: "일치", maybe: "일부 일치", none: "같은 사람이 낀 가까운 경기" };

const scoreText = (m: ScreenMatchView) => m.sides.map((s) => s.score ?? "?").join(" : ");
const sideName = (s: ScreenMatchView["sides"][number]) => s.streamer_name ?? s.nickname;
const BASIS_LABEL: Record<string, string> = { vod_owner: "방송 주인", nickname_match: "닉네임 일치", manual: "사람이 지정" };
/** 저장된 결과를 편집 선택지로. 점수로 정해지는 결과와 같으면 auto, 아니면 직접 본 결과. */
function outcomeEditOf(scoreA: number | null, scoreB: number | null, outcomeA: string | null): "auto" | "first_win" | "second_win" | "draw" {
  const byScore = scoreA == null || scoreB == null || scoreA === scoreB ? "unknown" : scoreA > scoreB ? "win" : "loss";
  if (outcomeA == null || outcomeA === byScore) return "auto";
  return outcomeA === "win" ? "first_win" : outcomeA === "loss" ? "second_win" : outcomeA === "draw" ? "draw" : "auto";
}

export function FcoScreenReviewer({ ws, vods, eventOptions, initialMatchId }: { ws: ScreenWorkspace; vods: Record<string, ViewerVod>; eventOptions: FcoEventOption[]; initialMatchId?: string }) {
  const first = ws.matches.find((m) => m.match_id === initialMatchId) ?? ws.matches.find((m) => !m.review_completed_at) ?? ws.matches[0];
  const [selectedId, setSelectedId] = useState(first?.match_id ?? null);
  const [filter, setFilter] = useState<Filter>("all");

  const selected = ws.matches.find((m) => m.match_id === selectedId) ?? null;
  const done = ws.matches.filter((m) => m.review_completed_at).length;

  const visible = useMemo(() => ws.matches.filter((m) => {
    if (filter === "todo") return !m.review_completed_at;
    if (filter === "unlinked") return !m.link;
    if (filter === "candidates") return statusOf(m) === "candidates";
    return true;
  }), [ws.matches, filter]);

  const pick = (id: string) => setSelectedId(id);
  // 뷰어 재료 — 이 경기의 근거 프레임, 이 VOD 의 결과 화면 초(★ 표시)
  const resultSecs = useMemo(() => ({ [ws.vod]: ws.matches.flatMap((m) => m.frames.map((f) => f.at_sec).filter((x): x is number => x != null)) }), [ws]);
  const evidence = useMemo(() => (selected?.frames ?? []).map((f) => ({
    key: f.evidence_key, path: f.frame_path, sec: f.at_sec, vod: ws.vod,
    label: f.role === "result" ? "결과" : f.role, result: f.role === "result", observed: f.observed,
  })), [selected, ws.vod]);

  const FILTERS: [Filter, string][] = [["all", "전체"], ["todo", "미완료"], ["unlinked", "연결 안 됨"], ["candidates", "후보 있음"]];

  return (
    <div className="ck-review-workbench">
      <div className="ck-review-stage">
      {/* ── ① 프레임 — 공용 뷰어(맥락 검수와 같은 부품). 경기를 바꾸면 처음(결과 화면)부터 본다. ── */}
      <VodFrameViewer key={selected?.match_id ?? "none"} evidence={evidence} vods={vods} resultSecs={resultSecs}
        emptyText={selected ? "이 경기에 근거 프레임이 없습니다." : "검수할 경기가 없습니다."} />

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
  // 결과 기본값은 **지금 저장된 결과**다. 승부차기처럼 화면에서 직접 본 결과를 "점수로 정함"으로 두면 저장할 때 지워진다
  // (화면 경기 30칸이 점수가 같은데 승패가 정해져 있다).
  const outcomeDefault = outcomeEditOf(a?.score ?? null, b?.score ?? null, a?.outcome ?? null);

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
            <select name={`streamer${i + 1}`} defaultValue="" className={inputClass} aria-label={`${i + 1}팀 사람`}>
              <option value="">{s.streamer_name ? `그대로 — ${s.streamer_name} (${BASIS_LABEL[s.identity_basis ?? ""] ?? "근거 없음"})` : "그대로 — 사람 없음"}</option>
              <option value="__auto">닉네임으로 다시 판정 (등록 계정과 하나만 일치할 때)</option>
              {s.streamer_id && <option value="__none">사람 떼기</option>}
              <optgroup label="FC 계정 등록됨">
                {ws.streamers.filter((st) => st.has_fc).map((st) => <option key={st.slug} value={st.slug}>{st.display_name}</option>)}
              </optgroup>
              <optgroup label="그 밖의 공개 스트리머">
                {ws.streamers.filter((st) => !st.has_fc).map((st) => <option key={st.slug} value={st.slug}>{st.display_name}</option>)}
              </optgroup>
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
