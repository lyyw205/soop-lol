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

import Link from "next/link";
import { MatchDetails } from "../../../ui/match-details.tsx";
import { RecordContentPanel, RecordOverviewCard } from "../../../ui/record-structure.tsx";
import { RecordFilters } from "../../../ui/record-filters.tsx";
import { RecordDateRange } from "../../../ui/record-date-range.tsx";
import { useEffect, useMemo, useRef, useState } from "react";
import { FixturePersonView, type FixturePerson } from "./fixture.tsx";
import { VersusPicker, type PickerOption } from "./picker.tsx";
import { formatBadge, isRepeatedDate, matchOutcome } from "../../../ui/match-row-model.ts";

// ★ 모듈은 계약만 import 한다. core/lib/db·metrics 를 직접 부르면 verify:modules 가 막는다 —
//   좁은 계약이 곧 core 가 내부를 바꿀 수 있는 자유다.
import {
  withinRecordPeriod, resolveRecordPeriod, recordPeriodLabel, type RecordPeriod, type PublicRosterEntry, QUEUE_LABEL, MATCH_CATEGORIES, CATEGORY_LABEL, expandCategory, kstDateString, kstYear, type MatchCategoryFilter,
  setLabel, isStandaloneSet,
} from "@soop-lol/core/lib/contract";

// ── 화면에 오는 모양 ─────────────────────────────────────────────────

export interface VersusSet {
  match_id: string;
  series_key: string;
  series_game_no: number | null;
  best_of: number | null;
  /** 세트 순서를 출처에서 확인했나 — 세트 이름은 계약의 setLabel 이 정한다. */
  set_order_known: boolean;
  source: string;
  category: string;
  queue_id: number;
  event_name: string | null;
  relation: "opponent" | "ally";
  is_lane_matchup: boolean;
  /** ISO. 서버에서 문자열로 넘긴다 — Date 를 그대로 넘기면 직렬화 경계에서 흔들린다. */
  played_at: string;
  xWin: boolean;
  yWin: boolean;
  xPos: string | null;
  yPos: string | null;
  xK: number | null; xD: number | null; xA: number | null;
  yK: number | null; yD: number | null; yA: number | null;
}

type RosterEntry = PublicRosterEntry;

interface Props {
  x: FixturePerson & { streamer_id: string };
  y: FixturePerson & { streamer_id: string };
  sets: VersusSet[];
  rosters: RosterEntry[];
  options: PickerOption[];
  initialCategory?: MatchCategoryFilter;
  initialYear?: number;
  initialRelation?: "o" | "a" | "l";
  initialDatePeriod?: RecordPeriod;
}

// ── 색 ───────────────────────────────────────────────────────────────

const X_DOT = "#38bdf8", X_TEXT = "#7dd3fc";
const Y_DOT = "#f87171", Y_TEXT = "#fca5a5";
const WIN = "#4ade80", DEAD = "#4b5568";

// ── 파생 ─────────────────────────────────────────────────────────────

interface Match {
  series: string;
  sets: VersusSet[];
  xSets: number;
  ySets: number;
  xWin: boolean;
  draw: boolean;
  date: string;
  head: VersusSet;
}

/**
 * 세트를 경기로 접는다. **세트 과반**을 이긴 쪽이 그 경기의 승자다.
 * 3판 2선승을 2:1 로 이기면 세트로 2승 1패, 경기로는 1승 0패다.
 * `xSets * 2 === sets.length` 는 무승부다 — 옛 2세트제 조별리그가 그렇다.
 */
function foldMatches(rows: VersusSet[]): Match[] {
  const by = new Map<string, VersusSet[]>();
  for (const s of rows) {
    const cur = by.get(s.series_key) ?? [];
    cur.push(s);
    by.set(s.series_key, cur);
  }
  return [...by.entries()]
    .map(([series, list]) => {
      const sorted = [...list].sort((a, b) => (a.series_game_no ?? 0) - (b.series_game_no ?? 0) || new Date(a.played_at).getTime() - new Date(b.played_at).getTime());
      const xSets = sorted.filter((s) => s.xWin).length;
      // ★ 판정식을 여기서 다시 쓰지 않는다. 같은 규칙이 네 군데에 복사돼 있었고,
      //   무승부(정확히 반)를 한 곳만 패로 세는 사고가 실제로 났다.
      const outcome = matchOutcome(xSets, sorted.length);
      return {
        series, sets: sorted, xSets, ySets: sorted.length - xSets,
        xWin: outcome === "win",
        draw: outcome === "draw",
        // ★ ISO 문자열을 그냥 자르면 **UTC 날짜**다. 자정을 넘긴 경기에서 개인 기록(KST)과
        //   하루씩 어긋났다. 연도 머리글(227·230행)도 이 값을 쓰므로 여기서 KST 로 맞춘다.
        date: kstDateString(new Date(sorted[0].played_at)),
        head: sorted[0],
      };
    })
    .sort((a, b) => new Date(b.head.played_at).getTime() - new Date(a.head.played_at).getTime() || b.series.localeCompare(a.series));
}

const setRecord = (rows: VersusSet[]) => ({
  wins: rows.filter((s) => s.xWin).length,
  losses: rows.filter((s) => !s.xWin).length,
});

const matchRecord = (rows: VersusSet[]) => {
  const m = foldMatches(rows);
  return { wins: m.filter((g) => g.xWin).length, losses: m.filter((g) => !g.xWin && !g.draw).length };
};

/** 이미 KST 로 맞춰 둔 `YYYY-MM-DD`(Match.date)를 점 표기로 바꾼다. */
const ymd = (kstDate: string) => kstDate.replaceAll("-", ".");

/** 줄 왼쪽 112px 칸에 들어갈 이름. 대회면 대회명, 아니면 큐 이름. */
const labelOf = (s: VersusSet) =>
  s.event_name ?? QUEUE_LABEL[s.queue_id] ?? `큐 ${s.queue_id}`;

// ── 본체 ─────────────────────────────────────────────────────────────

export function VersusDetail({ x, y, sets, rosters, options, initialCategory = "all", initialYear, initialRelation = "o", initialDatePeriod = {key:"all"} }: Props) {
  const [rel, setRel] = useState<"o" | "a" | "l">(initialRelation);
  const [year, setYear] = useState<"all" | string>(initialYear ? String(initialYear) : "all");
  const [category, setCategory] = useState<MatchCategoryFilter>(initialCategory);
  const [datePeriod, setDatePeriod] = useState(initialDatePeriod);
  const [sort, setSort] = useState<"recent" | "oldest">("recent");
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

  const scoped = useMemo(
    () => {
      const categories = expandCategory(category);
      return sets.filter((s) => (year === "all" || String(kstYear(new Date(s.played_at))) === year)
        && (!categories || categories.some((c) => c === s.category)));
    },
    [sets, year, category],
  );
  const sel = useMemo(
    () => {
      const related = scoped.filter((s) => isAlly ? s.relation === "ally" : s.relation === "opponent");
      const starts = new Map<string, string>();
      for (const row of related) {
        const previous = starts.get(row.series_key);
        if (!previous || row.played_at < previous) starts.set(row.series_key, row.played_at);
      }
      const rows = related.filter((s)=>withinRecordPeriod(starts.get(s.series_key)!, datePeriod));
      if (rel !== "l") return rows;
      // 프로필과 같은 경기 기준: 모든 세트에서 맞라인이었던 다전제만 포함한다.
      const mixed = new Set(rows.filter((s) => !s.is_lane_matchup).map((s) => s.series_key));
      return rows.filter((s) => !mixed.has(s.series_key));
    },
    [scoped, isAlly, rel, datePeriod],
  );

  const mRec = matchRecord(sel);
  const sRec = setRecord(sel);

  const matches = useMemo(() => {
    const m = foldMatches(sel);
    return sort === "oldest" ? [...m].reverse() : m;
  }, [sel, sort]);

  /**
   * 최근 5경기 — 스포츠 중계의 '폼 가이드'. **오래된 → 최근** 순으로 왼쪽부터 놓는다.
   *
   * ★ 표시 정렬(sort)을 타지 않는다. `matches` 는 사용자가 고른 순서라 '오래된순' 을
   *   누르면 최근 5경기가 아니라 가장 오래된 5경기가 잡힌다. 그래서 여기만 따로 접는다.
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

  // ⚠ `played_at` 은 ISO 문자열 전체다. ymd() 는 `YYYY-MM-DD` 를 받는 함수라 그대로 넣으면
  //   `2026.09.19T12:42:00.000Z` 가 그려진다. KST 날짜로 먼저 줄인다.
  const firstMetDay = sel.length > 0
    ? ymd(kstDateString(new Date([...sel].sort((a, b) => (a.played_at < b.played_at ? -1 : 1))[0].played_at)))
    : null;

  // 연도 헤더를 끼워 넣는다.
  const rows: ({ kind: "year"; year: string; summary: string } | { kind: "match"; m: Match; repeatedDate: boolean })[] = [];
  {
    let cur: string | null = null;
    // 같은 날이 이어지면 날짜는 맨 위 한 번만 쓴다 — 개인 기록 매치 히스토리와 같은 규칙이다.
    let previousDate = "";
    for (const m of matches) {
      const yy = m.date.slice(0, 4);
      const yearBreak = yy !== cur;
      if (yearBreak) {
        cur = yy;
        const inYear = matches.filter((g) => g.date.slice(0, 4) === yy);
        const w = inYear.filter((g) => g.xWin).length;
        const l = inYear.filter((g) => !g.xWin && !g.draw).length;
        rows.push({
          kind: "year", year: yy,
          summary: isAlly
            ? `같은 팀 ${w}승 ${l}패${w + l > 0 ? ` · ${Math.round((w / (w + l)) * 100)}%` : ""}`
            : `${x.display_name} ${w} : ${l} ${y.display_name}`,
        });
      }
      rows.push({ kind: "match", m, repeatedDate: isRepeatedDate(m.date, previousDate, yearBreak) });
      previousDate = m.date;
    }
  }

  const context = new URLSearchParams();
  if (category !== "all") context.set("category", category);
  if (year !== "all") context.set("year", year);
  if (datePeriod.from) context.set("from", datePeriod.from);
  if (datePeriod.to) context.set("to", datePeriod.to);
  const profileHref = (slug: string, opponent: string) => {
    const q = new URLSearchParams(context);q.set("opponent",opponent);if(rel==="l")q.set("duel","lane");
    return `/s/${encodeURIComponent(slug)}?${q}`;
  };
  const swapped = new URLSearchParams(context);swapped.set("a",y.slug);swapped.set("b",x.slug);
  if (isAlly) swapped.set("relation","ally");
  if (rel === "l") swapped.set("relation","lane");
  // 문구는 한 곳에서 만든다(recordPeriodLabel). 주소로 들어온 연도만 여기서 따로 읽는다 —
  // 연도 선택은 없앴고, 기간을 정하면 연도는 풀린다.
  const periodLabel = datePeriod.key === "all" && year !== "all" ? `${year}년` : recordPeriodLabel(datePeriod);

  return (
    <>
      <VersusPicker options={options} a={x.slug} b={y.slug} category={category} year={year === "all" ? undefined : Number(year)} />
      {/* ★ 개인 기록과 같은 필터 줄이다 — 분류 선택 옆에 날짜 범위가 바로 붙는다.
          예전엔 연도 드롭다운이었는데, 연도와 날짜 범위가 서로를 덮어써서 어느 쪽이
          먹었는지 화면에서 알 수 없었다. 기간을 정하는 자리를 하나로 합쳤다.
          ⚠ 여기 기간은 주소가 아니라 이 컴포넌트 상태다(상대전적은 한 쌍의 조우를
            통째로 받아 두고 화면에서 거른다). 그래서 onApply 로 받아 직접 넣는다. */}
      <RecordFilters category={category} year="all"
        categories={MATCH_CATEGORIES.map((c)=>({value:c.key,label:c.label}))}
        years={[]}
        onCategoryChange={(value)=>setCategory(value as MatchCategoryFilter)} onYearChange={()=>{}}
        trailing={<RecordDateRange period={datePeriod} onApply={(range)=>{
          setYear("all");
          setDatePeriod(range ? resolveRecordPeriod({period:"custom",from:range.from,to:range.to}) : {key:"all"});
        }} />}>
        <div className="arena-tabs" aria-label="관계 필터">
          {([["o", "상대 팀"], ["a", "같은 팀"], ["l", "맞라인"]] as const).map(([key, label]) => <button key={key} type="button" aria-pressed={rel === key} onClick={() => setRel(key)}>{label}</button>)}
        </div>
      </RecordFilters>
      <RecordOverviewCard className="record-overview" label="전적 요약" ariaLive="polite">
        {/* ★ '상대전적' 은 지웠다 — 페이지 전체가 상대전적이라 같은 말을 또 하는 자리였다.
            같은 팀·맞라인은 기본값이 아니므로 남긴다. 분류를 앞에, 기간을 뒤에 둔다. */}
        <div className="arena-fixture-top">{isAlly ? "같은 팀 전적 · " : rel === "l" ? "맞라인 · " : ""}{CATEGORY_LABEL[category]} <span className="arena-fixture-sep" aria-hidden="true">|</span> {periodLabel}</div>
        <div className="arena-duel">
          <FixturePersonView person={x} linked profileHref={profileHref(x.slug,y.slug)} badge="기준" />
          {/* 순서 바꾸기는 **두 사람 사이**가 제자리다. 예전엔 카드 밖 아래에 글자 링크로
              있었는데, 무엇과 무엇을 바꾸는지 그 자리에서는 보이지 않았다. */}
          <Link className="arena-duel-swap" href={`/m/versus?${swapped}`} title="스트리머 순서 바꾸기" aria-label="스트리머 순서 바꾸기">
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2.5 5h9M9 2.5 11.5 5 9 7.5M13.5 11h-9M7 8.5 4.5 11 7 13.5" />
            </svg>
          </Link>
          <FixturePersonView person={y} linked profileHref={profileHref(y.slug,x.slug)} />
        </div>
        <div className="arena-score-area">
          <p>{matches.length ? `${matches.length}번의 ${isAlly ? "동행" : "맞대결"}` : "아직 기록이 없습니다"}</p>
          <div className="arena-score" aria-label={isAlly ? `공동 ${mRec.wins}승 ${mRec.losses}패` : `${x.display_name} ${mRec.wins}승, ${y.display_name} ${mRec.losses}승`}>
            {matches.length ? mRec.wins : "—"}<span>–</span>{matches.length ? mRec.losses : "—"}
          </div>
          {/* '경기 승수 기준' 과 '(X 기준)' 은 뺐다 — 위 큰 숫자가 경기 승수이고, 기준은
              왼쪽 인물의 '기준' 칩이 말한다. 세트 승패와 무승부만 남긴다. */}
          <p>{isAlly && `공동 전적 · ${mRec.wins}승 ${mRec.losses}패 · `}세트 {sRec.wins}승 {sRec.losses}패
            {matches.some((m) => m.draw) && ` · 무승부 ${matches.filter((m) => m.draw).length}경기`}</p>
        </div>
        {recentForm.length > 0 && (
          <div className="record-form">
            <span className="record-form-label">최근 {recentForm.length}경기</span>
            <ol className="record-form-chips">
              {recentForm.map((m) => {
                const result = m.draw ? "draw" : m.xWin ? "win" : "loss";
                const label = m.draw ? "무" : m.xWin ? "승" : "패";
                return <li key={m.series}>
                  <button type="button" data-result={result} data-ally={isAlly || undefined}
                    title={`${ymd(m.date)} · ${m.xSets} : ${m.ySets}`}
                    aria-label={`${ymd(m.date)} ${x.display_name} ${m.xSets} 대 ${m.ySets} ${y.display_name} · 경기 기록에서 열기`}
                    onClick={() => { setOpen((previous) => ({ ...previous, [m.series]: true })); setPendingSeries(m.series); }}>
                    {label}
                  </button>
                </li>;
              })}
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
            경기 기록 <span className="tabular ml-1.5 text-xs font-normal text-ink-400">{matches.length}경기</span>
          </h2>
          <div className="flex flex-wrap items-center gap-3">
            {/* '상대편으로 만난 경기만' 은 뺐다 — 바로 위 관계 필터(상대 팀/같은 팀/맞라인)가
                같은 말을 이미 하고 있고, 그쪽이 누를 수 있는 진짜 조작이다. */}
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[11px] text-ink-400">
              <span className="h-[7px] w-[7px] rounded-full" style={{ background: isAlly ? WIN : X_DOT }} />
              {isAlly ? "함께 승" : x.display_name}
              <span className="ml-1 h-[7px] w-[7px] rounded-full" style={{ background: Y_DOT }} />
              {isAlly ? "함께 패" : y.display_name}
            </span>
            {/* 둘 중 하나는 늘 꺼져 있는 버튼이었다. 상태가 둘뿐이면 토글 하나가 맞다. */}
            <button type="button" className="record-sort-toggle"
              onClick={() => setSort((previous) => (previous === "recent" ? "oldest" : "recent"))}
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

        <div className="mt-3.5">
          {rows.length === 0 ? (
            <p className="rounded-xl border border-dashed border-ink-700 px-[18px] py-[34px] text-center text-[13px] text-ink-400">
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
                  key={row.m.series}
                  m={row.m}
                  repeatedDate={row.repeatedDate}
                  isAlly={isAlly}
                  x={x} y={y}
                  open={!!open[row.m.series]}
                  onToggle={() => setOpen((s) => ({ ...s, [row.m.series]: !s[row.m.series] }))}
                  roster={rosterByMatch}
                  streamerId={x.streamer_id}
                  buttonRef={(node) => { if (node) matchButtons.current.set(row.m.series, node); else matchButtons.current.delete(row.m.series); }}
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
  const multi = m.sets.length > 1;
  const dot = isAlly ? "#2f3546" : m.draw ? "#2f3546" : m.xWin ? X_DOT : Y_DOT;
  const cardBorder = isAlly || m.draw ? "#1c2030" : m.xWin ? "rgba(56,189,248,0.26)" : "rgba(248,113,113,0.26)";
  const cardBg = isAlly || m.draw ? "rgba(16,18,25,0.6)" : m.xWin ? "rgba(56,189,248,0.05)" : "rgba(248,113,113,0.045)";

  // 같은 팀 모드는 둘이 함께 이겼는지를 센다 — 사람 색을 쓰지 않는다.
  const allyWins = m.sets.filter((s) => s.xWin).length;
  const allyLosses = m.sets.length - allyWins;

  return (
    /* 날짜·점의 세로 위치는 arena.css 의 --row-anchor 하나가 정한다(.versus-timeline-*).
       개인 기록과 같은 규칙 — 마크업에 px 를 직접 박으면 카드 여백이 바뀔 때 따로 논다. */
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
            /* ★ 크기가 섞인 한 줄은 **가운데**로 맞춘다. 예전엔 밑선이었는데, 한글은
               글자 잉크가 제 줄 상자의 거의 가운데에 있어서 밑선을 맞추면 **작은 글자가
               큰 글자보다 아래로 내려앉는다** — 실측으로 밑선 1.59px, 가운데 0.5px 어긋났다. */
            className="arena-match-toggle flex w-full cursor-pointer items-center gap-[11px] px-3.5 py-2.5 text-left transition hover:bg-ink-800/25"
          >
            {/* ★ 폭을 112px 로 고정한다. 스코어가 모든 줄에서 같은 x 에 서야 훑을 수 있다.
                말줄임(truncate)은 **안쪽** 에 건다 — flex 아이템 자신에 걸면 overflow 때문에
                글자 밑선 대신 박스 아래 모서리를 내놓아 baseline 정렬이 깨진다. */}
            <span title={labelOf(m.head)} className="record-match-event flex-none text-ink-200">
              <span className="record-match-clip">{labelOf(m.head)}</span>
            </span>

            {isAlly ? (
              <span className="flex-none whitespace-nowrap">
                <span className="text-xs" style={{ color: X_TEXT }}>{x.display_name}</span>
                <span className="mx-1.5 text-[11px] text-ink-600">·</span>
                <span className="text-xs" style={{ color: Y_TEXT }}>{y.display_name}</span>
                <span
                  className="tabular ml-2 text-sm font-bold"
                  style={{ color: allyWins >= allyLosses ? WIN : Y_DOT }}
                >
                  {multi ? `함께 ${allyWins}승 ${allyLosses}패` : allyWins > 0 ? "함께 승" : "함께 패"}
                </span>
              </span>
            ) : (
              <span className="flex-none inline-flex items-center gap-[7px] whitespace-nowrap">
                <span className="text-xs" style={{ color: X_TEXT }}>{x.display_name}</span>
                <span className="tabular text-[15px] font-bold" style={{ color: m.xSets >= m.ySets ? X_TEXT : DEAD }}>
                  {m.xSets}
                </span>
                <span className="text-[11px] font-normal text-ink-600">:</span>
                <span className="tabular text-[15px] font-bold" style={{ color: m.ySets >= m.xSets ? Y_TEXT : DEAD }}>
                  {m.ySets}
                </span>
                <span className="text-xs" style={{ color: Y_TEXT }}>{y.display_name}</span>
              </span>
            )}

            {isAlly && (
              <span className="flex-none rounded border border-ink-700 bg-ink-800 px-1.5 py-px text-[10px] text-ink-400">
                같은 팀
              </span>
            )}
            {/* ★ 조건부로 감싸지 않는다. 예전엔 `{(multi || best_of) && …}` 라 단판 줄만 칩이
                없어서, 같은 경기가 개인 기록에는 `단판` 으로 여기에는 아무것도 없이 나왔다. */}
            <span className="tabular ml-auto flex-none rounded border border-ink-700 px-1.5 py-px text-[10px] text-ink-400">
              {formatBadge(m.head.best_of, m.sets.length, m.sets.length === 1 && isStandaloneSet(m.head.match_id, m.series))}
            </span>
            {/* ▸/▾ 는 Pretendard 서브셋에 글리프가 없어 안 그려진다 — +/− 를 쓴다 */}
            {/* 글자가 아니라 아이콘 상자라 밑선이 아니라 가운데로 맞춘다. */}
            <span className="inline-flex h-[18px] w-[18px] flex-none self-center items-center justify-center rounded-[5px] border border-ink-700 text-[11px] leading-none text-ink-400">
              {open ? "−" : "+"}
            </span>
          </button>

          {open && <MatchDetails
            sets={m.sets.map((s,index)=>({matchId:s.match_id,label:setLabel({standalone:isStandaloneSet(s.match_id,s.series_key),best_of:s.best_of,set_order_known:s.set_order_known,series_game_no:s.series_game_no}),players:roster.get(s.match_id) ?? []}))}
            streamerId={streamerId} highlightedStreamerIds={[x.streamer_id,y.streamer_id]} />}
        </div>
      </div>
    </div>
  );
}
