"use client";

/**
 * 경기 검수 화면 — **경기 하나**의 값을 모든 방송의 근거와 대조해 고친다.
 *
 *   ┌ 위 줄: ↑ n/N ↓ · 목록으로 │ 시리즈 칩 · 근거 방송 칩 │ [검수 완료 · 다음 →] ┐
 *   ├──────────────────────────────────────────┬────────────────────────────────┤
 *   │ 근거 사진(연결된 것만 · 참고는 펼쳐서)       │ 승자·세트·길이 → 로스터 10명     │
 *   └──────────────────────────────────────────┴────────────────────────────────┘
 *
 * ★ 기본 화면은 "결과 사진 한 장 + 표 하나 + 완료 버튼"이다(2026-10-12 정리). 시리즈 칸·방송별 근거·다른 칸 비교·
 *   참고 사진은 드물게 쓰므로 칩과 서랍 뒤에 두고, 문제가 있을 때만 칩이 눈에 띈다.
 * ★ 편집 대상은 이 화면의 경기 하나다. 방송 필터·사진 선택은 편집 대상을 바꾸지 않는다.
 * ★ 이전·다음·완료 후 이동은 들어온 목록(`from`) 하나와 그 순서다(서버가 요약해 보낸다). 규칙은 ck-match-review.ts.
 * ★ 미연결 사진 탐색·경기 만들기는 VOD 화면에서 한다(방송별 "VOD 화면" 링크).
 */

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { relinkFrameAction } from "@/app/admin/ck/actions";
import { adminHref } from "@/lib/admin-navigation";
import { rosterFocus } from "@/lib/ck-review-progress";

import { frameThumbUrl, frameUrl, hms, KIND_LABEL, vodAt, type PovDiffRowView, type ReviewEvent, type ReviewMatch, type ReviewStreamer } from "./ck-review-shared";
import { MatchFooter, MatchInspector, PovDiffBox, RosterInspector } from "./MatchEditors";
import { ReviewCompletion } from "./ReviewCompletion";
import { SeriesPanel } from "./SeriesPanel";
import type { MatchSeriesContext } from "@soop-lol/core/lib/db/match-series-review";
import { checkSeries } from "@soop-lol/core/lib/metrics/series-check";
import {
  representativeEvidence, visibleEvidence,
  type EvidenceFrame, type MatchEvidenceVod, type WorkNav,
} from "./ck-match-review";

/** 화면이 받는 방송 정보 — 사진·구간 계산용 경기 목록은 서버가 계산을 끝낸 뒤라 싣지 않는다(문서 크기). */
export interface MatchReviewVod {
  lead_id: string;
  source_key: string;
  title: string;
  url: string | null;
  streamer_name: string | null;
  pov: { role: "created" | "added"; source: "own" | "rebroadcast"; link_basis: string | null; compared: number; rows: PovDiffRowView[] } | null;
}

export function MatchReviewer({ match, evidence, series, compareHref, streamers, events, nav, from, initialFocus }: {
  match: ReviewMatch;
  /** 방송별 근거(서버가 matchEvidence 로 계산 — 연결 사진과 같은 구간 참고 사진만). */
  evidence: MatchEvidenceVod<MatchReviewVod>[];
  /** 시리즈 칸 — 이 경기의 시리즈 세트 전부, 또는 시리즈 미지정이면 묶을 후보. */
  series: MatchSeriesContext;
  /** 시리즈 비교 화면에서 이 시리즈만 연다. */
  compareHref: string | null;
  streamers: ReviewStreamer[];
  events: ReviewEvent[];
  /** 들어온 목록에서 이 경기의 자리와 앞뒤·다음 미완료(서버 계산). 목록이 아닌 곳에서 열었으면 null. */
  nav: WorkNav | null;
  /** 돌아갈 목록 주소. 앞뒤 경기로 넘어가도 그대로 들고 간다. */
  from: string;
  initialFocus?: string;
}) {
  const router = useRouter();
  const [filter, setFilter] = useState<string | null>(null);
  // 참고 사진(같은 구간의 미연결 사진)도 기본으로 보인다(2026-10-12 운영자 결정). "참고 사진 숨기기"로 접을 수 있다.
  const [showReference, setShowReference] = useState(true);
  const visible = useMemo(() => visibleEvidence(evidence, filter).filter((frame) => showReference || frame.linked), [evidence, filter, showReference]);
  const [frameId, setFrameId] = useState<string | null>(null);
  const selected = visible.find((frame) => frame.id === frameId) ?? representativeEvidence(visible);
  const selectedVod = selected ? evidence.find((item) => item.vod.lead_id === selected.lead_id)?.vod ?? null : null;
  const filteredVod = filter ? evidence.find((item) => item.vod.lead_id === filter) ?? null : null;
  const [zoom, setZoom] = useState(false);
  const [panel, setPanel] = useState<"series" | "vods" | null>(null);
  const [metaBusy, setMetaBusy] = useState(false);
  const [rosterDirtyId, setRosterDirtyId] = useState<string | null>(null);
  const onMetaBusy = useCallback((busy: boolean) => setMetaBusy(busy), []);

  const position = nav;
  const matchHref = (id: string) => adminHref(`/admin/ck/match/${encodeURIComponent(id)}`, { from, focus: initialFocus });
  const go = (id: string | null) => { if (id) router.push(matchHref(id)); };
  const onCompleted = () => router.push(nav?.nextUncompleted ? matchHref(nav.nextUncompleted) : from);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && panel) { setPanel(null); return; }
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable=true]") || target?.closest("dialog")) return;
      event.preventDefault();
      if (event.key === "ArrowUp") return go(position?.prev ?? null);
      if (event.key === "ArrowDown") return go(position?.next ?? null);
      const index = visible.findIndex((frame) => frame.id === selected?.id);
      if (index < 0) return;
      const next = visible[event.key === "ArrowRight" ? Math.min(index + 1, visible.length - 1) : Math.max(index - 1, 0)];
      setFrameId(next.id);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const totals = evidence.reduce((sum, item) => ({ linked: sum.linked + item.linked, reference: sum.reference + item.reference }), { linked: 0, reference: 0 });
  const vodLabel = (vod: MatchReviewVod) => vod.streamer_name ?? vod.title;
  const openMismatch = evidence.reduce((sum, item) => sum + (item.vod.pov?.rows.filter((row) => row.status === "mismatch_open").length ?? 0), 0);
  // 시리즈 칩 — 문제가 있을 때만 눈에 띈다(미지정·이상 신호).
  const seriesCheck = useMemo(() => series.series ? checkSeries(series.sets, series.series.best_of) : null, [series]);
  const seriesIndex = series.sets.findIndex((set) => set.match_id === match.match_id);
  const seriesScore = seriesCheck?.sets[seriesIndex]?.score;
  const seriesWarnings = seriesCheck?.warnings.length ?? 0;
  const seriesChip = !series.series ? "시리즈 미지정"
    : `시리즈 ${series.sets.filter((set) => set.set_role !== "bonus").length}세트${seriesScore ? ` · ${seriesScore.join(":")}` : ""}${seriesWarnings ? ` · ⚠ ${seriesWarnings}` : ""}`;
  const busy = metaBusy || rosterDirtyId != null;

  return (
    <div className="ck-review-workbench ck-review-workbench--match">
      <div className="ck-review-toolbar" role="toolbar" aria-label="검수 이동과 상태">
        <div className="ck-review-nav">
          {position && position.index >= 0 ? <>
            <button type="button" disabled={!position.prev} onClick={() => go(position.prev)}>↑ 이전</button>
            <span className="tabular-nums text-ink-200">{position.index + 1} / {position.total}</span>
            <button type="button" disabled={!position.next} onClick={() => go(position.next)}>다음 ↓</button>
          </> : <span className="text-[11px] text-ink-400">{nav ? "들어온 목록의 범위 밖" : "목록에서 열지 않아 앞뒤 경기 없음"}</span>}
        </div>
        <div className="ck-review-chips">
          <button type="button" aria-expanded={panel === "series"} data-attention={!series.series || seriesWarnings > 0 || undefined}
            onClick={() => setPanel(panel === "series" ? null : "series")}>{seriesChip}</button>
          <button type="button" aria-expanded={panel === "vods"} data-attention={openMismatch > 0 || totals.linked === 0 || undefined}
            onClick={() => setPanel(panel === "vods" ? null : "vods")}>
            근거 방송 {evidence.length}{totals.linked === 0 ? " · 연결 사진 없음" : ""}{openMismatch ? ` · 다른 칸 미해결 ${openMismatch}` : ""}
          </button>
        </div>
        <ReviewCompletion primary matchId={match.match_id} version={match.review_version} completed={!!match.review_completed_at}
          disabled={busy} onCompleted={onCompleted} />
      </div>

      {panel && <div className="ck-review-drawer" {...(panel === "vods" ? { role: "region", "aria-label": "방송별 근거" } : {})}>
        <button type="button" className="ck-review-drawer-close" onClick={() => setPanel(null)} aria-label="닫기">닫기 ✕</button>
        {panel === "series" ? <SeriesPanel context={series} matchId={match.match_id} from={from} compareHref={compareHref} /> : <>
          <h3 className="px-0.5 pb-2 text-[13px] font-bold text-ink-200">방송별 근거</h3>
          <ul className="ck-review-queue-list">
            <li>
              <button type="button" className="ck-review-queue-item" data-kind="vod" aria-current={filter == null ? "true" : undefined} onClick={() => setFilter(null)}>
                <time>전체</time>
                <span className="ck-review-queue-kind">연결 {totals.linked} · 참고 {totals.reference}</span>
              </button>
            </li>
            {evidence.map(({ vod, linked, reference }) => {
              const open = vod.pov?.rows.filter((row) => row.status === "mismatch_open").length ?? 0;
              return <li key={vod.lead_id}>
                <button type="button" className="ck-review-queue-item" data-kind="vod" aria-current={filter === vod.lead_id ? "true" : undefined}
                  onClick={() => setFilter(vod.lead_id)} title={vod.title}>
                  <time>{vodLabel(vod)}{vod.pov?.role === "created" ? " · 만듦" : ""}{vod.pov?.source === "rebroadcast" ? " · 재송출" : ""}</time>
                  <span className="ck-review-queue-kind">
                    {linked + reference === 0 ? "근거 사진 없음" : `연결 ${linked} · 참고 ${reference}`}
                    {vod.pov ? ` · 다른 칸 ${vod.pov.rows.length}${open ? `(미해결 ${open})` : ""}` : " · 판독 없음"}
                  </span>
                </button>
                <a href={adminHref(`/admin/ck/${vod.lead_id}`, { match: match.match_id, from })} className="block px-2 pb-1 text-[10px] text-ink-500 hover:text-ink-200">VOD 화면에서 찾기 →</a>
              </li>;
            })}
            {evidence.length === 0 && <li className="ck-review-queue-empty">이 경기에 근거가 붙은 방송이 없습니다.</li>}
          </ul>
          {filteredVod && <div className="mt-3">
            <p className="mb-1 text-[11px] text-ink-400">{vodLabel(filteredVod.vod)} 이(가) 읽은 값</p>
            <PovDiffBox diff={filteredVod.vod.pov ?? undefined} match={match} streamers={streamers} />
          </div>}
        </>}
      </div>}

      <div className="ck-review-stage">
        <section className="ck-review-preview">
          <header className="flex items-center justify-between gap-3 border-b border-ink-800 px-4 py-2">
            <div className="min-w-0 text-xs text-ink-400">
              {selected ? <>
                <span className="font-mono text-accent-400">{hms(selected.at_sec)}</span>
                <span className="mx-2 text-ink-600">·</span>{KIND_LABEL[selected.kind]}
                <span className="mx-2 text-ink-600">·</span>{selectedVod ? vodLabel(selectedVod) : ""}
                <span className={`ml-2 rounded px-1.5 py-0.5 text-[10px] ${selected.linked ? "bg-accent-600/20 text-accent-400" : "border border-dashed border-ink-600 text-ink-400"}`}>
                  {selected.linked ? "이 경기 근거" : "참고 · 미연결"}
                </span>
              </> : filteredVod ? "이 방송에는 이 경기 근거 사진이 없습니다." : "이 경기에 연결된 근거 사진이 없습니다."}
            </div>
            <div className="flex shrink-0 items-center gap-2 text-xs">
              {selectedVod?.url && <a href={vodAt(selectedVod.url, selected?.at_sec ?? null)} target="_blank" rel="noreferrer" className="text-accent-400">이 시점 VOD ↗</a>}
              {selected && <>
                <button onClick={() => setZoom((z) => !z)} className="rounded border border-ink-700 px-2 py-1 text-ink-400 hover:text-ink-200">{zoom ? "맞추기" : "원본 크기"}</button>
                <a href={frameUrl(selected.frame_path)} target="_blank" rel="noreferrer" className="rounded border border-ink-700 px-2 py-1 text-ink-400 hover:text-ink-200">새 탭 ↗</a>
              </>}
            </div>
          </header>

          <div data-zoom={zoom} className={`ck-review-frame bg-ink-950 ${zoom ? "max-h-[70vh] overflow-auto" : ""}`}>
            {selected ? (
              // eslint-disable-next-line @next/next/no-img-element -- out/ 밖의 로컬 파일이라 next/image 로 최적화하지 않는다
              <img key={selected.id} src={frameUrl(selected.frame_path)} alt={`${hms(selected.at_sec)} 프레임`}
                className={`ck-review-frame-image ${zoom ? "max-w-none" : "w-full"}`} />
            ) : (
              <p className="px-4 py-16 text-center text-sm text-ink-400">
                {filteredVod ? "이 방송의 근거 없음 — 다른 방송을 고르거나 VOD 화면에서 찾으세요."
                  : match.source_url ? <>근거 사진이 없습니다. <a href={match.source_url} target="_blank" rel="noreferrer" className="text-accent-400">출처 열기 ↗</a></>
                  : "근거 사진이 없습니다."}
              </p>
            )}
          </div>

          <footer className="grid gap-2 border-t border-ink-800 px-4 py-2 text-xs text-ink-400">
            <EvidenceStrip frames={visible} selectedId={selected?.id ?? null} onPick={setFrameId} vodName={(lead) => {
              const vod = evidence.find((item) => item.vod.lead_id === lead)?.vod;
              return vod ? vodLabel(vod) : "";
            }} />
            <div className="flex flex-wrap items-center gap-2">
              {selected && <span className="font-mono text-[11px]">{selected.frame_path}</span>}
              {/* 연결된 사진이 있으면 그것만 보인다. 같은 구간의 미연결(참고) 사진은 필요할 때 펼친다. */}
              {totals.linked > 0 && totals.reference > 0 && <button type="button" onClick={() => setShowReference((v) => !v)} aria-pressed={showReference}
                className="rounded border border-ink-700 px-2 py-1 hover:text-ink-200">{showReference ? "참고 사진 숨기기" : `참고 사진 ${totals.reference}장 보기`}</button>}
              {selected && (
                // 경기 화면에서는 이 경기에 붙이거나 떼기만 한다. 다른 경기로 옮기기·새 경기는 VOD 화면에서.
                <form action={relinkFrameAction} className="ml-auto">
                  <input type="hidden" name="frame_id" value={selected.id} />
                  <input type="hidden" name="match_id" value={selected.linked ? "" : match.match_id} />
                  <button className="rounded border border-ink-700 px-2 py-1 hover:text-ink-200">
                    {selected.linked ? "이 경기 근거에서 빼기" : "이 경기 근거로 연결"}
                  </button>
                </form>
              )}
            </div>
          </footer>
        </section>

        <aside className="ck-review-inspector" aria-label="검수 인스펙터">
          <div className="ck-review-inspector-shell">
            <div className="ck-review-inspector-body">
              <div className="ck-review-tab-stack">
                <MatchInspector leadId="" match={match} events={events} onBusy={onMetaBusy} />
                <RosterInspector leadId="" match={match} streamers={streamers} focus={rosterFocus(initialFocus)?.focus} onDirty={setRosterDirtyId} />
                <MatchFooter leadId="" match={match} />
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function EvidenceStrip({ frames, selectedId, onPick, vodName }: {
  frames: EvidenceFrame[]; selectedId: string | null; onPick: (id: string) => void; vodName: (leadId: string) => string;
}) {
  if (frames.length < 2) return null;
  return <div className="ck-review-frame-strip" aria-label={`근거 사진 ${frames.length}장`}>
    {frames.map((frame, index) => <button key={frame.id} type="button" aria-current={frame.id === selectedId ? "true" : undefined}
      data-reference={frame.linked ? undefined : "true"}
      data-vod-start={index > 0 && frames[index - 1].lead_id !== frame.lead_id ? "true" : undefined}
      title={`${vodName(frame.lead_id)} · ${hms(frame.at_sec)} · ${KIND_LABEL[frame.kind]} · ${frame.linked ? "이 경기 근거" : "참고(미연결)"}`}
      onClick={() => onPick(frame.id)}>
      {/* eslint-disable-next-line @next/next/no-img-element -- 로컬 검수 프레임 */}
      <img loading="lazy" decoding="async" src={frameThumbUrl(frame.frame_path)} alt={`${hms(frame.at_sec)} 프레임`} />
      <span>{frame.linked ? "" : "참고 "}{hms(frame.at_sec)}</span>
    </button>)}
  </div>;
}

