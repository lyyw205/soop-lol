"use client";

/**
 * 경기 값 편집기 — 경기 정보(MatchInspector)·로스터(RosterInspector)·방송별 판독 차이(PovDiffBox).
 * ★ 경기 검수 화면(MatchReviewer)만 쓴다. 편집은 경기 화면 한 곳에서만 한다(2026-10-12) — VOD 화면은 찾기·연결 전용이다.
 * ★ 저장은 서버 액션이다. 원본 수정·조우 재파생·통계 재계산이 한 트랜잭션으로 돈다.
 */

import { useActionState, useEffect, useMemo, useRef, useState } from "react";

import { saveMatchMetaAction, saveRosterAction, setMatchVisibilityAction } from "@/app/admin/ck/actions";
import { IDLE } from "@/lib/action-state";
import { matchOriginLabel } from "@/lib/admin-labels";
import { metaFormValues, participantFormValues, type CkActionState } from "@/lib/ck-review-form";
import { rosterFocus, type RosterFocus } from "@/lib/ck-review-progress";
import { CHAMPIONS, championById } from "@soop-lol/core/lib/riot/champions";

import { AdminHistory } from "./AdminHistory";
import {
  compactKst, durationLabel, inputClass, matchSetLabel, POSITIONS,
  type PovDiffRowView, type ReviewEvent, type ReviewMatch, type ReviewStreamer,
} from "./ck-review-shared";
import { ActionMessage, SubmitButton } from "./Field";
import { useCkForm } from "./use-ck-form";
import { useReviewDraft } from "./use-review-draft";

function CkFeedback({ state, reload, pending }: { state: CkActionState; reload: () => void; pending: boolean }) {
  return <><ActionMessage state={state} />{!state.ok && state.latest && <button type="button" disabled={pending} onClick={reload} className="text-xs text-accent-400">최신 값 불러오기</button>}</>;
}

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

export function PovDiffBox({ diff, match, streamers }: {
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
    return (person && streamers.find((s) => s.id === person)?.display_name) ?? p?.observed_name ?? p?.riot_id ?? row.who.replace(/^n:/, "");
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

// ── 인스펙터: 경기 메타 ─────────────────────────────────────────────

export function MatchInspector({
  leadId,
  match,
  events, onBusy,
}: {
  leadId: string;
  match: ReviewMatch;
  /** 대회 이름·검색용(대회가 189개라 이 목록은 서버에서 한 번에 받는다). */
  events: ReviewEvent[];
  /** 저장 중·미저장 초안·칸을 편집 중이면 true — 검수 완료 버튼(위 줄)이 이 동안 잠긴다. */
  onBusy: (busy: boolean) => void;
}) {
  const { base, draft, setDraft, field, state, action, pending, reload, dirty, stale } = useCkForm(`lol-meta:${match.match_id}`, metaFormValues(match), saveMatchMetaAction);
  const hidden = match.visibility === "hidden";
  const formRef = useRef<HTMLFormElement>(null);
  const [activeField, setActiveField] = useState<MatchMetaField | null>(null);
  const selectedEvent = events.find((event) => event.id === draft.event_id) ?? null;
  useEffect(() => { onBusy(pending || dirty || activeField != null); }, [pending, dirty, activeField, onBusy]);

  const openField = (name: MatchMetaField) => {
    if (pending) return;
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
  // 시리즈 미지정 → 단판으로 확인. 경기 ID 와 같은 키의 시리즈에 best_of=1 과 근거를 적는다(set-label.ts).
  //   근거 없는 best_of 는 저장 단계가 거부한다(validateBestOf) — 모르면 미지정으로 둔다.
  const confirmSingle = (evidence: string) => {
    const form = formRef.current;
    if (!form || pending || !evidence.trim()) return;
    const values = { series_id: match.match_id, series_game_no: "1", best_of: "1", best_of_evidence: evidence.trim() };
    for (const [name, value] of Object.entries(values)) {
      const control = form.elements.namedItem(name);
      if (control instanceof HTMLInputElement) control.value = value;
    }
    setDraft((current) => ({ ...current, ...values }));
    setActiveField(null);
    form.requestSubmit();
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
      {hidden && (
        <p className="mb-3 rounded border border-lose/30 bg-lose/5 px-2 py-1.5 text-[11px] text-ink-400">
          <b className="text-lose">공개에서 빠진 경기입니다.</b> 지워지지 않았고 조우·챔피언 통계에서도
          빠져 있습니다. 되살리면 그대로 돌아옵니다.
        </p>
      )}

      <form ref={formRef} action={action} className="grid gap-2">
        {dirty && <div className="flex flex-wrap items-center gap-2 text-xs text-amber-300"><span>{stale ? "다른 변경이 있습니다. 저장 시 변경 전 값을 대조합니다." : "미저장 초안"}</span><SubmitButton>변경사항 저장</SubmitButton><button type="button" onClick={reload} className="text-ink-400">초안 버리고 최신 값</button></div>}
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
          <dl className="ck-review-match-summary ck-review-match-summary--row">
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
                : !draft.series_id ? <span className="grid gap-1">
                    <span className="text-amber-300" title="아직 시리즈로 묶지 않았다 — 단판인지 다전제의 한 판인지 모른다">시리즈 미지정</span>
                    {activeField === "confirm_single"
                      ? <input autoFocus aria-label="단판 근거" placeholder="단판 근거: 규정 URL 또는 VOD 시각" className={inputClass}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") { event.preventDefault(); confirmSingle(event.currentTarget.value); }
                            else if (event.key === "Escape") { event.preventDefault(); setActiveField(null); }
                          }} />
                      : <button type="button" className="text-left text-[11px] text-accent-400" onClick={() => openField("confirm_single")}>단판으로 확인</button>}
                  </span>
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
              <dt>길이</dt>
              <dd>{activeField === "game_duration"
                ? <input autoFocus name="game_duration" inputMode="numeric" aria-label="경기 길이 초" {...field("game_duration")}
                    onKeyDown={fieldKeys("game_duration")} className={inputClass} />
                : <button type="button" className="ck-review-match-cell-button" onClick={() => openField("game_duration")}>
                    {durationLabel(draft.game_duration ? Number(draft.game_duration) : null)}
                  </button>}</dd>
            </div>
          </dl>
          {/* 드물게 만지는 칸 — 접어 둔다. 접어도 같은 폼 안이라 저장·편집 흐름은 그대로다. */}
          <details className="ck-review-more">
            <summary>경기 정보 더 보기 · 대회·시각·세트 순서·시리즈 키·다전제</summary>
            <dl className="ck-review-match-summary">
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
            <div className="has-left-border">
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
          </details>
        </fieldset>
        <div><CkFeedback state={state} reload={reload} pending={pending} /></div>
      </form>
    </div>
  );
}

/** 경기 정보 아래쪽의 드문 동작 — 변경 이력·공개에서 빼기. 로스터 아래에 둔다. */
export function MatchFooter({ leadId, match }: { leadId: string; match: ReviewMatch }) {
  const hidden = match.visibility === "hidden";
  return (
    <footer className="ck-review-match-footer">
        <span>{matchOriginLabel(match)}</span>
        <AdminHistory key={match.match_id} scope="match" id={match.match_id} />
        <form action={setMatchVisibilityAction}>
          <input type="hidden" name="lead_id" value={leadId} />
          <input type="hidden" name="match_id" value={match.match_id} />
          <input type="hidden" name="visibility" value={hidden ? "public" : "hidden"} />
          <button className={hidden ? "text-win" : "text-lose"} title={hidden ? "공개로 되돌린다" : "무효판·중복판·시청 구간이면 공개에서 뺀다"}>
            {hidden ? "되살리기" : "공개에서 빼기"}
          </button>
        </form>
    </footer>
  );
}

type MatchMetaField = "winning_team" | "event_id" | "series_id" | "series_game_no" | "best_of" | "game_creation" | "game_duration"
  | "game_creation_precision" | "set_order_known" | "confirm_single";

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

export function RosterInspector({
  leadId,
  match,
  streamers,
  focus, onDirty,
}: {
  leadId: string;
  match: ReviewMatch;
  streamers: ReviewStreamer[];
  focus?: RosterFocus; onDirty: (id: string | null) => void;
}) {
  const bySlug = useMemo(() => new Map(streamers.map((s) => [s.id, s.slug])), [streamers]);
  const signature = JSON.stringify(match.participants);
  const makeRows = () => rosterRows(match, bySlug);
  const { draft: rows, setDraft: setRows, reset, dirty, stale } = useReviewDraft(`lol-roster:${match.match_id}`, makeRows());
  useEffect(() => { onDirty(dirty ? match.match_id : null); }, [dirty, match.match_id, onDirty]);
  const [activeCell, setActiveCell] = useState<string | null>(null);
  const [state, action, pending] = useActionState(async (prev: CkActionState, form: FormData) => {
    const result = await saveRosterAction(prev, form);
    if (result.ok && result.savedRoster) { reset(rosterRows({ participants: result.savedRoster }, bySlug)); setActiveCell(null); }
    return result;
  }, IDLE);

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
        <p className="mt-1 text-[10px] leading-relaxed text-ink-500">칸을 눌러 수정 · 빈 행은 누락 선수 추가(이름을 적은 행만 저장)</p>
      </header>

      <form action={action} className="grid gap-3">
        <input type="hidden" name="lead_id" value={leadId} />
        <input type="hidden" name="match_id" value={match.match_id} />
        <input type="hidden" name="roster" value={JSON.stringify(rows)} />
        {/* ★ 저장 중엔 입력을 잠근다(메타 폼과 같은 방식). contents 라 레이아웃은 그대로다. */}
        <fieldset disabled={pending} className="contents">
          {[100, 200].map((team) => (
            <RosterTeam key={team} team={team} rows={rows.filter((row) => row.team_id === String(team))}
              winner={match.winning_team === team} activeCell={activeCell} onOpen={setActiveCell} onChange={update} streamers={streamers} />
          ))}
        </fieldset>
        <div className="sticky bottom-0 -mx-1 flex items-center gap-3 border-t border-ink-800 bg-ink-900/95 px-1 pt-3">
          <SubmitButton>변경사항 저장</SubmitButton>
          {dirty && <><span className="text-xs text-amber-300">{stale ? "최신 값과 다른 초안" : "미저장 초안"}</span><button type="button" onClick={() => reset()} className="text-xs text-ink-400">초안 버리기</button></>}
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
  riot_id?: string | null;
  remove: boolean;
};

function rosterRows(match: Pick<ReviewMatch, "participants">, bySlug: Map<string, string>): RosterDraftRow[] {
  const taken = new Set(match.participants.map((participant) => participant.participant_id));
  const spareIds = Array.from({ length: 10 }, (_, index) => index + 1).filter((id) => !taken.has(id));
  let spare = 0;
  return [100, 200].flatMap((team) => {
    // 탑·정글·미드·원딜·서폿 고정 순서로 보여준다. participant_id 는 입력 순서일 뿐 포지션과 무관하다.
    // 미확정 포지션은 뒤로 밀고, 같은 순서끼리는 participant_id 로 안정적으로 묶는다.
    const positionRank = (position: string) => { const i = POSITIONS.indexOf(position); return i > 0 ? i : POSITIONS.length; };
    const existing = match.participants.filter((participant) => participant.team_id === team)
      .sort((a, b) => positionRank(a.team_position ?? "") - positionRank(b.team_position ?? "") || a.participant_id - b.participant_id)
      .map((participant) => {
        const base = participantFormValues(participant, participant.streamer_id ? bySlug.get(participant.streamer_id) ?? "" : "");
        // ★ DB엔 영문 정본(champion_name = resolveChampion 이 저장한 en 값)이 들어 있다.
        //   그대로 보여주면 편집창이 매번 영어로 뜬다 — 화면에서 읽는 값은 한글이니
        //   champion_id 로 한글 이름을 되찾아 보여준다. 못 찾으면(0/미확인) 저장된 값 그대로.
        const championDisplayName = championById(participant.champion_id)?.name ?? base.champion_name;
        return { participant_id: participant.participant_id, base, account_streamer_id: participant.account_streamer_id, riot_id: participant.riot_id,
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
      if (!target?.closest(".ck-review-inspector")) return;
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
        className={empty ? "text-ink-600" : "text-ink-200"}>{row.remove ? "삭제 예정" : accountOwner?.display_name || known?.display_name || row.observed_name || row.streamer_slug || row.riot_id || (row.base ? "미확인" : "+ 누락 선수")}</button>
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
      {/* API 경기는 화면에서 읽은 이름이 없다. 누구인지 판단할 단서로 Riot ID 를 보여 준다(저장하지 않는다). */}
      {row.riot_id && <p className="text-[10px] text-ink-400">Riot 계정 <b className="text-ink-200 select-all">{row.riot_id}</b></p>}
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
