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
 *
 * ★ 승률 계산은 core 가 단일 출처다 (§11-6)
 *   rawWinRate·affinity·isSmallSample 을 여기서 다시 구현하지 않는다.
 */

import Link from "next/link";
import { useMemo, useState } from "react";

import {
  affinity, isSmallSample, rawWinRate, SMALL_SAMPLE_THRESHOLD,
} from "@soop-lol/core/lib/metrics/affinity";
import { POSITION_LABEL, QUEUE_LABEL, type Position } from "@soop-lol/core/lib/riot/types";

// ── 화면에 오는 모양 ─────────────────────────────────────────────────

export interface VersusSet {
  match_id: string;
  series_key: string;
  series_game_no: number | null;
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

export interface RosterEntry {
  match_id: string;
  streamer_id: string;
  slug: string;
  display_name: string;
  team_id: number;
  team_name: string | null;
  team_position: string | null;
  champion_name: string | null;
  champion_id: number;
  win: boolean;
  kills: number; deaths: number; assists: number;
}

interface Props {
  x: { slug: string; display_name: string; streamer_id: string };
  y: { slug: string; display_name: string; streamer_id: string };
  sets: VersusSet[];
  rosters: RosterEntry[];
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
      const sorted = [...list].sort((a, b) => (a.series_game_no ?? 0) - (b.series_game_no ?? 0));
      const xSets = sorted.filter((s) => s.xWin).length;
      return {
        series, sets: sorted, xSets, ySets: sorted.length - xSets,
        xWin: xSets * 2 > sorted.length,
        draw: xSets * 2 === sorted.length,
        date: sorted[0].played_at.slice(0, 10),
        head: sorted[0],
      };
    })
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

const setRecord = (rows: VersusSet[]) => ({
  wins: rows.filter((s) => s.xWin).length,
  losses: rows.filter((s) => !s.xWin).length,
});

const matchRecord = (rows: VersusSet[]) => {
  const m = foldMatches(rows);
  return { wins: m.filter((g) => g.xWin).length, losses: m.filter((g) => !g.xWin && !g.draw).length };
};

const ymd = (iso: string) => iso.slice(0, 10).replace(/-/g, ".");

function relative(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return "오늘";
  if (days === 1) return "어제";
  if (days < 30) return `${days}일 전`;
  if (days < 365) return `${Math.floor(days / 30)}달 전`;
  return `${Math.floor(days / 365)}년 전`;
}

const kda = (k: number | null, d: number | null, a: number | null) =>
  k == null && d == null && a == null ? "—" : `${k ?? 0}/${d ?? 0}/${a ?? 0}`;

/** 줄 왼쪽 112px 칸에 들어갈 이름. 대회면 대회명, 아니면 큐 이름. */
const labelOf = (s: VersusSet) =>
  s.event_name ?? QUEUE_LABEL[s.queue_id] ?? `큐 ${s.queue_id}`;

// ── 작은 조각 ────────────────────────────────────────────────────────

function Chip({ on, children, onClick }: { on: boolean; children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`tabular cursor-pointer rounded-full border px-[11px] py-1 text-[11px] transition ${
        on ? "border-accent-500 bg-accent-500/15 text-accent-400" : "border-ink-700 text-ink-400 hover:text-ink-200"
      }`}
    >
      {children}
    </button>
  );
}

function Dot({ color }: { color: string }) {
  return <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />;
}

// ── 지표 카드 ────────────────────────────────────────────────────────

function MetricCard({
  title, rec, setRec, isAlly, unit, lane, xName, yName,
}: {
  title: string;
  rec: { wins: number; losses: number };
  setRec: { wins: number; losses: number };
  isAlly: boolean;
  unit: string;
  lane: { wins: number; losses: number } | null;
  xName: string; yName: string;
}) {
  const n = rec.wins + rec.losses;
  const small = isSmallSample(rec);
  const p = Math.round((rawWinRate(rec) ?? 0) * 100);

  // ★ 경고는 **작게, 툴팁으로**. 예전 화면은 같은 경고를 세 번 반복해서
  //   정작 숫자보다 경고가 눈에 먼저 들어왔다.
  const flag = n === 0 ? "기록 없음" : small ? `참고용 ${n}${unit}` : isAlly ? `${p}%` : `${p}% : ${100 - p}%`;
  const tip = small
    ? `표본 ${n}${unit}. ${SMALL_SAMPLE_THRESHOLD} 미만이라 승률이 크게 흔들립니다 — 정렬에는 보정값 ${affinity(rec).toFixed(2)} 을 씁니다.`
    : isAlly
      ? `두 사람이 같은 팀이었던 ${n}${unit} 중 ${rec.wins}${unit}을 함께 이겼습니다 (${p}%).`
      : `${xName} ${p}% · ${yName} ${100 - p}% · ${n}${unit}`;

  const laneN = lane ? lane.wins + lane.losses : 0;
  const laneP = lane ? Math.round((rawWinRate(lane) ?? 0) * 100) : 0;
  const laneSmall = lane ? isSmallSample(lane) : false;

  return (
    <div className="mt-[18px] rounded-xl border border-ink-700 bg-ink-900/55 px-4 py-[14px]">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs text-ink-200">{title}</span>
        <span title={tip} className={`cursor-default text-[11px] ${small ? "text-amber-300" : "text-ink-400"}`}>
          {flag}
        </span>
      </div>
      <div className="mt-[9px] flex items-baseline gap-3">
        <span className="tabular text-[19px] font-bold text-ink-200">
          {isAlly ? `${rec.wins}승 ${rec.losses}패` : `${rec.wins} : ${rec.losses}`}
        </span>
        <span className="tabular text-xs text-ink-400">
          세트 {isAlly ? `${setRec.wins}승 ${setRec.losses}패` : `${setRec.wins} : ${setRec.losses}`}
        </span>
      </div>
      <div className="mt-[10px] flex h-1.5 overflow-hidden rounded-full bg-ink-800">
        <div style={{ background: isAlly ? WIN : X_DOT, width: `${n ? (rec.wins / n) * 100 : 50}%` }} />
        <div style={{ background: isAlly ? Y_DOT : Y_DOT, width: `${n ? (rec.losses / n) * 100 : 50}%` }} />
      </div>

      {lane && laneN > 0 && (
        <div className="mt-3 flex items-center gap-2.5 border-t border-ink-800 pt-[11px]">
          <span className="whitespace-nowrap text-[11px] text-ink-400">그중 맞라인 1:1</span>
          <span className="tabular whitespace-nowrap text-[13px] font-semibold text-ink-200">
            {lane.wins} : {lane.losses}
          </span>
          <span className="flex h-[5px] flex-1 overflow-hidden rounded-full bg-ink-800">
            <span style={{ background: X_DOT, width: `${(lane.wins / laneN) * 100}%` }} />
            <span style={{ background: Y_DOT, width: `${(lane.losses / laneN) * 100}%` }} />
          </span>
          <span
            title={laneSmall ? `표본 ${laneN}판. 참고용입니다.` : `${xName} ${laneP}% · ${yName} ${100 - laneP}%`}
            className={`cursor-default whitespace-nowrap text-[11px] ${laneSmall ? "text-amber-300" : "text-ink-400"}`}
          >
            {laneSmall ? `참고용 ${laneN}판` : `${laneP}%`}
          </span>
        </div>
      )}

      {isAlly && (
        <p className="mt-3 border-t border-ink-800 pt-[11px] text-[11px] leading-relaxed text-ink-400">
          상대전적에 섞지 않는다 — 같은 팀 승리는 &ldquo;그 사람을 이긴 것&rdquo;이 아니다.
        </p>
      )}
    </div>
  );
}

// ── 흐름 차트 ────────────────────────────────────────────────────────

function FlowChart({
  matches, isAlly, xName, yName,
}: { matches: Match[]; isAlly: boolean; xName: string; yName: string }) {
  // 오래된 순으로 월 단위로 접는다. **만난 적 없는 달은 축에서 뺀다** —
  // 빈 달까지 그리면 쉬어간 기간이 흐름처럼 보인다.
  const months = useMemo(() => {
    const out: { key: string; w: number; l: number }[] = [];
    for (const g of [...matches].reverse()) {
      const key = g.date.slice(0, 7);
      let cur = out[out.length - 1];
      if (!cur || cur.key !== key) { cur = { key, w: 0, l: 0 }; out.push(cur); }
      if (!g.draw) g.xWin ? cur.w++ : cur.l++;
    }
    return out;
  }, [matches]);

  const pts = useMemo(() => {
    let acc = 0;
    return months.map((mo) => { acc += mo.w - mo.l; return { v: acc, mo }; });
  }, [months]);

  if (pts.length === 0) {
    return (
      <div className="mt-3 flex h-[186px] items-center justify-center rounded-xl border border-dashed border-ink-800 text-[13px] text-ink-400">
        그릴 경기가 없습니다.
      </div>
    );
  }

  // ★ 기준점(동률)은 **항상 정중앙**이다. 위아래를 같은 폭으로 잡아야
  //   "9승 9패면 가운데" 가 눈으로도 참이 된다.
  const span = Math.max(1, ...pts.map((p) => Math.abs(p.v))) + 1;
  const X = (i: number) => (pts.length <= 1 ? 500 : 34 + (i / (pts.length - 1)) * 932);
  const Y = (v: number) => 100 - (v / span) * 100;
  const line = `M0,100 L${pts.map((p, i) => `${X(i).toFixed(1)},${Y(p.v).toFixed(1)}`).join(" L")}`;
  const area = `${line} L${X(pts.length - 1).toFixed(1)},100 Z`;
  const now = pts[pts.length - 1].v;

  let prevYear: string | null = null;
  const strip = pts.map((p) => {
    const [yy, mm] = p.mo.key.split("-");
    const newYear = yy !== prevYear;
    prevYear = yy;
    return {
      key: p.mo.key,
      tick: newYear ? `${yy.slice(2)}.${Number(mm)}` : `${Number(mm)}`,
      strong: newYear,
      tip: `${yy}.${mm} · ${xName} ${p.mo.w} : ${p.mo.l} ${yName} · 누적 ${p.v > 0 ? "+" : ""}${p.v}`,
    };
  });

  return (
    <>
      <div className="relative mt-3 h-[186px] overflow-hidden rounded-xl border border-ink-800 bg-ink-900/50">
        <svg viewBox="0 0 1000 200" preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
          <defs>
            <linearGradient id="vsFlowFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={X_DOT} stopOpacity="0.30" />
              <stop offset="100%" stopColor={X_DOT} stopOpacity="0.02" />
            </linearGradient>
          </defs>
          <path d={area} fill="url(#vsFlowFill)" />
          <path
            d={line} fill="none" stroke={X_DOT} strokeWidth="2"
            vectorEffect="non-scaling-stroke" strokeLinejoin="round"
          />
        </svg>
        <span className="absolute inset-x-0 top-1/2 h-0 border-t border-dashed border-ink-600" />
        <span className="absolute left-3 top-[calc(50%-18px)] text-[10px] text-ink-400">기준점 · 동률</span>
        <span className="absolute left-3 top-[9px] text-[10px]" style={{ color: WIN }}>
          {isAlly ? "같이 이김" : `${xName} 앞섬`}
        </span>
        <span className="absolute bottom-[9px] left-3 text-[10px]" style={{ color: Y_DOT }}>
          {isAlly ? "같이 짐" : `${yName} 앞섬`}
        </span>
        <span
          className="tabular absolute right-3 top-[9px] text-[11px] font-semibold"
          style={{ color: now === 0 ? "#6b7280" : now > 0 ? WIN : Y_DOT }}
        >
          {now > 0 ? `+${now}` : now}
        </span>
      </div>

      <div className="mt-2 flex gap-0.5">
        {strip.map((s) => (
          <span
            key={s.key}
            title={s.tip}
            className={`tabular flex-1 cursor-default overflow-hidden whitespace-nowrap text-center text-[10px] leading-tight ${
              s.strong ? "text-ink-200" : "text-ink-400"
            }`}
          >
            {s.tick}
          </span>
        ))}
      </div>
      <p className="mt-[7px] text-[10px] text-ink-400">
        한 칸이 한 달이다. 만난 적 없는 달은 건너뛴다 — 빈 달까지 그리면 쉬어간 기간이 흐름처럼 보인다.
      </p>
    </>
  );
}

// ── 본체 ─────────────────────────────────────────────────────────────

export function VersusView({ x, y, sets, rosters }: Props) {
  const [rel, setRel] = useState<"o" | "a">("o");
  const [year, setYear] = useState<"all" | string>("all");
  const [sort, setSort] = useState<"recent" | "oldest">("recent");
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const isAlly = rel === "a";

  const years = useMemo(
    () => [...new Set(sets.map((s) => s.played_at.slice(0, 4)))].sort().reverse(),
    [sets],
  );

  const scoped = useMemo(
    () => sets.filter((s) => year === "all" || s.played_at.slice(0, 4) === year),
    [sets, year],
  );
  const sel = useMemo(
    () => scoped.filter((s) => (isAlly ? s.relation === "ally" : s.relation === "opponent")),
    [scoped, isAlly],
  );
  const laneSets = useMemo(() => scoped.filter((s) => s.is_lane_matchup), [scoped]);

  const mRec = matchRecord(sel);
  const sRec = setRecord(sel);
  const laneRec = laneSets.length > 0 ? setRecord(laneSets) : null;

  const matches = useMemo(() => {
    const m = foldMatches(sel);
    return sort === "oldest" ? [...m].reverse() : m;
  }, [sel, sort]);

  const rosterByMatch = useMemo(() => {
    const by = new Map<string, RosterEntry[]>();
    for (const r of rosters) {
      const cur = by.get(r.match_id) ?? [];
      cur.push(r);
      by.set(r.match_id, cur);
    }
    return by;
  }, [rosters]);

  const firstMet = sel.length > 0 ? [...sel].sort((a, b) => (a.played_at < b.played_at ? -1 : 1))[0] : null;

  // 연도 헤더를 끼워 넣는다.
  const rows: ({ kind: "year"; year: string; summary: string } | { kind: "match"; m: Match })[] = [];
  {
    let cur: string | null = null;
    for (const m of matches) {
      const yy = m.date.slice(0, 4);
      if (yy !== cur) {
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
      rows.push({ kind: "match", m });
    }
  }

  return (
    <>
      {/* ── 히어로 밴드 ── */}
      <section className="border-b border-ink-800 bg-[linear-gradient(180deg,#12151f_0%,#0a0b0f_100%)]">
        <div className="mx-auto box-border max-w-[1120px] px-6 pb-[26px] pt-[34px]">
          <div className="grid items-start gap-[34px] lg:grid-cols-[352px_minmax(0,1fr)]">
            {/* 좌측 */}
            <div>
              <p className="text-[11px] tracking-[0.14em] text-ink-400">
                상대전적 · {year === "all" ? "통산" : year}
              </p>
              <h1 className="mt-2.5 flex flex-wrap items-center gap-2 text-[22px] font-semibold leading-[1.3]">
                <span className="inline-flex items-center gap-[7px]">
                  <Dot color={X_DOT} />
                  <Link href={`/s/${x.slug}`} className="text-ink-200 hover:text-accent-400">{x.display_name}</Link>
                </span>
                <span className="font-normal text-ink-400">vs</span>
                <span className="inline-flex items-center gap-[7px]">
                  <Dot color={Y_DOT} />
                  <Link href={`/s/${y.slug}`} className="text-ink-200 hover:text-accent-400">{y.display_name}</Link>
                </span>
              </h1>

              {/* 관계는 이진이다 — '전체' 는 없다. 섞는 순간 "이겼다" 의 뜻이 달라진다. */}
              <div className="mt-[13px] inline-flex rounded-full border border-ink-700 bg-ink-900 p-[3px]">
                {([["o", "상대전적"], ["a", "같은 팀"]] as const).map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setRel(k)}
                    className={`cursor-pointer rounded-full px-[15px] py-1.5 text-xs font-medium transition ${
                      rel === k ? "bg-ink-200 text-ink-950" : "text-ink-400 hover:text-ink-200"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <div className="tabular mt-4 flex items-end gap-3">
                <div>
                  <div
                    className="text-[58px] font-bold leading-[0.9]"
                    style={{ color: isAlly ? WIN : mRec.wins >= mRec.losses ? X_TEXT : DEAD }}
                  >
                    {mRec.wins}
                  </div>
                  <div className="mt-1.5 text-[11px] text-ink-400">{isAlly ? "함께 승" : x.display_name}</div>
                </div>
                <span className="pb-[22px] text-2xl font-light leading-[1.5] text-ink-600">:</span>
                <div>
                  <div
                    className="text-[58px] font-bold leading-[0.9]"
                    style={{ color: isAlly ? Y_DOT : mRec.losses >= mRec.wins ? Y_TEXT : DEAD }}
                  >
                    {mRec.losses}
                  </div>
                  <div className="mt-1.5 text-[11px] text-ink-400">{isAlly ? "함께 패" : y.display_name}</div>
                </div>
              </div>
              <p className="tabular mt-2.5 text-xs text-ink-400">
                {year === "all" ? "통산" : year} {isAlly ? "같은 팀" : "맞대결"} ·{" "}
                {mRec.wins + mRec.losses}경기 {sRec.wins + sRec.losses}세트
                {firstMet && ` · 처음 만난 날 ${ymd(firstMet.played_at)}`}
              </p>

              <MetricCard
                title={isAlly ? "같은 팀이었을 때" : "맞붙었을 때"}
                rec={mRec} setRec={sRec} isAlly={isAlly} unit="경기"
                lane={isAlly ? null : laneRec}
                xName={x.display_name} yName={y.display_name}
              />
            </div>

            {/* 우측 — 흐름 */}
            <div>
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="text-xs font-semibold text-ink-200">
                  흐름 <span className="font-normal text-ink-400">— {isAlly ? "같은 팀 승패 누적" : "맞대결 승패 누적"}</span>
                </h2>
                <div className="flex items-center gap-1.5">
                  <Chip on={year === "all"} onClick={() => setYear("all")}>통산</Chip>
                  {years.map((yy) => (
                    <Chip key={yy} on={year === yy} onClick={() => setYear(yy)}>{yy}</Chip>
                  ))}
                </div>
              </div>
              <FlowChart matches={foldMatches(sel)} isAlly={isAlly} xName={x.display_name} yName={y.display_name} />
            </div>
          </div>
        </div>
      </section>

      {/* ── 연대기 ── */}
      <main className="mx-auto box-border w-full max-w-[1120px] flex-1 px-6 pb-12 pt-[26px]">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <h2 className="text-[15px] font-semibold text-ink-200">
            연대기 <span className="tabular ml-1.5 text-xs font-normal text-ink-400">{matches.length}경기</span>
          </h2>
          <div className="flex flex-nowrap items-center gap-3">
            <span className="whitespace-nowrap text-[11px] text-ink-400">
              {isAlly ? "같은 팀이었던 경기만" : "상대편으로 만난 경기만"}
            </span>
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[11px] text-ink-400">
              <span className="h-[7px] w-[7px] rounded-full" style={{ background: isAlly ? WIN : X_DOT }} />
              {isAlly ? "함께 승" : x.display_name}
              <span className="ml-1 h-[7px] w-[7px] rounded-full" style={{ background: Y_DOT }} />
              {isAlly ? "함께 패" : y.display_name}
            </span>
            {([["recent", "최신순"], ["oldest", "오래된순"]] as const).map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => setSort(k)}
                className={`cursor-pointer rounded-lg border px-[11px] py-[5px] text-xs transition ${
                  sort === k ? "border-accent-500 bg-accent-500/15 text-accent-400" : "border-ink-700 text-ink-400 hover:text-ink-200"
                }`}
              >
                {label}
              </button>
            ))}
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
                <div key={`y-${row.year}`} className="grid grid-cols-[96px_30px_minmax(0,1fr)] items-center pb-2 pt-5">
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
                  isAlly={isAlly}
                  x={x} y={y}
                  open={!!open[row.m.series]}
                  onToggle={() => setOpen((s) => ({ ...s, [row.m.series]: !s[row.m.series] }))}
                  roster={rosterByMatch}
                />
              ),
            )
          )}
        </div>

        <p className="mt-[18px] text-[11px] leading-[1.7] text-ink-400">
          상대편 전적과 같은 팀 전적을 섞지 않습니다 — 같은 팀 승리를 상대전적에 넣으면 &ldquo;이겼다&rdquo;의 뜻이 달라집니다.
          표본이 {SMALL_SAMPLE_THRESHOLD}경기 미만인 칸에는 <span className="text-amber-300">참고용</span> 표시를 답니다.
          포지션 추론이 어긋난 경기는 맞라인에서 제외합니다.
        </p>
      </main>
    </>
  );
}

// ── 경기 한 줄 ───────────────────────────────────────────────────────

function MatchRow({
  m, isAlly, x, y, open, onToggle, roster,
}: {
  m: Match;
  isAlly: boolean;
  x: Props["x"]; y: Props["y"];
  open: boolean;
  onToggle: () => void;
  roster: Map<string, RosterEntry[]>;
}) {
  const multi = m.sets.length > 1;
  const manual = m.head.source === "manual";
  const dot = isAlly ? "#2f3546" : m.draw ? "#2f3546" : m.xWin ? X_DOT : Y_DOT;
  const cardBorder = isAlly || m.draw ? "#1c2030" : m.xWin ? "rgba(56,189,248,0.26)" : "rgba(248,113,113,0.26)";
  const cardBg = isAlly || m.draw ? "rgba(16,18,25,0.6)" : m.xWin ? "rgba(56,189,248,0.05)" : "rgba(248,113,113,0.045)";

  // 같은 팀 모드는 둘이 함께 이겼는지를 센다 — 사람 색을 쓰지 않는다.
  const allyWins = m.sets.filter((s) => s.xWin).length;
  const allyLosses = m.sets.length - allyWins;

  return (
    <div className="grid grid-cols-[96px_30px_minmax(0,1fr)] items-stretch">
      <div className="tabular py-[11px] pr-4 text-right text-xs text-ink-400">{ymd(m.date)}</div>
      <div className="relative flex justify-center">
        <span className="h-full w-px bg-ink-700" />
        <span
          className="absolute top-[15px] h-[11px] w-[11px] rounded-full border-2 border-ink-950"
          style={{ background: dot }}
        />
      </div>
      <div className="py-1 pl-4">
        <div className="overflow-hidden rounded-xl border" style={{ borderColor: cardBorder, background: cardBg }}>
          <button
            type="button"
            onClick={onToggle}
            className="flex w-full cursor-pointer items-center gap-[11px] px-3.5 py-2.5 text-left transition hover:bg-ink-800/25"
          >
            {/* ★ 폭을 112px 로 고정한다. 스코어가 모든 줄에서 같은 x 에 서야 훑을 수 있다. */}
            <span title={labelOf(m.head)} className="w-28 flex-none truncate text-[13px] text-ink-200">
              {labelOf(m.head)}
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
              <span className="flex-none inline-flex items-baseline gap-[7px] whitespace-nowrap">
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
            {manual && (
              <span
                title="Riot API 로 조회되지 않는 내전이라 방송 기록을 보고 손으로 넣었습니다"
                className="flex-none cursor-help rounded border border-ink-600 bg-ink-800 px-1.5 py-px text-[10px] text-ink-200"
              >
                수기
              </span>
            )}
            {multi && (
              <span className="tabular flex-none rounded border border-ink-700 px-1.5 py-px text-[10px] text-ink-400">
                {m.sets.length}세트
              </span>
            )}
            <span className="ml-auto w-16 flex-none text-right text-[11px] text-ink-400">{relative(m.head.played_at)}</span>
            {/* ▸/▾ 는 Pretendard 서브셋에 글리프가 없어 안 그려진다 — +/− 를 쓴다 */}
            <span className="inline-flex h-[18px] w-[18px] flex-none items-center justify-center rounded-[5px] border border-ink-700 text-[11px] leading-none text-ink-400">
              {open ? "−" : "+"}
            </span>
          </button>

          {open && <ExpandPanel m={m} x={x} y={y} roster={roster} />}
        </div>
      </div>
    </div>
  );
}

// ── 펼침 패널 ────────────────────────────────────────────────────────

function ExpandPanel({
  m, x, y, roster,
}: { m: Match; x: Props["x"]; y: Props["y"]; roster: Map<string, RosterEntry[]> }) {
  const first = m.sets[0];
  const entries = roster.get(first.match_id) ?? [];
  const teams = [100, 200].map((tid) => entries.filter((e) => e.team_id === tid));

  const nameColor = (slug: string) => (slug === x.slug ? X_TEXT : slug === y.slug ? Y_TEXT : "#c7ccd8");

  return (
    <div className="grid gap-3.5 border-t border-[#1c2030] p-3.5">
      {entries.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {teams.map((team, i) => (
            <div key={i} className="rounded-[10px] border border-[#1c2030] bg-ink-950/50 px-[13px] py-[11px]">
              <div className="flex items-center gap-[7px]">
                <span
                  className="h-[7px] w-[7px] rounded-sm"
                  style={{ background: i === 0 ? X_DOT : Y_DOT }}
                />
                {/* 대회 경기는 팀에 이름이 있다. 공개 큐는 없으므로 블루/레드로 부른다. */}
                <span className="text-[11px] text-ink-200">
                  {team[0]?.team_name ?? (i === 0 ? "블루" : "레드")}
                </span>
                {team.length > 0 && (
                  <span
                    className="ml-auto text-[11px] font-semibold"
                    style={{ color: team[0].win ? WIN : "#6b7280" }}
                  >
                    {team[0].win ? "승" : "패"}
                  </span>
                )}
              </div>
              <div className="mt-[9px] grid gap-[5px]">
                {team.length === 0 ? (
                  <p className="text-[11px] leading-relaxed text-ink-400">
                    이 경기에서 계정이 확인된 스트리머가 없습니다 — 우리가 아는 사람이 아니면 적지 않습니다.
                  </p>
                ) : (
                  team.map((p) => (
                    <div key={p.streamer_id} className="flex items-center gap-2 text-xs">
                      <span className="w-[34px] flex-none text-[10px] text-ink-400">
                        {POSITION_LABEL[p.team_position as Position] ?? "—"}
                      </span>
                      <Link
                        href={`/s/${p.slug}`}
                        className="truncate hover:underline"
                        style={{ color: nameColor(p.slug) }}
                      >
                        {p.display_name}
                      </Link>
                      {p.champion_name && (
                        <span className="flex-none text-[10px] text-ink-400">{p.champion_name}</span>
                      )}
                      <span className="tabular ml-auto flex-none text-[11px] text-ink-400">
                        {kda(p.kills, p.deaths, p.assists)}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <div>
        <div className="text-[11px] text-ink-400">세트별 전적</div>
        <div className="mt-2 grid gap-1">
          {m.sets.map((s, i) => (
            <div
              key={s.match_id}
              className="grid grid-cols-[56px_1fr_1fr] items-center gap-2.5 rounded-lg bg-ink-800/45 px-[11px] py-[7px]"
            >
              <span className="tabular text-[11px] text-ink-400">
                {s.series_game_no ? `${s.series_game_no}세트` : m.sets.length > 1 ? `${i + 1}세트` : "단판"}
              </span>
              {([[s.xWin, x.display_name, X_TEXT, kda(s.xK, s.xD, s.xA), s.xPos],
                 [s.yWin, y.display_name, Y_TEXT, kda(s.yK, s.yD, s.yA), s.yPos]] as const).map(
                ([win, name, color, k, pos], j) => (
                  <span key={j} className="flex items-center gap-[9px]">
                    <span
                      className="w-[26px] flex-none rounded text-center text-[11px] font-semibold"
                      style={win
                        ? { background: j === 0 ? "rgba(56,189,248,0.18)" : "rgba(248,113,113,0.18)", color }
                        : { color: DEAD }}
                    >
                      {win ? "승" : "패"}
                    </span>
                    <span className="truncate text-xs" style={{ color }}>{name}</span>
                    {pos && (
                      <span className="flex-none text-[10px] text-ink-400">
                        {POSITION_LABEL[pos as Position] ?? pos}
                      </span>
                    )}
                    <span className="tabular ml-auto flex-none text-[11px] text-ink-400">{k}</span>
                  </span>
                ),
              )}
            </div>
          ))}
        </div>
        <p className="mt-[9px] text-[10px] leading-relaxed text-ink-400">
          {first.source === "manual"
            ? "Riot API 로 조회되지 않는 내전이라 방송 결과 화면을 보고 손으로 넣었습니다. 챔피언·KDA 가 비어 있으면 그 화면을 못 구한 것입니다."
            : "Riot match-v5 에서 받은 기록입니다."}
        </p>
      </div>
    </div>
  );
}
