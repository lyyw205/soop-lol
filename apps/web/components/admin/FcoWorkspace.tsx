"use client";

import Link from "next/link";
import { useActionState, useEffect, useMemo, useState } from "react";

import type { FcoEventOption, FcoReviewUnit, FcoWorkspaceEvidence } from "@soop-lol/core/lib/games/fconline/context";
import { fcoSeriesScore, fcoSeriesStanding } from "@soop-lol/core/lib/games/fconline/series";

import { IDLE, type ActionState } from "@/lib/action-state";
import { decideMatchAction, reviewToggleAction, setClassAction, updateEventAction } from "@/app/admin/fco/actions";
import { FcoContextReviewer } from "@/components/admin/FcoContextReviewer";
import { EVENT_KIND_LABEL, FCO_STATUS_LABEL } from "@/lib/admin-labels";

/**
 * FC 맥락 검수 작업대 — **단위 하나** 안을 훑는다 (CK 작업대와 같은 2층 구조).
 *   ↑↓  검수 큐 = 이 단위의 경기들 (행사면 1경기·2경기…)
 *   ←→  이 단위의 전 프레임을 시간 순으로 — 경기 경계를 넘어 대회 흐름 그대로 이어진다
 * 레이아웃은 admin.css 의 ck-review-* 를 재사용한다 (CK 쪽 코드는 수정하지 않는다).
 */

const frameUrl = (path: string) => `/admin/ck/frame/${path.split("/").map(encodeURIComponent).join("/")}`;
const hms = (s: number | null) => {
  const v = s ?? 0;
  return `${Math.floor(v / 3600)}:${String(Math.floor((v % 3600) / 60)).padStart(2, "0")}:${String(v % 60).padStart(2, "0")}`;
};
/**
 * KST 짧은 시각. ⚠ `toLocaleString` 을 쓰지 않는다 — 서버(Node)와 브라우저의 로케일
 * 기본값이 달라 `오후 06:51` / `PM 06:51` 로 갈리고, 그대로 하이드레이션이 깨진다(실측).
 */
const kstShort = (iso: string) => {
  const d = new Date(new Date(iso).getTime() + 9 * 3600_000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
};

const STATUS_LABEL = FCO_STATUS_LABEL;
const OUTCOME = { win: ["승", "text-accent-400"], draw: ["무", "text-ink-400"], loss: ["패", "text-red-400"] } as const;

const evidenceId = (e: FcoWorkspaceEvidence) => `${e.provider_match_id}:${e.evidence_key}`;

function Result({ state }: { state: ActionState }) {
  if (!state.message) return null;
  return <p className={`text-xs ${state.ok ? "text-ink-400" : "text-red-400"}`}>{state.ok ? state.message : `✗ ${state.message}`}</p>;
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
  matches: { provider_match_id: string; participants: { name: string }[] }[];
}

export function FcoReviewControls({
  unit, eventOptions, activeMatch, compact = false,
}: {
  unit: ReviewControlsUnit;
  eventOptions: FcoEventOption[];
  activeMatch: ReviewControlsUnit["matches"][number] | null;
  /** 대회 [경기] 탭 안에서 쓸 때 — 조사 결론·검수 토글은 [대회] 탭이 맡는다. */
  compact?: boolean;
}) {
  const [reviewState, toggleReview, reviewPending] = useActionState(reviewToggleAction, IDLE);
  const [classState, setClass, classPending] = useActionState(setClassAction, IDLE);
  const current = unit.status === "event" ? (unit.event?.kind ?? null) : unit.judgment?.judgment ?? null;
  const [picked, setPicked] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);

  const isEventClass = picked != null && picked !== "unresolved" && picked !== "casual";
  const matches = eventOptions.filter((o) => {
    const q = query.trim().toLowerCase();
    return !q || o.name.toLowerCase().includes(q) || (o.slug ?? "").toLowerCase().includes(q);
  });
  // 행사 계열은 경기 하나씩 붙는다 — 어느 세트에 붙일지는 좌측 큐 선택을 따른다.
  const targetMatch = activeMatch ?? unit.matches[0] ?? null;

  return (
    <section className="grid gap-3">
      {/* 조사 결론 — 행사면 눌러서 바로 바꾼다(검색 드롭다운이 아래에 열린다). */}
      {compact ? null : unit.event ? (
        <div className="grid gap-1 text-[13px]">
          <button type="button" className="text-left text-ink-200 hover:text-accent-400"
            onClick={() => { setPicked(unit.event!.kind); setCreating(false); }}
            title="눌러서 행사를 검색해 바꿉니다">
            조사 결론: <b className="text-accent-400">{unit.event.name}</b>
            <span className="ml-1 text-ink-400">({unit.event.kind}{unit.event.organizer ? ` · 주최 ${unit.event.organizer}` : ""})</span>
            <span className="ml-1 text-[11px] text-ink-500">— 눌러서 변경</span>
          </button>
          {unit.event.source_url && (
            <a href={unit.event.source_url} target="_blank" rel="noreferrer" className="text-[11px] text-ink-400 hover:text-ink-200">
              행사 확인 근거 ↗
            </a>
          )}
        </div>
      ) : unit.judgment ? (
        <div className="grid gap-1 text-[13px]">
          <p className="text-ink-200">
            조사 결론: <b className={unit.judgment.judgment === "casual" ? "text-ink-300" : "text-amber-400"}>
              {unit.judgment.judgment === "casual" ? "단순 친선" : "미해결"}
            </b>
            <span className="ml-1 text-[11px] text-ink-500">({unit.judgment.created_by})</span>
          </p>
          <p className="text-ink-300">{unit.judgment.note}</p>
        </div>
      ) : null}

      {!compact && <div className="grid gap-1">
        <h4 className="text-[11px] font-semibold text-ink-400">
          검수 {unit.kind === "event" && `· 이 행사 ${unit.matches.length}경기 전체`}
        </h4>
        <form action={toggleReview} className="ck-review-winner-toggle">
          {unit.kind === "event"
            ? <input type="hidden" name="event_id" value={unit.event!.id} />
            : <input type="hidden" name="provider_match_id" value={unit.matches[0]?.provider_match_id ?? ""} />}
          <button type="submit" name="state" value="approve" disabled={reviewPending}
            aria-pressed={unit.confirmed}>승인</button>
          <button type="submit" name="state" value="hold" disabled={reviewPending}
            aria-pressed={!unit.confirmed}>보류</button>
        </form>
        <Result state={reviewState} />
        {unit.status === "uninvestigated" && (
          <p className="text-[11px] text-ink-500">조사 전이라 승인해도 근거가 없다 — 분류를 직접 정하거나 조사를 먼저 돌린다.</p>
        )}
      </div>}

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

      {/* 미해결·단순 친선 — 근거 한 줄과 함께 저장한다. 빈 도장은 저장이 거부한다. */}
      {(picked === "unresolved" || picked === "casual") && (
        <form action={setClass} className="grid gap-2 rounded-lg border border-ink-800 bg-ink-900/40 p-3">
          <input type="hidden" name="provider_match_id" value={targetMatch?.provider_match_id ?? ""} />
          <input type="hidden" name="target" value={picked} />
          <label className="block text-[11px] text-ink-400">
            {picked === "unresolved" ? "남은 질문 (필수)" : "그렇게 본 근거 (필수)"}
            <textarea name="note" rows={2} required
              className="mt-1 w-full rounded border border-ink-700 bg-ink-900 px-2 py-1.5 text-sm text-ink-200"
              placeholder={picked === "unresolved" ? "예: 상대 채널 VOD 미확인 — 다른 POV 필요" : "예: 본인 방송에서 '오늘은 몸풀기' 발언 확인"} />
          </label>
          <div className="flex items-center gap-3">
            <button type="submit" disabled={classPending}
              className="rounded-md border border-accent-600/40 bg-accent-600/10 px-3 py-1.5 text-xs text-accent-400 hover:bg-accent-600/20">
              {CLASS_OPTIONS.find((o) => o.key === picked)?.label}로 저장
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
                  <input type="hidden" name="provider_match_id" value={targetMatch?.provider_match_id ?? ""} />
                  <input type="hidden" name="target" value={picked!} />
                  <input type="hidden" name="existing_event_id" value={option.id} />
                  <button type="submit" disabled={classPending}
                    data-selected={unit.event?.id === option.id ? "" : undefined}
                    style={{ gridTemplateColumns: "minmax(0,1fr) auto", width: "100%" }}>
                    <span className="truncate">{option.name}</span>
                    <small>{option.kind} · {option.games}경기</small>
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
              <input type="hidden" name="provider_match_id" value={targetMatch?.provider_match_id ?? ""} />
              <input type="hidden" name="target" value={picked!} />
              <div className="grid grid-cols-2 gap-2">
                <label className="block text-[11px] text-ink-400">slug (날짜 포함)
                  <input name="slug" required placeholder="fc-sisik-cup-2026-09-20"
                    className="mt-1 w-full rounded border border-ink-700 bg-ink-900 px-2 py-1.5 text-sm text-ink-200" /></label>
                <label className="block text-[11px] text-ink-400">주최 (선택)
                  <input name="organizer" placeholder="고세구"
                    className="mt-1 w-full rounded border border-ink-700 bg-ink-900 px-2 py-1.5 text-sm text-ink-200" /></label>
              </div>
              <label className="block text-[11px] text-ink-400">행사 이름 (날짜 금지 — slug 가 담당)
                <input name="name" required placeholder="고세구 피온시식컵"
                  className="mt-1 w-full rounded border border-ink-700 bg-ink-900 px-2 py-1.5 text-sm text-ink-200" /></label>
              <label className="block text-[11px] text-ink-400">확인 근거 URL (필수)
                <input name="source_url" required placeholder="https://…"
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

const COMMON = "__common";

/**
 * 프레임을 경기에 묶는다. 경기 시간대 = [시작 3분 전, 종료 2분 후].
 *   시작 = 넥슨 matchId 앞 8자리(유닉스 초, 실측), 종료 = matchDate(실측: 종료 시각).
 * 저장된 연결이 그 시간대 안이면 그대로, 아니면 시간이 맞는 경기로, 어느 경기에도 안 들면
 * 「대회 공통」(오프닝·소개·명단·브래킷·순위·마무리)이다.
 * VOD 시작 시각을 모르면 시간을 못 세우므로 저장된 연결을 그대로 쓴다.
 */
/** 근거 프레임의 장면(0036). 결과 화면이 먼저 뜬다 — 검수자가 스코어부터 대조한다. */
const ROLE_LABEL: Record<string, string> = {
  pre: "경기 전", start: "시작", end: "종료", post: "종료 후", result: "결과",
};

function groupFrames(unit: FcoReviewUnit, frames: FcoWorkspaceEvidence[], vodStarts: Record<number, number>) {
  const windows = unit.matches.map((m) => ({
    pid: m.provider_match_id,
    a: parseInt(m.provider_match_id.slice(0, 8), 16) * 1000 - 180_000,
    b: Date.parse(m.played_at) + 120_000,
  }));
  const groups = new Map<string, FcoWorkspaceEvidence[]>();
  for (const f of frames) {
    const start = f.vod_title_no != null ? vodStarts[f.vod_title_no] : undefined;
    let gid = f.provider_match_id;
    if (start != null && f.at_sec != null) {
      const t = start + f.at_sec * 1000;
      const own = windows.find((w) => w.pid === f.provider_match_id);
      if (!(own && t >= own.a && t <= own.b)) gid = windows.find((w) => t >= w.a && t <= w.b)?.pid ?? COMMON;
    }
    if (!groups.has(gid)) groups.set(gid, []);
    groups.get(gid)!.push(f);
  }
  return groups;
}

/** 대회 후보 경기의 상태 — 큐와 [경기] 탭이 같은 말을 쓴다. */
function decisionBadge(m: FcoReviewUnit["matches"][number]): { text: string; cls: string } {
  if (m.decision === "include") return m.decision_by === "admin"
    ? { text: "포함 확정", cls: "text-accent-400" } : { text: "포함 (조사)", cls: "text-ink-300" };
  if (m.decision === "exclude") return m.decision_by === "admin"
    ? { text: "제외 확정", cls: "text-red-400" } : { text: "제외 (조사)", cls: "text-amber-400" };
  return { text: "미정", cls: "text-amber-400" };
}

const inputCls = "mt-1 w-full rounded border border-ink-700 bg-ink-900 px-2 py-1.5 text-sm text-ink-200";

/** [대회] 탭 — 행사 정보·후보 요약·일괄 승인. */
function EventTab({ unit, children }: { unit: FcoReviewUnit; children?: React.ReactNode }) {
  const [saved, save, saving] = useActionState(updateEventAction, IDLE);
  const [review, toggle, reviewing] = useActionState(reviewToggleAction, IDLE);
  const ev = unit.event!;
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
          <button type="submit" name="state" value="approve" disabled={reviewing} aria-pressed={unit.confirmed}
            title={`조사 제안 ${pendingAuto}건을 사람 결정으로 굳히고 포함 경기에 확인 도장을 찍는다`}>승인</button>
          <button type="submit" name="state" value="hold" disabled={reviewing} aria-pressed={!unit.confirmed}>보류</button>
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
        <label className="block text-[11px] text-ink-400">이름
          <input name="name" defaultValue={ev.name} className={inputCls} /></label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block text-[11px] text-ink-400">종류
            <select name="kind" defaultValue={ev.kind} className={inputCls}>
              {["ck", "tournament", "showmatch", "scrim", "other"].map((k) => <option key={k} value={k}>{k}</option>)}
            </select></label>
          <label className="block text-[11px] text-ink-400">주최
            <input name="organizer" defaultValue={ev.organizer ?? ""} className={inputCls} /></label>
        </div>
        <label className="block text-[11px] text-ink-400">확인 근거 URL
          <input name="source_url" defaultValue={ev.source_url ?? ""} className={inputCls} /></label>
        <p className="text-[11px] text-ink-500">
          기간 {ev.starts_at ? kstShort(ev.starts_at) : "?"} ~ {ev.ends_at ? kstShort(ev.ends_at) : "?"} · slug {ev.slug}
        </p>
        <div className="flex items-center gap-3">
          <button type="submit" disabled={saving}
            className="rounded-md border border-accent-600/40 bg-accent-600/10 px-3 py-1.5 text-xs text-accent-400 hover:bg-accent-600/20">저장</button>
          <Result state={saved} />
        </div>
      </form>
      {children}
    </div>
  );
}

/** [경기] 탭 — 고른 경기 한 판. CK 의 MatchInspector 자리. */
function MatchTab({ unit, match, eventOptions, evidences }: {
  unit: FcoReviewUnit; match: FcoReviewUnit["matches"][number];
  eventOptions: FcoEventOption[]; evidences: FcoWorkspaceEvidence[];
}) {
  const [state, decide, deciding] = useActionState(decideMatchAction, IDLE);
  const [picked, setPicked] = useState<"include" | "exclude">(match.decision ?? "include");
  const badge = decisionBadge(match);
  return (
    <div className="grid gap-4">
      <section className="grid gap-1 text-[13px]">
        <p className="text-ink-200">{match.participants.map((p) => p.name).join(" vs ")}</p>
        <p className="text-[11px] text-ink-400">{kstShort(match.played_at)} 종료 · 모드 {match.mode_key} · {match.provider_match_id}</p>
      </section>

      {unit.kind === "event" && (
        <form action={decide} className="grid gap-2 rounded-lg border border-ink-800 bg-ink-900/40 p-3" key={match.provider_match_id}>
          <input type="hidden" name="event_id" value={unit.event!.id} />
          <input type="hidden" name="provider_match_id" value={match.provider_match_id} />
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
              <input name="bracket_no" inputMode="numeric" defaultValue={match.bracket_no ?? ""} className={inputCls} /></label>
            <label className="block text-[11px] text-ink-400">브래킷 이름표
              <input name="bracket_label" defaultValue={match.bracket_label ?? ""} placeholder="1경기 / 13경기 · 7위 결정전" className={inputCls} /></label>
          </div>
          <label className="block text-[11px] text-ink-400">{picked === "exclude" ? "제외 이유 (필수)" : "메모"}
            <input name="note" defaultValue={match.decision_note ?? ""} required={picked === "exclude"}
              placeholder={picked === "exclude" ? "예: 개막 전 연습 — 방송은 개막 타이틀 화면" : ""} className={inputCls} /></label>
          <div className="flex items-center gap-3">
            <button type="submit" disabled={deciding}
              className="rounded-md border border-accent-600/40 bg-accent-600/10 px-3 py-1.5 text-xs text-accent-400 hover:bg-accent-600/20">
              저장 — 곧바로 공개에 반영
            </button>
            <Result state={state} />
          </div>
        </form>
      )}

      {unit.kind === "match" && <FcoReviewControls unit={unit} eventOptions={eventOptions} activeMatch={match} />}

      <section className="grid gap-1 text-[12px]">
        <h4 className="text-[11px] font-semibold text-ink-400">API 결과 (넥슨 정본 — 여기서 고치지 않는다)</h4>
        <p className="text-ink-200">
          {match.participants.map((p, j) => (
            <span key={j}>
              {j > 0 && <span className="mx-1 text-ink-600">vs</span>}
              {p.name} <b>{p.score ?? "?"}</b>{" "}
              <span className={OUTCOME[p.outcome as keyof typeof OUTCOME]?.[1] ?? "text-ink-400"}>
                {OUTCOME[p.outcome as keyof typeof OUTCOME]?.[0] ?? p.outcome}
              </span>
            </span>
          ))}
        </p>
      </section>

      <section className="grid gap-1.5">
        <h4 className="text-[11px] font-semibold text-ink-400">조사 기록 ({evidences.length})</h4>
        {match.decision_note && <p className="text-[12px] text-ink-300">결정 근거: {match.decision_note}</p>}
        {evidences.length === 0 && <p className="text-[12px] text-ink-500">이 경기에 걸린 근거가 없다.</p>}
        {evidences.map((e) => (
          <div key={evidenceId(e)} className="rounded-md border border-ink-800 bg-ink-900/40 px-2.5 py-1.5 text-[12px]">
            <span className="font-mono text-[10px] text-ink-500">{e.vod_title_no ? `${hms(e.at_sec)} ` : ""}{e.kind}</span>
            <p className="text-ink-200">{e.observed}</p>
            {e.why && <p className="text-ink-400">판단: {e.why}</p>}
          </div>
        ))}
      </section>

      {unit.kind === "event" && (
        <details className="border-t border-ink-800 pt-3">
          <summary className="cursor-pointer text-[11px] text-ink-500 hover:text-ink-300">다른 행사로 옮기기 · 행사 아님으로 바꾸기</summary>
          <div className="mt-3"><FcoReviewControls unit={unit} eventOptions={eventOptions} activeMatch={match} compact /></div>
        </details>
      )}
      <details className="border-t border-ink-800 pt-3">
        <summary className="cursor-pointer text-[11px] text-ink-500 hover:text-ink-300">근거 직접 추가</summary>
        <div className="mt-3"><FcoContextReviewer providerMatchId={match.provider_match_id} /></div>
      </details>
    </div>
  );
}

export function FcoWorkspace({ unit, eventOptions, vodStarts }: {
  unit: FcoReviewUnit; eventOptions: FcoEventOption[]; vodStarts: Record<number, number>;
}) {
  // 단위의 전 프레임 — VOD·초 순.
  const frames = useMemo(() => unit.evidences.filter((e) => e.frame_path), [unit]);
  const groups = useMemo(() => groupFrames(unit, frames, vodStarts), [unit, frames, vodStarts]);
  // 큐 행 — 대회 공통(있으면 맨 위) + 경기들.
  const rows = useMemo(
    () => [...(groups.get(COMMON)?.length ? [COMMON] : []), ...unit.matches.map((m) => m.provider_match_id)],
    [groups, unit.matches],
  );

  const [groupId, setGroupId] = useState(rows[0] ?? "");
  const groupFramesList = groups.get(groupId) ?? [];
  const [frameKey, setFrameKey] = useState<string | null>(null);
  const selected = groupFramesList.find((f) => evidenceId(f) === frameKey)
    ?? groupFramesList.find((f) => f.role === "result")
    ?? groupFramesList[0] ?? null;
  const activeMatchId = groupId === COMMON ? null : groupId;
  const activeMatch = unit.matches.find((m) => m.provider_match_id === activeMatchId) ?? null;
  const [zoom, setZoom] = useState(false);

  // 탭은 큐 선택을 따라간다 — 「대회 공통」이면 [대회], 경기면 [경기]. 직접 바꿀 수도 있다.
  const [tab, setTab] = useState<"event" | "match">(rows[0] === COMMON || !rows.length ? "event" : "match");
  const pickGroup = (id: string) => { setGroupId(id); setFrameKey(null); setTab(id === COMMON ? "event" : "match"); };

  // ↑↓ — 큐 이동. 큐는 이 키로만 움직인다 (CK 작업대와 같다).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable=true]")) return;
      if (rows.length < 2) return;
      event.preventDefault();
      const current = rows.indexOf(groupId);
      const next = event.key === "ArrowDown"
        ? Math.min(current < 0 ? 0 : current + 1, rows.length - 1)
        : Math.max(current < 0 ? rows.length - 1 : current - 1, 0);
      if (next === current) return;
      pickGroup(rows[next]);
      requestAnimationFrame(() => {
        document.getElementById(`fco-queue-${rows[next]}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [rows, groupId]);

  // ←→ — 고른 행(경기 또는 대회 공통) 안에서만 움직인다 (CK: 「좌·우는 지금 큐에서 고른 묶음 안에서만」).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable=true]")) return;
      if (groupFramesList.length < 2 || !selected) return;
      event.preventDefault();
      const index = groupFramesList.findIndex((f) => evidenceId(f) === evidenceId(selected));
      const next = event.key === "ArrowRight"
        ? Math.min(index + 1, groupFramesList.length - 1)
        : Math.max(index - 1, 0);
      if (next === index) return;
      setFrameKey(evidenceId(groupFramesList[next]));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [groupFramesList, selected]);

  // 이 단위 안의 다전제들 — 세트를 모아 집계한다. 규칙은 core 하나다.
  const seriesStandings = useMemo(() => {
    const bySeries = new Map<string, typeof unit.matches>();
    for (const m of unit.matches) {
      if (!m.series_id) continue;
      if (!bySeries.has(m.series_id)) bySeries.set(m.series_id, []);
      bySeries.get(m.series_id)!.push(m);
    }
    return [...bySeries].map(([id, sets]) => ({
      id,
      standing: fcoSeriesStanding(sets.map((m) => ({
        series_id: m.series_id, series_game_no: m.series_game_no, best_of: m.best_of,
        participants: m.participants.map((p) => ({
          ouid: p.ouid, nickname: p.name, outcome: p.outcome, side_no: 0,
        })),
      }))),
    }));
  }, [unit.matches]);

  const frameIndex = selected ? groupFramesList.findIndex((f) => evidenceId(f) === evidenceId(selected)) : -1;

  return (
    <div className="ck-review-workbench">
      {/* ── 좌: 검수 큐 = 이 단위의 경기들 ──────────────────────── */}
      <section className="ck-review-timeline" aria-label="이 단위의 경기">
        <header className="ck-review-queue-head">
          <div>
            <h3>{unit.kind === "event" ? "대회 경기" : "경기"}</h3>
            <p>{unit.matches.length}경기 · 프레임 {frames.length}장</p>
          </div>
        </header>
        <ul className="ck-review-queue-list content-start">
          {rows.includes(COMMON) && (
            <li id={`fco-queue-${COMMON}`}>
              <button type="button" className="ck-review-queue-item" data-kind="candidate"
                aria-current={groupId === COMMON ? "true" : undefined} onClick={() => pickGroup(COMMON)}
                title="어느 경기 시간대에도 안 드는 화면 — 오프닝·선수 소개·명단·브래킷·순위·마무리">
                <span className="grid min-w-0 gap-0.5">
                  <time>대회 공통</time>
                  <span className="truncate text-[10px] text-ink-500">경기 밖 화면 · 프레임 {groups.get(COMMON)?.length ?? 0}장</span>
                </span>
                <span />
              </button>
            </li>
          )}
          {unit.matches.map((m, i) => {
            const mine = groups.get(m.provider_match_id) ?? [];
            const hasResult = mine.some((f) => f.role === "result");
            const badge = decisionBadge(m);
            const firstExcluded = unit.kind === "event" && m.decision === "exclude"
              && unit.matches[i - 1]?.decision !== "exclude";
            return (
              <li key={m.provider_match_id} id={`fco-queue-${m.provider_match_id}`}
                className={m.decision === "exclude" ? "opacity-60" : undefined}>
                {firstExcluded && <p className="px-2.5 pb-1 pt-3 text-[10px] font-semibold text-ink-500">대회 밖으로 뺀 경기</p>}
                <button type="button" className="ck-review-queue-item" data-kind={mine.length ? "match" : "candidate"}
                  aria-current={m.provider_match_id === groupId ? "true" : undefined}
                  onClick={() => pickGroup(m.provider_match_id)}
                  title={m.participants.map((p) => `${p.name} ${p.score ?? "?"}`).join(" vs ")}>
                  <span className="grid min-w-0 gap-0.5">
                    <time>
                      {m.bracket_label ? `${m.bracket_label} · ` : m.series_id ? `${m.series_game_no ?? "?"}세트 · ` : ""}
                      {m.participants.map((p) => p.name).join(" vs ")}
                    </time>
                    <span className="truncate text-[10px] text-ink-500">
                      {kstShort(m.played_at)} · 프레임 {mine.length}장 ·{" "}
                      {hasResult
                        ? <span className="text-accent-400">결과창</span>
                        : <span className="text-amber-400">결과창 없음</span>}
                    </span>
                  </span>
                  {unit.kind === "event" ? (
                    <span className={`shrink-0 text-[10px] font-bold ${badge.cls}`} title={badge.text}>
                      {m.decision === "include" ? "포함" : m.decision === "exclude" ? "제외" : "미정"}
                      {m.decision_by === "admin" ? " ✓" : ""}
                    </span>
                  ) : (
                    <span className={`text-[10px] font-bold ${m.confirmed ? "text-accent-400" : "text-ink-600"}`}>
                      {m.confirmed ? "✓" : ""}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      {/* ── 중앙: 프레임 ────────────────────────────────────────── */}
      <div className="ck-review-stage">
        <section className="ck-review-preview">
          <header className="flex items-center justify-between gap-3 border-b border-ink-800 px-4 py-2">
            <div className="min-w-0 text-xs text-ink-400">
              {selected ? (
                <>
                  {selected.role && (
                    <span className={`mr-2 rounded px-1.5 py-0.5 text-[10px] font-bold ${selected.role === "result" ? "bg-accent-500/20 text-accent-300" : "bg-ink-800 text-ink-300"}`}>
                      {ROLE_LABEL[selected.role] ?? selected.role}
                    </span>
                  )}
                  <span className="font-mono text-accent-400">{hms(selected.at_sec)}</span>
                  <span className="mx-2 text-ink-600">·</span>
                  VOD {selected.vod_title_no}
                  <span className="mx-2 text-ink-600">·</span>
                  {frameIndex + 1}/{groupFramesList.length}
                  {activeMatch && (
                    <>
                      <span className="mx-2 text-ink-600">·</span>
                      {activeMatch.participants.map((p) => p.name).join(" vs ")}
                    </>
                  )}
                </>
              ) : "이 경기에는 프레임 근거가 없습니다."}
            </div>
            {selected?.frame_path && (
              <div className="flex shrink-0 gap-2 text-xs">
                <button onClick={() => setZoom((z) => !z)} className="rounded border border-ink-700 px-2 py-1 text-ink-400 hover:text-ink-200">
                  {zoom ? "맞추기" : "원본 크기"}
                </button>
                <a href={frameUrl(selected.frame_path)} target="_blank" rel="noreferrer"
                  className="rounded border border-ink-700 px-2 py-1 text-ink-400 hover:text-ink-200">새 탭 ↗</a>
              </div>
            )}
          </header>

          <div className={`ck-review-frame bg-ink-950 ${zoom ? "max-h-[70vh] overflow-auto" : ""}`}>
            {selected?.frame_path ? (
              // eslint-disable-next-line @next/next/no-img-element -- out/ 밖의 로컬 판독 프레임
              <img src={frameUrl(selected.frame_path)} alt={selected.observed}
                className={`ck-review-frame-image ${zoom ? "max-w-none" : "w-full"}`} />
            ) : (
              <p className="px-4 py-16 text-center text-sm text-ink-400">
                {unit.status === "uninvestigated"
                  ? "아직 조사가 없습니다 — fco-match-context 스킬이 프레임과 제안을 남기면 여기서 검수합니다."
                  : groupFramesList.length
                    ? "이 경기에는 프레임이 없습니다. ←→ 로 단위의 다른 프레임을 보거나 우측 정보로 판단하세요."
                    : "프레임 근거가 없는 단위입니다. 우측의 근거·연결 정보로 판단하세요."}
              </p>
            )}
          </div>

          <footer className="grid gap-2 border-t border-ink-800 px-4 py-2 text-xs text-ink-400">
            {groupFramesList.length > 1 && (
              <div className="ck-review-frame-strip" aria-label={`근거 프레임 ${groupFramesList.length}장`}>
                {groupFramesList.map((f) => (
                  <button key={evidenceId(f)} type="button"
                    aria-current={selected && evidenceId(f) === evidenceId(selected) ? "true" : undefined}
                    title={`${hms(f.at_sec)} — ${f.observed}`} onClick={() => setFrameKey(evidenceId(f))}>
                    {/* eslint-disable-next-line @next/next/no-img-element -- 로컬 검수 프레임 */}
                    <img src={frameUrl(f.frame_path!)} alt={`${hms(f.at_sec)} 프레임`} />
                    <span className={f.role === "result" ? "font-bold text-accent-300" : undefined}>
                      {f.role ? `${ROLE_LABEL[f.role] ?? f.role} ` : ""}{hms(f.at_sec)}
                    </span>
                  </button>
                ))}
              </div>
            )}
            {selected && (
              <div className="grid gap-1">
                <p className="text-[13px] text-ink-200">{selected.observed}</p>
                {selected.why && <p className="text-ink-400">판단: {selected.why}</p>}
                <span className="font-mono text-[10px] text-ink-600">{selected.frame_path}</span>
              </div>
            )}
          </footer>
        </section>
      </div>

      {/* ── 우: [대회] / [경기] 탭 — CK 인스펙터와 같은 틀 ─────────── */}
      <aside className="ck-review-inspector" aria-label="검수 정보">
        <div className="ck-review-inspector-shell">
          {unit.kind === "event" && (
            <div className="ck-review-inspector-tabs" role="tablist" aria-label="검수 정보">
              <button type="button" role="tab" aria-selected={tab === "event"} onClick={() => setTab("event")}>대회</button>
              <button type="button" role="tab" aria-selected={tab === "match"} disabled={!activeMatch}
                onClick={() => setTab("match")}>경기</button>
            </div>
          )}
          <header className="border-b border-ink-800 px-4 py-3">
            <Link href="/admin/fco" className="text-[11px] text-ink-500 hover:text-ink-300">← 검수 목록</Link>
            <p className="mt-1 text-sm font-semibold text-ink-200">{unit.title}</p>
            <p className="mt-0.5 text-[11px] text-ink-400">
              {STATUS_LABEL[unit.status]}
              {unit.event && ` (${unit.event.kind})`}
              {unit.confirmed ? " · 확인됨" : unit.pending ? " · 승인 대기" : ""}
            </p>
          </header>
          <div className="ck-review-inspector-body grid content-start gap-4 p-4 text-sm">
            {unit.kind === "event" && (tab === "event" || !activeMatch) ? (
              <EventTab unit={unit}>
                {seriesStandings.map(({ id, standing }) => (
                  <section key={id} className="grid gap-1 rounded-lg border border-ink-800 bg-ink-900/40 px-3 py-2">
                    <h4 className="text-[11px] font-semibold text-ink-400">
                      다전제 {standing.best_of ? `Bo${standing.best_of}` : "(형식 미확인)"} · {standing.sets}세트
                    </h4>
                    <p className="text-sm text-ink-200">
                      {standing.sides.map((side) => side.name).join(" vs ")}
                      <b className="ml-2 tabular-nums text-accent-400">{fcoSeriesScore(standing)}</b>
                    </p>
                  </section>
                ))}
              </EventTab>
            ) : activeMatch ? (
              <MatchTab key={activeMatch.provider_match_id} unit={unit} match={activeMatch} eventOptions={eventOptions}
                evidences={[
                  // 프레임은 중앙 필름스트립과 같은 시간 기준 — 대회 공통 화면이 경기 기록에 섞이지 않게.
                  ...(groups.get(activeMatch.provider_match_id) ?? []),
                  ...unit.evidences.filter((e) => e.provider_match_id === activeMatch.provider_match_id && !e.frame_path),
                ]} />
            ) : null}
          </div>
        </div>
      </aside>
    </div>
  );
}
