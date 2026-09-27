"use client";

import { useMemo, useState, type ReactNode } from "react";
import {
  FCO_MODE_LABEL, recordPeriodLabel, resolveRecordPeriod, withinRecordPeriod,
  type FcoGame, type FcoPerson, type RecordPeriod,
} from "@soop-lol/core/lib/contract";
import { RecordDateRange } from "../../../ui/record-date-range.tsx";
import { RecordFilters } from "../../../ui/record-filters.tsx";
import { RecordContentPanel, RecordSectionTabs } from "../../../ui/record-structure.tsx";
import { FcRecordSearch } from "../../../ui/fc/fco-record-search.tsx";
import { FcoVersusOverview } from "../../../ui/fc/fco-overview.tsx";
import { FcoMatchList } from "../../../ui/fc/fco-records.tsx";
import { VERSUS_PATH } from "./paths.ts";

export function FcoVersusDetail({ a, b, people, games, initialTab, metrics, players }: {
  a: FcoPerson; b: FcoPerson; people: FcoPerson[]; games: FcoGame[];
  initialTab: "games" | "metrics" | "players"; metrics: ReactNode; players: ReactNode;
}) {
  const [mode, setMode] = useState("all");
  const [period, setPeriod] = useState<RecordPeriod>({ key: "all" });
  const [sort, setSort] = useState<"recent" | "oldest">("recent");
  const modes = useMemo(() => [...new Set(games.map((game) => game.mode_key).filter((key): key is string => !!key))]
    .sort((left, right) => (FCO_MODE_LABEL[left] ?? left).localeCompare(FCO_MODE_LABEL[right] ?? right, "ko")), [games]);
  const filtered = useMemo(() => games.filter((game) => (mode === "all" || game.mode_key === mode)
    && withinRecordPeriod(game.played_at, period))
    .sort((left, right) => new Date(right.played_at).getTime() - new Date(left.played_at).getTime()), [games, mode, period]);
  const displayed = sort === "recent" ? filtered : [...filtered].reverse();
  const base = `${VERSUS_PATH}?a=${encodeURIComponent(a.slug)}&b=${encodeURIComponent(b.slug)}`;
  const swap = `${VERSUS_PATH}?a=${encodeURIComponent(b.slug)}&b=${encodeURIComponent(a.slug)}`;
  const modeLabel = mode === "all" ? "전체 경기" : FCO_MODE_LABEL[mode] ?? `모드 ${mode}`;

  return <>
    <FcRecordSearch people={people} a={a.slug} b={b.slug} mode="versus" versusPath={VERSUS_PATH} />
    <RecordFilters category={mode} categoryLabel="경기 모드" year="all" years={[]}
      categories={[{ value: "all", label: "전체 경기" }, ...modes.map((key) => ({ value: key, label: FCO_MODE_LABEL[key] ?? `모드 ${key}` }))]}
      onCategoryChange={setMode} onYearChange={() => {}}
      trailing={<RecordDateRange period={period} onApply={(range) => setPeriod(range
        ? resolveRecordPeriod({ period: "custom", from: range.from, to: range.to }) : { key: "all" })} />}>
      <span className="record-scope-label">상대 전적</span>
    </RecordFilters>
    <FcoVersusOverview a={a} b={b} games={filtered} periodLabel={`${modeLabel} · ${recordPeriodLabel(period)}`}
      swapHref={swap} onRecentSelect={(game) => document.getElementById(`fc-versus-game-${game.id}`)
        ?.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" })} />
    <RecordContentPanel className="arena-records" id="match-records">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h2 className="text-[15px] font-semibold text-ink-200">경기 기록 <span className="tabular ml-1.5 text-xs font-normal text-ink-400">{filtered.length}경기</span></h2>
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[11px] text-ink-400">
            <span className="h-[7px] w-[7px] rounded-full bg-sky-400" />{a.name}
            <span className="ml-1 h-[7px] w-[7px] rounded-full bg-red-400" />{b.name}
          </span>
          <button type="button" className="record-sort-toggle" onClick={() => setSort((value) => value === "recent" ? "oldest" : "recent")}
            aria-label={`정렬 ${sort === "recent" ? "최신순" : "오래된순"} — 누르면 바꿉니다`}>
            {sort === "recent" ? "최신순" : "오래된순"}
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              {sort === "recent" ? <path d="M8 3v10M4.5 9.5 8 13l3.5-3.5" /> : <path d="M8 13V3M4.5 6.5 8 3l3.5 3.5" />}
            </svg>
          </button>
        </div>
      </div>
      <div className="mt-3.5"><FcoMatchList games={displayed} perspectiveStreamerId={a.id} rowIdPrefix="fc-versus-game-" /></div>
    </RecordContentPanel>
    <div id="related-records">
      <RecordSectionTabs active={initialTab} label="상대 전적 추가 기록" items={[
        { key: "games", label: "경기 기록", href: base },
        { key: "metrics", label: "경기 지표", href: `${base}&tab=metrics` },
        { key: "players", label: "사용 선수", href: `${base}&tab=players` },
      ]} />
      {initialTab !== "games" && <RecordContentPanel className="fc-tab-panel">
        <h2>{initialTab === "metrics" ? "경기 지표" : "사용 선수"} <small>전체 맞대결 기준</small></h2>
        {initialTab === "metrics" ? metrics : players}
      </RecordContentPanel>}
    </div>
  </>;
}
