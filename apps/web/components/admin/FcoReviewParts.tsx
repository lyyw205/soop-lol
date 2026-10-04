"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { adminHref, adminReturn } from "@/lib/admin-navigation";
import { useActionState } from "react";

import type { FcoEventOption, FcoReviewUnit } from "@soop-lol/core/lib/games/fconline/context";

import { IDLE, type ActionState } from "@/lib/action-state";
import { decideMatchAction, reviewToggleAction, setClassAction, updateEventAction } from "@/app/admin/fco/actions";
import { AdminHistory } from "./AdminHistory";
import { useReviewDraft } from "./use-review-draft";
import { EVENT_KIND_LABEL } from "@/lib/admin-labels";

/**
 * FC 검수 부품 — 분류(맥락) 컨트롤 · 대회 탭 · 대회 포함/제외 결정. 작업대는 FcoMatchWorkbench 하나이고 이 부품들을 쓴다.
 * (예전 맥락 검수 작업대 FcoWorkspace 에서 떼어 냈다 — 작업대가 두 벌이던 것을 하나로 합치면서. 2026-10-02)
 */

/**
 * KST 짧은 시각. ⚠ `toLocaleString` 을 쓰지 않는다 — 서버(Node)와 브라우저의 로케일
 * 기본값이 달라 `오후 06:51` / `PM 06:51` 로 갈리고, 그대로 하이드레이션이 깨진다(실측).
 */
export const kstShort = (iso: string) => {
  const d = new Date(new Date(iso).getTime() + 9 * 3600_000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
};


export function Result({ state }: { state: ActionState }) {
  if (!state.message) return null;
  return <p role="status" className={`text-xs ${state.ok ? "text-ink-400" : "text-red-400"}`}>{state.ok ? state.message : `✗ ${state.message}`}</p>;
}

/**
 * 검수 조작부 — 자주 쓰는 것을 상단에 둔다(접힌 메뉴 아님).
 *   ① 승인/보류 토글 — 되돌릴 수 있다. 보류는 확인 도장만 뗀다.
 *   ② 분류 토글 — 고를 수 있는 모든 분류를 한 줄에. 고르면 필요한 입력이 아래에 열린다.
 * 토글·검색 목록의 모양은 CK 판독 검수의 ck-review-winner-toggle / ck-champion-suggestions 를 쓴다.
 */
const CLASS_OPTIONS = [
  { key: "unresolved", label: "미해결", hint: "더 봐야 한다 — 남은 질문을 남긴다" },
  { key: "casual", label: "단순 친선", hint: "행사가 아니라고 판단했다" },
  { key: "ck", label: EVENT_KIND_LABEL.ck, hint: "승패·보상이 걸린 스트리머 매치" },
  { key: "tournament", label: EVENT_KIND_LABEL.tournament, hint: "공식 대회" },
  { key: "showmatch", label: EVENT_KIND_LABEL.showmatch, hint: "보여주기용 기획 경기" },
  { key: "scrim", label: EVENT_KIND_LABEL.scrim, hint: "대회 준비 연습게임" },
  { key: "other", label: EVENT_KIND_LABEL.other, hint: "위 어디에도 안 맞는 행사" },
] as const;

/**
 * 분류·승인 컨트롤이 읽는 최소 모양. 맥락 검수 단위(FcoReviewUnit)도, 화면 경기 작업대도 이 모양을 채워 같은 컨트롤을 쓴다.
 * provider_match_id 자리에는 내부 match_id(fcs:…)도 들어간다 — 저장 함수가 둘 다 받는다(context.ts).
 */
export interface ReviewControlsUnit {
  kind: FcoReviewUnit["kind"];
  status: FcoReviewUnit["status"];
  confirmed: boolean;
  event: { id: string; kind: string; name: string; organizer: string | null; source_url: string | null } | null;
  judgment: { judgment: string; note: string; created_by: string } | null;
  matches: { provider_match_id: string; context_version: number; participants: { name: string }[] }[];
}

export function FcoReviewControls({
  unit, eventOptions, activeMatch, targets,
}: {
  /** 여러 경기에 한 번에 적용할 때(대전 전체) — 주면 이 경기들 전부에 같은 분류를 저장한다 */
  targets?: string[];
  unit: ReviewControlsUnit;
  eventOptions: FcoEventOption[];
  activeMatch: ReviewControlsUnit["matches"][number] | null;
  /** 대회 [경기] 탭 안에서 쓸 때 — 조사 결론·검수 토글은 [대회] 탭이 맡는다. */
}) {
  const router = useRouter(), params = useSearchParams();
  const ids = targets ?? [activeMatch?.provider_match_id ?? unit.matches[0]?.provider_match_id ?? ""];
  const { draft, base, setDraft, reset, dirty } = useReviewDraft(`fco-class:${ids.join("|")}`, { picked: "", query: "", creating: false, note: "", slug: "", name: "", organizer: "", source_url: "", versions: Object.fromEntries(unit.matches.map(m => [m.provider_match_id, m.context_version])) });
  const [classState, setClass, classPending] = useActionState(async (prev: ActionState, form: FormData) => { const result = await setClassAction(prev, form); if (result.ok) { reset(); if (result.nextHref) router.replace(adminHref(result.nextHref, { from: adminReturn(params.get("from"), "/admin/fco"), match: ids[0] })); } return result; }, IDLE);
  const { picked, query, creating } = draft;
  const setPicked = (picked: string | null) => setDraft(old => ({ ...old, picked: picked ?? "" }));
  const setQuery = (query: string) => setDraft(old => ({ ...old, query }));
  const setCreating = (next: boolean | ((v: boolean) => boolean)) => setDraft(old => ({ ...old, creating: typeof next === "function" ? next(old.creating) : next }));
  const field = (key: "note" | "slug" | "name" | "organizer" | "source_url") => ({ value: draft[key], onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(old => ({ ...old, [key]: e.target.value })) });
  const current = unit.status === "event" ? (unit.event?.kind ?? null) : unit.judgment?.judgment ?? null;

  const isEventClass = !!picked && picked !== "unresolved" && picked !== "casual";
  const matches = eventOptions.filter((o) => {
    const q = query.trim().toLowerCase();
    return !q || o.name.toLowerCase().includes(q) || (o.slug ?? "").toLowerCase().includes(q);
  });
  // 행사 계열은 경기 하나씩 붙는다 — 어느 세트에 붙일지는 좌측 큐 선택을 따른다.
  const targetMatch = activeMatch ?? unit.matches[0] ?? null;

  return (
    <section className="grid gap-3">
      {dirty && <p className="text-xs text-amber-400">분류 초안 보관 중 <button type="button" onClick={() => reset()} className="ml-2 text-ink-400">초안 버리기</button></p>}
      <div className="grid gap-1">
        <h4 className="text-[11px] font-semibold text-ink-400">
          분류 {targetMatch && unit.kind === "event" && <span className="text-ink-600">— {targetMatch.participants.map((p) => p.name).join(" vs ")} 경기에 적용</span>}
        </h4>
        <div className="ck-review-winner-toggle" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}>
          {CLASS_OPTIONS.map((option) => (
            <button key={option.key} type="button" title={option.hint}
              aria-pressed={picked ? picked === option.key : current === option.key}
              onClick={() => { setPicked(picked === option.key ? null : option.key); setCreating(false); }}>
              {option.label}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-ink-500">
          {picked
            ? CLASS_OPTIONS.find((o) => o.key === picked)?.hint
            : current
              ? "지금 분류를 바꾸려면 위에서 고른다."
              : "아직 분류가 없다 (미조사)."}
        </p>
      </div>

      {/* 미해결·단순 친선 — 근거 메모는 선택(비우면 「검수자 판단(메모 없음)」으로 남는다). */}
      {(picked === "unresolved" || picked === "casual") && (
        <form action={setClass} className="grid gap-2 rounded-lg border border-ink-800 bg-ink-900/40 p-3">
          {(targets ?? [targetMatch?.provider_match_id ?? ""]).map((id) => <input key={id} type="hidden" name="provider_match_id" value={id} />)}
          <input type="hidden" name="context_versions" value={JSON.stringify(base.versions)} />
          <input type="hidden" name="target" value={picked} />
          <label className="block text-[11px] text-ink-400">
            {picked === "unresolved" ? "남은 질문 (선택)" : "그렇게 본 근거 (선택)"}
            <textarea name="note" {...field("note")} rows={2}
              className="mt-1 w-full rounded border border-ink-700 bg-ink-900 px-2 py-1.5 text-sm text-ink-200"
              placeholder={picked === "unresolved" ? "예: 상대 채널 VOD 미확인 — 다른 POV 필요" : "예: 본인 방송에서 '오늘은 몸풀기' 발언 확인"} />
          </label>
          <div className="flex items-center gap-3">
            <button type="submit" disabled={classPending}
              className="rounded-md border border-accent-600/40 bg-accent-600/10 px-3 py-1.5 text-xs text-accent-400 hover:bg-accent-600/20">
              {CLASS_OPTIONS.find((o) => o.key === picked)?.label} 저장
            </button>
            <Result state={classState} />
          </div>
        </form>
      )}

      {/* CK·대회 계열 — 기존 행사를 검색해 고르거나 새로 만든다. */}
      {isEventClass && (
        <div className="grid gap-2 rounded-lg border border-ink-800 bg-ink-900/40 p-3">
          <input value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="행사 검색 — 이름이나 slug"
            className="w-full rounded border border-ink-700 bg-ink-900 px-2 py-1.5 text-sm text-ink-200" />
          {matches.length > 0 && (
            <div className="ck-champion-suggestions">
              {matches.slice(0, 8).map((option) => (
                <form key={option.id} action={setClass}>
                  {(targets ?? [targetMatch?.provider_match_id ?? ""]).map((id) => <input key={id} type="hidden" name="provider_match_id" value={id} />)}
                  <input type="hidden" name="context_versions" value={JSON.stringify(base.versions)} />
          <input type="hidden" name="target" value={picked!} />
                  <input type="hidden" name="existing_event_id" value={option.id} />
                  <button type="submit" disabled={classPending}
                    data-selected={unit.event?.id === option.id ? "" : undefined}
                    style={{ gridTemplateColumns: "minmax(0,1fr) auto", width: "100%" }}>
                    <span className="truncate">{option.name}</span>
                    <small>{EVENT_KIND_LABEL[option.kind] ?? option.kind} · {option.games}경기</small>
                  </button>
                </form>
              ))}
            </div>
          )}
          {matches.length === 0 && query && <p className="text-[11px] text-ink-500">검색 결과가 없다 — 아래에서 새로 만든다.</p>}

          <button type="button" onClick={() => setCreating((v) => !v)}
            className="justify-self-start text-[11px] text-ink-400 hover:text-ink-200">
            {creating ? "− 기존 행사에서 고르기" : "+ 새 행사 만들기"}
          </button>

          {creating && (
            <form action={setClass} className="grid gap-2">
              {(targets ?? [targetMatch?.provider_match_id ?? ""]).map((id) => <input key={id} type="hidden" name="provider_match_id" value={id} />)}
              <input type="hidden" name="context_versions" value={JSON.stringify(base.versions)} />
          <input type="hidden" name="target" value={picked!} />
              <div className="grid grid-cols-2 gap-2">
                <label className="block text-[11px] text-ink-400">행사 주소 ID (날짜 포함)
                  <input name="slug" {...field("slug")} required placeholder="fc-sisik-cup-2026-09-20"
                    className="mt-1 w-full rounded border border-ink-700 bg-ink-900 px-2 py-1.5 text-sm text-ink-200" /></label>
                <label className="block text-[11px] text-ink-400">주최 (선택)
                  <input name="organizer" {...field("organizer")} placeholder="고세구"
                    className="mt-1 w-full rounded border border-ink-700 bg-ink-900 px-2 py-1.5 text-sm text-ink-200" /></label>
              </div>
              <label className="block text-[11px] text-ink-400">행사 이름
                <input name="name" {...field("name")} required placeholder="고세구 피온시식컵"
                  className="mt-1 w-full rounded border border-ink-700 bg-ink-900 px-2 py-1.5 text-sm text-ink-200" /></label>
              <label className="block text-[11px] text-ink-400">확인 근거 URL (필수)
                <input name="source_url" {...field("source_url")} required placeholder="https://…"
                  className="mt-1 w-full rounded border border-ink-700 bg-ink-900 px-2 py-1.5 text-sm text-ink-200" /></label>
              <button type="submit" disabled={classPending}
                className="justify-self-start rounded-md border border-accent-600/40 bg-accent-600/10 px-3 py-1.5 text-xs text-accent-400 hover:bg-accent-600/20">
                새 행사로 연결
              </button>
            </form>
          )}
          <Result state={classState} />
        </div>
      )}
    </section>
  );
}

/** 대회 후보 경기의 상태 — 큐와 [경기] 탭이 같은 말을 쓴다. */
export function decisionBadge(m: FcoReviewUnit["matches"][number]): { text: string; cls: string } {
  if (m.decision === "include") return m.decision_by === "admin"
    ? { text: "포함 확정", cls: "text-accent-400" } : { text: "포함 (조사)", cls: "text-ink-300" };
  if (m.decision === "exclude") return m.decision_by === "admin"
    ? { text: "제외 확정", cls: "text-red-400" } : { text: "제외 (조사)", cls: "text-amber-400" };
  return { text: "미정", cls: "text-amber-400" };
}

const inputCls = "mt-1 w-full rounded border border-ink-700 bg-ink-900 px-2 py-1.5 text-sm text-ink-200";

/** [대회] 탭 — 행사 정보·후보 요약·일괄 승인. */
export function EventTab({ unit, children }: { unit: FcoReviewUnit; children?: React.ReactNode }) {
  const ev = unit.event!;
  const { draft, base, setDraft, reset, dirty } = useReviewDraft(`fco-event:${ev.id}`, { name: ev.name, kind: ev.kind, organizer: ev.organizer ?? "", source_url: ev.source_url ?? "", version: ev.admin_version });
  const [saved, save, saving] = useActionState(async (prev: ActionState, form: FormData) => {
    const result = await updateEventAction(prev, form); if (result.ok) reset(); return result;
  }, IDLE);
  const field = (key: "name" | "kind" | "organizer" | "source_url") => ({ value: draft[key], onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setDraft(old => ({ ...old, [key]: e.target.value })) });
  const [review, toggle, reviewing] = useActionState(reviewToggleAction, IDLE);
  const inc = unit.matches.filter((m) => m.decision === "include").length;
  const exc = unit.matches.filter((m) => m.decision === "exclude").length;
  const und = unit.matches.filter((m) => m.decision === null).length;
  const pendingAuto = unit.matches.filter((m) => m.decision && m.decision_by !== "admin").length;
  return (
    <div className="grid gap-4">
      <section className="grid gap-2">
        <h4 className="text-[11px] font-semibold text-ink-400">후보 {unit.matches.length}경기</h4>
        <p className="text-[13px] text-ink-200">
          <b className="text-accent-400">포함 {inc}</b><span className="mx-1.5 text-ink-600">·</span>
          <b className="text-red-400">제외 {exc}</b><span className="mx-1.5 text-ink-600">·</span>
          <b className="text-amber-400">미정 {und}</b>
        </p>
        <p className="text-[11px] text-ink-500">
          조사 제안은 이미 저장·공개돼 있다. 바꿀 경기만 [경기] 탭에서 바꾸고, 여기서 한 번에 확정한다.
        </p>
        <form action={toggle} className="ck-review-winner-toggle">
          <input type="hidden" name="event_id" value={ev.id} />
          <input type="hidden" name="context_versions" value={JSON.stringify(Object.fromEntries(unit.matches.filter(m => m.decision != null).map(m => [m.match_id, m.context_version])))} />
          <button type="submit" name="state" value="approve" disabled={reviewing || dirty} aria-pressed={unit.confirmed}
            title={`조사 제안 ${pendingAuto}건을 사람 결정으로 굳히고 포함 경기에 대회 판단을 확정한다`}>대회 판단 확정</button>
          <button type="submit" name="state" value="hold" disabled={reviewing || dirty} aria-pressed={!unit.confirmed}>확정 해제</button>
        </form>
        {!unit.confirmed && (
          <p className="text-[11px] text-ink-400">
            승인하면 <b className="text-ink-200">포함 {inc}건 · 제외 {exc}건</b>을 확정합니다
            {pendingAuto > 0 && ` (그중 조사 제안 ${pendingAuto}건)`}{und > 0 && ` · 미정 ${und}건은 그대로 남습니다`}.
          </p>
        )}
        <Result state={review} />
      </section>

      <form action={save} className="grid gap-2 border-t border-ink-800 pt-3">
        <h4 className="text-[11px] font-semibold text-ink-400">행사 정보</h4>
        <input type="hidden" name="event_id" value={ev.id} />
        <input type="hidden" name="context_version" value={base.version} />
        {dirty && <p className="text-xs text-amber-400">행사 정보 초안 보관 중 · 먼저 저장해 주세요.</p>}
        <label className="block text-[11px] text-ink-400">이름
          <input name="name" {...field("name")} className={inputCls} /></label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block text-[11px] text-ink-400">종류
            <select name="kind" {...field("kind")} className={inputCls}>
              {["ck", "tournament", "showmatch", "scrim", "other"].map((k) => <option key={k} value={k}>{EVENT_KIND_LABEL[k] ?? k}</option>)}
            </select></label>
          <label className="block text-[11px] text-ink-400">주최
            <input name="organizer" {...field("organizer")} className={inputCls} /></label>
        </div>
        <label className="block text-[11px] text-ink-400">확인 근거 URL
          <input name="source_url" {...field("source_url")} className={inputCls} /></label>
        <p className="text-[11px] text-ink-500">
          기간 {ev.starts_at ? kstShort(ev.starts_at) : "?"} ~ {ev.ends_at ? kstShort(ev.ends_at) : "?"} · slug {ev.slug}
        </p>
        <div className="flex items-center gap-3">
          <button type="submit" disabled={saving}
            className="rounded-md border border-accent-600/40 bg-accent-600/10 px-3 py-1.5 text-xs text-accent-400 hover:bg-accent-600/20">저장</button>
          <Result state={saved} />
        </div>
      </form>
      <AdminHistory scope="event" id={ev.id} />
      {children}
    </div>
  );
}

/**
 * 대회 포함/제외 결정 — 고른 경기 한 판을 이 대회에 넣을지·뺄지, 브래킷 번호·이름표. 저장하면 곧바로 공개에 반영된다.
 * matchRef 는 넥슨 번호 또는 내부 match_id(화면 기록 정본) — 저장 함수가 둘 다 받는다.
 */
export function EventDecision({ unit, match, matchRef }: { unit: FcoReviewUnit; match: Pick<FcoReviewUnit["matches"][number], "decision" | "decision_by" | "decision_note" | "bracket_no" | "bracket_label" | "context_version">; matchRef: string }) {
  const { draft, base, setDraft, reset, dirty } = useReviewDraft(`fco-decision:${unit.event!.id}:${matchRef}`, { decision: match.decision ?? "include", bracket_no: String(match.bracket_no ?? ""), bracket_label: match.bracket_label ?? "", note: match.decision_note ?? "", version: match.context_version });
  const [state, decide, deciding] = useActionState(async (prev: ActionState, form: FormData) => { const result = await decideMatchAction(prev, form); if (result.ok) reset(); return result; }, IDLE);
  const picked = draft.decision;
  const setPicked = (decision: "include" | "exclude") => setDraft(old => ({ ...old, decision }));
  const field = (key: "bracket_no" | "bracket_label" | "note") => ({ value: draft[key], onChange: (e: React.ChangeEvent<HTMLInputElement>) => setDraft(old => ({ ...old, [key]: e.target.value })) });
  const badge = decisionBadge(match as FcoReviewUnit["matches"][number]);
  return (
  <form action={decide} className="grid gap-2 rounded-lg border border-ink-800 bg-ink-900/40 p-3" key={matchRef}>
      <input type="hidden" name="event_id" value={unit.event!.id} />
      <input type="hidden" name="provider_match_id" value={matchRef} />
      <input type="hidden" name="context_version" value={base.version} />
      {dirty && <p className="text-xs text-amber-400">대회 판단 초안 보관 중</p>}
      <input type="hidden" name="decision" value={picked} />
      <h4 className="flex items-center justify-between text-[11px] font-semibold text-ink-400">
        <span>이 대회({unit.event!.name})에</span>
        <span className={badge.cls}>현재: {badge.text}</span>
      </h4>
      <div className="ck-review-winner-toggle">
        <button type="button" aria-pressed={picked === "include"} onClick={() => setPicked("include")}>포함</button>
        <button type="button" aria-pressed={picked === "exclude"} onClick={() => setPicked("exclude")}>제외</button>
      </div>
      <div className="grid grid-cols-[72px_1fr] gap-2">
        <label className="block text-[11px] text-ink-400">번호
          <input name="bracket_no" inputMode="numeric" {...field("bracket_no")} className={inputCls} /></label>
        <label className="block text-[11px] text-ink-400">브래킷 이름표
          <input name="bracket_label" {...field("bracket_label")} placeholder="1경기 / 13경기 · 7위 결정전" className={inputCls} /></label>
      </div>
      <label className="block text-[11px] text-ink-400">{picked === "exclude" ? "제외 이유 (필수)" : "메모"}
        <input name="note" {...field("note")} required={picked === "exclude"}
          placeholder={picked === "exclude" ? "예: 개막 전 연습 — 방송은 개막 타이틀 화면" : ""} className={inputCls} /></label>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={deciding}
          className="rounded-md border border-accent-600/40 bg-accent-600/10 px-3 py-1.5 text-xs text-accent-400 hover:bg-accent-600/20">
          저장 — 곧바로 공개에 반영
        </button>
        <Result state={state} />
      </div>
    </form>
  );
}
