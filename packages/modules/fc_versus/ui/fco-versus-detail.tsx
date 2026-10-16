"use client";

import { useRecordScope } from "../../../ui/use-record-scope.ts";
import { useMemo, type ReactNode } from "react";
import {
  FCO_MODE_LABEL, formatChipLabel, recordPeriodLabel, resolveRecordPeriod, filterSeriesPeriod, takeSeries,
  type FcoGame, type FcoPerson, type FormatFilter, type RecordPeriod,
} from "@soop-lol/core/lib/contract/client";
import { FCO_FORMAT_CHOICES, FcoModeSelect } from "../../../ui/fc/fco-filters.tsx";
import { RecordDateRange } from "../../../ui/record-date-range.tsx";
import { RecordFilters } from "../../../ui/record-filters.tsx";
import { RecordContentPanel, RecordSectionTabs } from "../../../ui/record-structure.tsx";
import { FcRecordSearch } from "../../../ui/fc/fco-record-search.tsx";
import { FcoVersusOverview } from "../../../ui/fc/fco-overview.tsx";
import { FcoMatchList } from "../../../ui/fc/fco-records.tsx";
import { versusHref } from "./paths.ts";

export function FcoVersusDetail({ a, b, people, games, initialTab, metrics, players }: {
  a: FcoPerson; b: FcoPerson; people: FcoPerson[]; games: FcoGame[];
  initialTab: "games" | "metrics" | "players"; metrics: ReactNode; players: ReactNode;
}) {
  const { scope, setScope } = useRecordScope();
  const { mode, period, sort, format } = scope;
  const setMode = (mode: string) => setScope({ mode });
  const setFormat = (format: string) => setScope({ format: format as FormatFilter });
  const setPeriod = (period: RecordPeriod) => setScope({ period });
  const modes = useMemo(() => [...new Set(games.map((game) => game.mode_key).filter((key): key is string => !!key))]
    .sort((left, right) => (FCO_MODE_LABEL[left] ?? left).localeCompare(FCO_MODE_LABEL[right] ?? right, "ko")), [games]);
  // 진행 방식(기본 축) → 경기 모드(보조) → 기간(시리즈 첫 판 날짜). 요약과 목록이 이 한 집합을 쓴다.
  const filtered = useMemo(() => filterSeriesPeriod(games.filter(game => (format === "all" || game.format === format)
    && (mode === "all" || game.mode_key === mode)), period, game => game.series_id ?? game.id, game => game.played_at)
    .sort((left, right) => new Date(right.played_at).getTime() - new Date(left.played_at).getTime()), [games, format, mode, period]);
  const page = takeSeries(sort === "recent" ? filtered : [...filtered].reverse(), 200, game => game.series_id ?? game.id);
  const displayed = page.rows;
  const params = { mode, from: period.from, to: period.to, sort, ...(format !== "all" ? { format } : {}) };
  const base = versusHref({ ...params, a: a.slug, b: b.slug });
  const swap = versusHref({ ...params, a: b.slug, b: a.slug, tab: initialTab });
  const modeLabel = `${format === "all" ? "전체" : formatChipLabel(format)}${mode === "all" ? "" : ` · ${FCO_MODE_LABEL[mode] ?? `모드 ${mode}`}`}`;

  return <>
    <FcRecordSearch people={people} a={a.slug} b={b.slug} mode="versus" versusPath={versusHref()} />
    <RecordFilters category={format} categoryLabel="진행 방식" year="all" years={[]}
      categories={FCO_FORMAT_CHOICES}
      leading={<FcoModeSelect value={mode} choices={[{ value: "all" }, ...modes.map((value) => ({ value }))]} onChange={setMode} />}
      onCategoryChange={setFormat} onYearChange={() => {}}
      trailing={<RecordDateRange period={period} onApply={(range) => setPeriod(range
        ? resolveRecordPeriod({ period: "custom", from: range.from, to: range.to }) : { key: "all" })} />}>
      <span className="record-scope-label">상대 전적</span>
    </RecordFilters>
    <FcoVersusOverview a={a} b={b} games={filtered} periodLabel={`${modeLabel} · ${recordPeriodLabel(period)}`}
      swapHref={swap} onRecentSelect={(game) => document.getElementById(`fc-versus-game-${game.id}`)
        ?.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" })} />
    {/* 세 탭이 같은 자리의 본문을 바꾼다 — 탭을 목록 아래에 두면 지표·선수를 누를 때마다 목록 끝까지 내려가야 한다. */}
    <div id="record-content">
      <RecordSectionTabs active={initialTab} label="상대 전적 기록" items={[
        { key: "games", label: "경기 기록", href: base },
        { key: "metrics", label: "경기 지표", href: versusHref({ ...params, a: a.slug, b: b.slug, tab: "metrics" }) },
        { key: "players", label: "사용 선수", href: versusHref({ ...params, a: a.slug, b: b.slug, tab: "players" }) },
      ]} />
      {initialTab === "games" ? <RecordContentPanel className="arena-records" id="match-records">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <h2 className="text-[15px] font-semibold text-ink-200">경기 기록 <span className="tabular ml-1.5 text-xs font-normal text-ink-400">{filtered.length}세트</span></h2>
          <div className="flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[length:var(--type-micro)] text-ink-400">
              <span className="h-[7px] w-[7px] rounded-full bg-sky-400" />{a.name}
              <span className="ml-1 h-[7px] w-[7px] rounded-full bg-red-400" />{b.name}
            </span>
            <button type="button" className="record-sort-toggle" onClick={() => setScope({ sort: sort === "recent" ? "oldest" : "recent" })}
              aria-label={`정렬 ${sort === "recent" ? "최신순" : "오래된순"} — 누르면 바꿉니다`}>
              {sort === "recent" ? "최신순" : "오래된순"}
              <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                {sort === "recent" ? <path d="M8 3v10M4.5 9.5 8 13l3.5-3.5" /> : <path d="M8 13V3M4.5 6.5 8 3l3.5 3.5" />}
              </svg>
            </button>
          </div>
        </div>
        {page.truncated && <p className="record-scope-label">경기 기록은 200개 묶음까지 표시합니다. 요약은 선택 범위 전체 기준입니다.</p>}
        <div className="mt-3.5"><FcoMatchList games={displayed} perspectiveStreamerId={a.id} opponentStreamerId={b.id} rowIdPrefix="fc-versus-game-" /></div>
      </RecordContentPanel> : <RecordContentPanel className="fc-tab-panel">
        <h2>{initialTab === "metrics" ? "경기 지표" : "사용 선수"} <small>전체 맞대결 기준</small></h2>
        {initialTab === "metrics" ? metrics : players}
      </RecordContentPanel>}
    </div>
  </>;
}
