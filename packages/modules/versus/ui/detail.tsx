"use client";

/**
 * 상대전적 상세 화면. **이 사이트의 한 문장이 직접 드러나는 곳**이다 —
 * "스트리머끼리 누가 누구를 이겼나".
 *
 * ★ 왜 클라이언트인가
 *   한 쌍의 조우는 많아야 수십 건이라 서버가 한 번에 다 준다. 관계·연도·정렬을
 *   바꿀 때마다 왕복하면 느리기만 하고 얻는 게 없다. 필터와 집계는 여기서 한다.
 *
 * ★ 색 규칙 — 승/패가 아니라 **사람**에게 색을 준다
 *   예전엔 왼쪽 사람 기준으로 초록·빨강을 칠했다. 그러면 오른쪽 사람 관점에서
 *   화면을 읽을 수가 없다. 여기서는 x 파랑 / y 빨강으로 고정하고, 이긴 쪽만
 *   채도를 살린다(LoL 블루팀·레드팀 관습과도 맞는다).
 *
 *   ⚠ **같은 팀 모드에서는 사람 색을 쓰지 않는다.** `4 : 2` 의 4 를 x 파랑으로
 *     칠하면 "x 가 4" 로 읽히는데, 실제로는 둘이 함께 딴 4승이다. 그 모드에서만
 *     승 초록 / 패 빨강으로 갈아탄다.
 */

import { useRecordScope } from "../../../ui/use-record-scope.ts";
import Link from "next/link";
import { MatchDetails } from "../../../ui/match-details.tsx";
import { RecordContentPanel, RecordOverviewCard } from "../../../ui/record-structure.tsx";
import { LOL_FORMAT_CHOICES, MapTabs, RecordFilters } from "../../../ui/record-filters.tsx";
import { RecordDateRange } from "../../../ui/record-date-range.tsx";
import { RecordPair } from "../../../ui/record-pair.tsx";
import { useEffect, useMemo, useRef, useState } from "react";
import { FixturePersonView, type FixturePerson } from "./fixture.tsx";
import { VersusPicker, type PickerOption } from "./picker.tsx";
import { formatBadge, isRepeatedDate, OUTCOME_LABEL } from "../../../ui/match-row-model.ts";

// ★ 모듈은 계약만 import 한다. core/lib/db·metrics 를 직접 부르면 verify:modules 가 막는다 —
//   좁은 계약이 곧 core 가 내부를 바꿀 수 있는 자유다.
import {
  resolveRecordPeriod, recordPeriodLabel, withinRecordDay, type RecordPeriod, type PublicRosterEntry, type PublicPairSet,
  type FormatFilter, type Outcome, type SeriesGroup, formatChipLabel, formatLabel, isFormat, kstDateString, mapTabLabel, scopeFormat,
  setLabel, isStandaloneSet, profileHref as contractProfileHref, tally, foldSeries, pairResult, selectPairs,
} from "@soop-lol/core/lib/contract/client";
import { versusHref } from "./paths.ts";

// ── 화면에 오는 모양 ─────────────────────────────────────────────────

type RosterEntry = PublicRosterEntry;

interface Props {
  x: FixturePerson & { streamer_id: string };
  y: FixturePerson & { streamer_id: string };
  /** x 기준으로 본 x–y 의 모든 공개 세트(코어 listPairSetsBetween). */
  sets: PublicPairSet[];
  rosters: RosterEntry[];
  options: PickerOption[];
}

// ── 색 ───────────────────────────────────────────────────────────────

const X_DOT = "var(--team-blue-strong, #38bdf8)", X_TEXT = "var(--team-blue, #7dd3fc)";
const Y_DOT = "var(--team-red-strong, #f87171)", Y_TEXT = "var(--team-red, #fca5a5)";
const WIN = "var(--result-win-strong, #4ade80)", DEAD = "var(--text-muted, #4b5568)";

// ── 파생 ─────────────────────────────────────────────────────────────

/** 고른 세트 한 줄 + x 기준 결과(상대편이면 결과 짝, 같은 팀이면 x 의 결과 — 코어 pairResult). */
type SeenSet = PublicPairSet & { outcome: Outcome };
type Match = SeriesGroup<SeenSet> & { date: string };

/**
 * 세트를 시리즈로 접는다 — **세는 규칙은 코어 하나**(foldSeries → tally·seriesOutcome).
 * ★ 예전엔 이 화면이 세트 과반·랜드 분기로 따로 셌다. 랜드 4승 3패는 이제 시리즈 1승이다(사용자 결정 10).
 */
function foldMatches(rows: SeenSet[]): Match[] {
  // ★ 날짜는 KST. ISO 문자열을 그냥 자르면 UTC 날짜라 자정을 넘긴 경기가 개인 기록과 하루 어긋난다.
  return foldSeries(rows).map((g) => ({ ...g, date: kstDateString(g.played_at) }));
}

/** 이미 KST 로 맞춰 둔 `YYYY-MM-DD`(Match.date)를 점 표기로 바꾼다. */
const ymd = (kstDate: string) => kstDate.replaceAll("-", ".");

/** 줄 왼쪽 칸 — 행사 이름. 진행 방식 라벨은 확인된 것만(미분류는 라벨 없음). */
const labelOf = (s: PublicPairSet) => s.event_name;
const titleOf = (s: PublicPairSet) => [formatLabel(s.format), s.event_name].filter(Boolean).join(" · ");

// ── 본체 ─────────────────────────────────────────────────────────────

export function VersusDetail({ x, y, sets, rosters, options }: Props) {
  const { scope, setScope } = useRecordScope();
  const { relation: rel, map, format, period: datePeriod, sort } = scope;
  const year = datePeriod.key === "year" && datePeriod.from ? datePeriod.from.slice(0, 4) : "all";
  const setRel = (relation: "o" | "a" | "l") => setScope({ relation });
  const setFormat = (value: FormatFilter) => setScope({ format: value });
  const setDatePeriod = (period: RecordPeriod) => setScope({ period });
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const matchButtons = useRef(new Map<string, HTMLButtonElement>());
  const [pendingSeries, setPendingSeries] = useState<string | null>(null);
  useEffect(() => {
    if (!pendingSeries) return;
    const button = matchButtons.current.get(pendingSeries);
    if (button) {
      button.focus({ preventScroll: true });
      button.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
    }
    setPendingSeries(null);
  }, [pendingSeries]);

  const isAlly = rel === "a";

  /**
   * ★ 고르기 — 맵 탭 → 진행 방식(칼바람은 나누지 않는다) → 관계(상대 팀·맞라인·같은 팀, 세트 단위) → 기간(시리즈 첫 본게임 날짜).
   *   프로필 상대 전적 탭·사이드바와 같은 조건이다. 맞라인은 세트마다 판정하고, 시리즈는 고른 세트로 센다.
   */
  const sel = useMemo<SeenSet[]>(() => {
    const fmt = scopeFormat(map, format);
    const scoped = sets.filter((s) => s.map === map && (!fmt || s.format === fmt) && withinRecordDay(s.series_started_on, datePeriod));
    const asPair = scoped.map((s) => ({ ...s, relation: s.relation, a_outcome: s.x_outcome, b_outcome: s.y_outcome, a_position: s.x_position, b_position: s.y_position }));
    return selectPairs(asPair, isAlly ? "teammate" : rel === "l" ? "lane" : "opponent").map((s) => ({ ...s, outcome: pairResult(s) }));
  }, [sets, map, format, datePeriod, isAlly, rel]);

  const record = useMemo(() => tally(sel), [sel]);

  const matches = useMemo(() => {
    const m = foldMatches(sel);
    return sort === "oldest" ? [...m].reverse() : m;
  }, [sel, sort]);

  /**
   * 최근 5시리즈 — 스포츠 중계의 '폼 가이드'. **오래된 → 최근** 순으로 왼쪽부터 놓는다.
   * ★ 표시 정렬(sort)을 타지 않는다. 그래서 여기만 따로 접는다.
   */
  const recentForm = useMemo(() => foldMatches(sel).slice(0, 5).reverse(), [sel]);

  const rosterByMatch = useMemo(() => {
    const by = new Map<string, RosterEntry[]>();
    for (const r of rosters) {
      const cur = by.get(r.match_id) ?? [];
      cur.push(r);
      by.set(r.match_id, cur);
    }
    return by;
  }, [rosters]);

  const firstMetDay = sel.length > 0
    ? ymd(kstDateString(new Date([...sel].sort((a, b) => (a.played_at < b.played_at ? -1 : 1))[0].played_at)))
    : null;

  // 연도 헤더를 끼워 넣는다. 그 해의 세트로 센다(tally) — 시리즈 결과를 화면이 다시 판정하지 않는다.
  const rows: ({ kind: "year"; year: string; summary: string } | { kind: "match"; m: Match; repeatedDate: boolean })[] = [];
  {
    let cur: string | null = null;
    let previousDate = "";
    for (const m of matches.slice(0, 500)) {
      const yy = m.date.slice(0, 4);
      const yearBreak = yy !== cur;
      if (yearBreak) {
        cur = yy;
        const inYear = tally(matches.filter((g) => g.date.slice(0, 4) === yy).flatMap((g) => g.sets)).series;
        const unknown = inYear.unknown ? ` · 미상 ${inYear.unknown}` : "";
        const draw = inYear.draw ? ` · 무 ${inYear.draw}` : "";
        rows.push({
          kind: "year", year: yy,
          summary: isAlly
            ? `같은 팀 시리즈 ${inYear.win}승 ${inYear.loss}패${draw}${unknown}`
            : `시리즈 ${x.display_name} ${inYear.win} : ${inYear.loss} ${y.display_name}${draw}${unknown}`,
        });
      }
      rows.push({ kind: "match", m, repeatedDate: isRepeatedDate(m.date, previousDate, yearBreak) });
      previousDate = m.date;
    }
  }

  const context = new URLSearchParams();
  if (sort !== "recent") context.set("sort", sort);
  if (map !== "rift") context.set("map", map);
  if (format !== "all") context.set("format", format);
  if (year !== "all") context.set("year", year);
  if (datePeriod.from && datePeriod.key !== "year") context.set("from", datePeriod.from);
  if (datePeriod.to && datePeriod.key !== "year") context.set("to", datePeriod.to);
  const profileHref = (slug: string, opponent: string) => {
    const q = new URLSearchParams(context);q.set("opponent",opponent);if(rel==="l")q.set("duel","lane");
    return contractProfileHref("lol", slug, q);
  };
  const swapped = new URLSearchParams(context);swapped.set("a",y.slug);swapped.set("b",x.slug);
  if (isAlly) swapped.set("relation","ally");
  if (rel === "l") swapped.set("relation","lane");
  const periodLabel = recordPeriodLabel(datePeriod);
  const scopeLabel = map === "aram" ? mapTabLabel(map) : `${mapTabLabel(map)} · ${format === "all" ? "전체" : formatChipLabel(format)}`;
  const series = record.series;

  return (
    <>
      <VersusPicker options={options} a={x.slug} b={y.slug} scope={{ map, format, year: year === "all" ? undefined : Number(year) }} />
      {/* ★ 개인 기록과 같은 필터 줄이다 — 맵 탭 · 진행 방식(칼바람은 나누지 않는다) · 기간.
          ⚠ 여기 기간은 주소에 남지만 조회는 하지 않는다(한 쌍의 세트를 통째로 받아 두고 화면에서 거른다). */}
      <RecordFilters category={format} year="all" categoryLabel="진행 방식"
        categories={LOL_FORMAT_CHOICES}
        years={[]} hideCategory={map === "aram"}
        leading={<MapTabs value={map} onChange={(value) => setScope({ map: value })} />}
        onCategoryChange={(value)=>setFormat(isFormat(value) ? value : "all")} onYearChange={()=>{}}
        trailing={<RecordDateRange period={datePeriod} onApply={(range)=>{
          setDatePeriod(range ? resolveRecordPeriod({period:"custom",from:range.from,to:range.to}) : {key:"all"});
        }} />}>
        <div className="arena-tabs" aria-label="관계 필터">
          {([["o", "상대 팀"], ["a", "같은 팀"], ["l", "맞라인"]] as const).map(([key, label]) => <button key={key} type="button" aria-pressed={rel === key} onClick={() => setRel(key)}>{label}</button>)}
        </div>
      </RecordFilters>
      <RecordOverviewCard className="record-overview" label="전적 요약" ariaLive="polite">
        <div className="arena-fixture-top">{isAlly ? "같은 팀 전적 · " : rel === "l" ? "맞라인 · " : ""}{scopeLabel} <span className="arena-fixture-sep" aria-hidden="true">|</span> {periodLabel}</div>
        <div className="arena-duel">
          <FixturePersonView person={x} linked profileHref={profileHref(x.slug,y.slug)} badge="기준" />
          <Link className="arena-duel-swap" href={versusHref(swapped)} prefetch={false} title="스트리머 순서 바꾸기" aria-label="스트리머 순서 바꾸기">
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2.5 5h9M9 2.5 11.5 5 9 7.5M13.5 11h-9M7 8.5 4.5 11 7 13.5" />
            </svg>
          </Link>
          <FixturePersonView person={y} linked profileHref={profileHref(y.slug,x.slug)} />
        </div>
        <div className="arena-score-area">
          <p>{matches.length ? `${matches.length}번의 ${isAlly ? "동행" : "맞대결"} · 시리즈 기준` : "아직 기록이 없습니다"}</p>
          {/* 큰 숫자는 시리즈 승패(x 기준). 세트와 무·미상은 바로 아래 RecordPair 가 함께 보인다. */}
          <div className="arena-score" aria-label={isAlly ? `공동 시리즈 ${series.win}승 ${series.loss}패` : `시리즈 ${x.display_name} ${series.win}승, ${y.display_name} ${series.loss}승`}>
            {matches.length ? series.win : "—"}<span>–</span>{matches.length ? series.loss : "—"}
          </div>
          <RecordPair tally={record} subject={isAlly ? `${x.display_name}·${y.display_name} 공동` : x.display_name} />
        </div>
        {recentForm.length > 0 && (
          <div className="record-form">
            <span className="record-form-label">최근 {recentForm.length}시리즈</span>
            <ol className="record-form-chips">
              {recentForm.map((m) => <li key={m.series_id}>
                <button type="button" data-result={m.result} data-ally={isAlly || undefined}
                  title={`${ymd(m.date)} · ${m.record.win} : ${m.record.loss}`}
                  aria-label={`${ymd(m.date)} ${x.display_name} ${m.record.win} 대 ${m.record.loss} ${y.display_name} · 경기 기록에서 열기`}
                  onClick={() => { setOpen((previous) => ({ ...previous, [m.series_id]: true })); setPendingSeries(m.series_id); }}>
                  {OUTCOME_LABEL[m.result]}
                </button>
              </li>)}
            </ol>
            <span className="record-form-hint">오래된 → 최근</span>
          </div>
        )}
      </RecordOverviewCard>
      <div className="arena-score-meta"><span>{firstMetDay ? `처음 만난 날 ${firstMetDay}` : "선택한 조건에 맞는 경기가 없습니다"}</span></div>

      {/* ── 연대기 ── */}
      <RecordContentPanel className="arena-records" id="match-records">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <h2 className="text-[15px] font-semibold text-ink-200">
            경기 기록 <span className="tabular ml-1.5 text-xs font-normal text-ink-400">{matches.length}시리즈 · {sel.length}세트</span>
          </h2>
          <div className="flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[length:var(--type-micro)] text-ink-400">
              <span className="h-[7px] w-[7px] rounded-full" style={{ background: isAlly ? WIN : X_DOT }} />
              {isAlly ? "함께 승" : x.display_name}
              <span className="ml-1 h-[7px] w-[7px] rounded-full" style={{ background: Y_DOT }} />
              {isAlly ? "함께 패" : y.display_name}
            </span>
            <button type="button" className="record-sort-toggle"
              onClick={() => setScope({ sort: sort === "recent" ? "oldest" : "recent" })}
              aria-label={`정렬 ${sort === "recent" ? "최신순" : "오래된순"} — 누르면 바꿉니다`}>
              {sort === "recent" ? "최신순" : "오래된순"}
              <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                {sort === "recent"
                  ? <path d="M8 3v10M4.5 9.5 8 13l3.5-3.5" />
                  : <path d="M8 13V3M4.5 6.5 8 3l3.5 3.5" />}
              </svg>
            </button>
          </div>
        </div>

        {matches.length > 500 && <p className="record-scope-label">경기 기록은 500시리즈까지 표시합니다. 요약은 선택 범위 전체 기준입니다.</p>}
        <div className="mt-3.5">
          {rows.length === 0 ? (
            <p className="rounded-xl border border-dashed border-ink-700 px-[18px] py-[34px] text-center text-[length:var(--type-dense)] text-ink-400">
              조건에 맞는 경기가 없습니다. 필터를 풀어 보세요.
            </p>
          ) : (
            rows.map((row) =>
              row.kind === "year" ? (
                <div key={`y-${row.year}`} className="arena-match-row items-center pb-2 pt-5">
                  <span className="tabular pr-4 text-right text-2xl font-bold text-ink-200">{row.year}</span>
                  <span className="relative flex h-[34px] justify-center">
                    <span className="h-full w-px bg-ink-700" />
                  </span>
                  <span className="tabular pl-4 text-xs text-ink-400">{row.summary}</span>
                </div>
              ) : (
                <MatchRow
                  key={row.m.series_id}
                  m={row.m}
                  repeatedDate={row.repeatedDate}
                  isAlly={isAlly}
                  x={x} y={y}
                  open={!!open[row.m.series_id]}
                  onToggle={() => setOpen((s) => ({ ...s, [row.m.series_id]: !s[row.m.series_id] }))}
                  roster={rosterByMatch}
                  streamerId={x.streamer_id}
                  buttonRef={(node) => { if (node) matchButtons.current.set(row.m.series_id, node); else matchButtons.current.delete(row.m.series_id); }}
                />
              ),
            )
          )}
        </div>

      </RecordContentPanel>
    </>
  );
}

// ── 경기 한 줄 ───────────────────────────────────────────────────────

function MatchRow({
  m, isAlly, x, y, open, onToggle, roster, buttonRef, streamerId, repeatedDate,
}: {
  m: Match;
  /** 앞줄과 같은 날이면 글자를 감춘다. 칸과 낭독기 문구는 남긴다. */
  repeatedDate: boolean;
  isAlly: boolean;
  x: Props["x"]; y: Props["y"];
  open: boolean;
  onToggle: () => void;
  buttonRef: (node: HTMLButtonElement | null) => void;
  roster: Map<string, RosterEntry[]>;
  streamerId: string;
}) {
  // 줄 색은 코어가 정한 시리즈 결과(m.result)로만 — 무·미상은 중립색.
  const neutral = isAlly || m.result === "draw" || m.result === "unknown";
  const dot = neutral ? "var(--result-draw, #2f3546)" : m.result === "win" ? X_DOT : Y_DOT;
  const cardBorder = neutral ? "var(--result-draw-border, #1c2030)" : m.result === "win" ? "var(--team-blue-border, rgba(56,189,248,0.26))" : "var(--team-red-border, rgba(248,113,113,0.26))";
  const cardBg = neutral ? "var(--result-draw-bg, rgba(16,18,25,0.6))" : m.result === "win" ? "var(--team-blue-bg, rgba(56,189,248,0.05))" : "var(--team-red-bg, rgba(248,113,113,0.045))";
  const head = m.first;
  const land = head.format === "land";
  const xWins = m.record.win, yWins = m.record.loss;

  return (
    /* 날짜·점의 세로 위치는 arena.css 의 --row-anchor 하나가 정한다(.versus-timeline-*). */
    <div className="arena-match-row versus-timeline-row items-stretch">
      {/* ⚠ 칸 자체를 지우면 그리드가 밀린다. 글자만 감추고 낭독기에는 남긴다. */}
      <div className="tabular versus-timeline-date pr-4 text-right text-ink-400">
        {repeatedDate ? <span className="sr-only">{ymd(m.date)}</span> : ymd(m.date)}
      </div>
      <div className="relative flex justify-center">
        <span className="h-full w-px bg-ink-700" />
        <span
          className="versus-timeline-dot absolute h-[11px] w-[11px] rounded-full border-2 border-ink-950"
          style={{ background: dot }}
        />
      </div>
      <div className="py-1 pl-4">
        <div className="overflow-hidden rounded-xl border" style={{ borderColor: cardBorder, background: cardBg }}>
          <button
            type="button"
            onClick={onToggle}
            ref={buttonRef}
            aria-expanded={open}
            className="arena-match-toggle flex w-full cursor-pointer items-center gap-[11px] px-3.5 py-2.5 text-left transition hover:bg-ink-800/25"
          >
            <span title={titleOf(head)} className="record-match-event flex-none text-ink-200">
              <span className="record-match-clip">{labelOf(head)}</span>
            </span>

            {isAlly ? (
              <span className="flex-none whitespace-nowrap">
                <span className="text-xs" style={{ color: X_TEXT }}>{x.display_name}</span>
                <span className="mx-1.5 text-[length:var(--type-micro)] text-ink-600">·</span>
                <span className="text-xs" style={{ color: Y_TEXT }}>{y.display_name}</span>
                <span className="tabular ml-2 text-sm font-bold" style={{ color: m.result === "win" ? WIN : m.result === "loss" ? Y_DOT : DEAD }}>
                  함께 {m.record.win}승 {m.record.loss}패{m.record.unknown ? ` · 미상 ${m.record.unknown}` : ""}
                </span>
              </span>
            ) : (
              <span className="flex-none inline-flex items-center gap-[7px] whitespace-nowrap">
                <span className="text-xs" style={{ color: X_TEXT }}>{x.display_name}</span>
                <span className="tabular text-[15px] font-bold" style={{ color: xWins >= yWins ? X_TEXT : DEAD }}>{xWins}</span>
                <span className="text-[length:var(--type-micro)] font-normal text-ink-600">:</span>
                <span className="tabular text-[15px] font-bold" style={{ color: yWins >= xWins ? Y_TEXT : DEAD }}>{yWins}</span>
                <span className="text-xs" style={{ color: Y_TEXT }}>{y.display_name}</span>
                {(m.record.draw > 0 || m.record.unknown > 0) && <span className="text-[length:var(--type-micro)] text-ink-400">
                  {m.record.draw > 0 && `무 ${m.record.draw}`}{m.record.draw > 0 && m.record.unknown > 0 && " · "}{m.record.unknown > 0 && `미상 ${m.record.unknown}`}
                </span>}
              </span>
            )}

            {isAlly && (
              <span className="flex-none rounded border border-ink-700 bg-ink-800 px-1.5 py-px text-[length:var(--type-micro)] text-ink-400">
                같은 팀
              </span>
            )}
            <span className="tabular ml-auto flex-none rounded border border-ink-700 px-1.5 py-px text-[length:var(--type-micro)] text-ink-400">
              {land ? `랜드 ${m.sets.length}판` : formatBadge(head.best_of, m.sets.length, m.sets.length === 1 && isStandaloneSet(head.match_id, m.series_id))}
            </span>
            <span className="flex-none text-[length:var(--type-micro)] text-ink-300">{OUTCOME_LABEL[m.result]}</span>
            {/* ▸/▾ 는 Pretendard 서브셋에 글리프가 없어 안 그려진다 — +/− 를 쓴다 */}
            <span className="inline-flex h-[18px] w-[18px] flex-none self-center items-center justify-center rounded-[5px] border border-ink-700 text-[length:var(--type-micro)] leading-none text-ink-400">
              {open ? "−" : "+"}
            </span>
          </button>

          {open && <MatchDetails
            sets={m.sets.map((s)=>({matchId:s.match_id,label:setLabel({standalone:isStandaloneSet(s.match_id,s.series_id),best_of:s.best_of,set_order_known:s.set_order_known,series_game_no:s.series_game_no,land}),players:roster.get(s.match_id) ?? []}))}
            streamerId={streamerId} highlightedStreamerIds={[x.streamer_id,y.streamer_id]} />}
        </div>
      </div>
    </div>
  );
}
