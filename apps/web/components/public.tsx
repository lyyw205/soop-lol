import Link from "next/link";
import type { ReactNode } from "react";

import {
  affinity,
  formatRecord,
  isSmallSample,
  rawWinRate,
  SMALL_SAMPLE_THRESHOLD,
  type HeadToHead,
} from "@soop-lol/core/lib/metrics/affinity";
import { formatRank, tierGridLines } from "@soop-lol/core/lib/metrics/lp";
import { POSITION_LABEL, QUEUE_LABEL, type Position } from "@soop-lol/core/lib/riot/types";

// ── 크롬 ─────────────────────────────────────────────────────────────

export function SiteHeader() {
  return (
    <header className="border-b border-ink-800">
      <nav className="mx-auto flex max-w-5xl items-center gap-6 px-6 py-4 text-sm">
        <Link href="/" className="font-semibold text-ink-200">
          SOOP <span className="text-accent-500">LOL</span>
        </Link>
        <Link href="/streamers" className="text-ink-400 hover:text-ink-200">스트리머</Link>
        <Link href="/m/leaderboard" className="text-ink-400 hover:text-ink-200">리더보드</Link>
      </nav>
    </header>
  );
}

export function PageShell({ children }: { children: ReactNode }) {
  return <main className="mx-auto max-w-5xl px-6 py-10">{children}</main>;
}

// ── 티어 ─────────────────────────────────────────────────────────────

export function RankChip({
  tier, division, leaguePoints,
}: { tier: string | null; division: string | null; leaguePoints: number | null }) {
  const label = formatRank({ tier, division, leaguePoints });
  const unranked = label === "언랭";
  return (
    <span
      className={`tabular rounded-md border px-2 py-0.5 text-xs ${
        unranked ? "border-ink-700 bg-ink-800 text-ink-400" : "border-accent-600/40 bg-accent-600/10 text-accent-400"
      }`}
    >
      {label}
    </span>
  );
}

/**
 * 티어 추이. 차트 라이브러리를 쓰지 않는다 — 선 하나에 라이브러리는 과하다.
 * 점이 하나뿐이면 그래프가 아니라 "아직 하루치" 라고 말한다.
 */
export function TierChart({
  points,
}: { points: { snapshot_date: string; lp_absolute: number | null }[] }) {
  const data = points.filter((p) => p.lp_absolute !== null) as { snapshot_date: string; lp_absolute: number }[];
  if (data.length === 0) return <EmptyLine>아직 랭크 기록이 없습니다.</EmptyLine>;
  if (data.length < 2) {
    return (
      <EmptyLine>
        오늘 하루치만 있습니다 — 추이는 매일 09:00 스냅샷이 쌓이면서 그려집니다.
      </EmptyLine>
    );
  }

  const W = 720, H = 180, PAD = { l: 46, r: 12, t: 12, b: 22 };
  const values = data.map((d) => d.lp_absolute);
  const min = Math.min(...values), max = Math.max(...values);
  const span = Math.max(max - min, 100);
  const lo = min - span * 0.15, hi = max + span * 0.15;

  const x = (i: number) => PAD.l + (i / (data.length - 1)) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b);

  const line = data.map((d, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(d.lp_absolute).toFixed(1)}`).join(" ");
  const area = `${line} L${x(data.length - 1).toFixed(1)},${H - PAD.b} L${x(0).toFixed(1)},${H - PAD.b} Z`;
  const grid = tierGridLines(lo, hi);
  const last = data[data.length - 1];

  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full min-w-[520px]" role="img"
           aria-label={`티어 추이, ${data.length}일치`}>
        {grid.map((g) => (
          <g key={g.value}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(g.value)} y2={y(g.value)}
                  stroke="currentColor" strokeWidth="1" className="text-ink-800" />
            <text x={PAD.l - 8} y={y(g.value) + 3} textAnchor="end"
                  className="fill-ink-400 text-[10px]">{g.label}</text>
          </g>
        ))}
        <path d={area} className="fill-accent-600/10" />
        <path d={line} fill="none" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"
              className="stroke-accent-500" />
        <circle cx={x(data.length - 1)} cy={y(last.lp_absolute)} r="3.5" className="fill-accent-400" />
        <text x={PAD.l} y={H - 6} className="fill-ink-400 text-[10px]">{data[0].snapshot_date}</text>
        <text x={W - PAD.r} y={H - 6} textAnchor="end" className="fill-ink-400 text-[10px]">
          {last.snapshot_date}
        </text>
      </svg>
    </div>
  );
}

// ── 전적 ─────────────────────────────────────────────────────────────

/**
 * ★ 이 컴포넌트가 §11-3 을 강제한다.
 *   3승 0패를 "승률 100%" 로 크게 쓰지 않는다. 표본 수를 **항상** 같이 보여주고,
 *   표본이 작으면 '참고용' 이라고 화면에 적는다. 재미 사이트라도 숫자로 거짓말하면 안 된다.
 */
/** 전적을 세는 단위. 주소창의 `?unit=set` 로 바뀐다. */
export type RecordUnit = "match" | "set";

export const UNIT_LABEL: Record<RecordUnit, string> = {
  match: "매치",
  set: "세트",
};

export const UNIT_HINT: Record<RecordUnit, string> = {
  match: "다전제 한 판을 1경기로 셉니다 (3판 2선승을 2:1 로 이기면 1승)",
  set: "다전제의 각 세트를 1판으로 셉니다 (3판 2선승을 2:1 로 이기면 2승 1패)",
};

/** 매치로 볼지 세트로 볼지 고르는 스위치. 링크라 자바스크립트가 필요 없다. */
export function UnitToggle({ unit, hrefFor }: { unit: RecordUnit; hrefFor: (u: RecordUnit) => string }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[11px] text-ink-400">단위</span>
      {(["match", "set"] as const).map((u) => (
        <Link
          key={u}
          href={hrefFor(u)}
          className={`rounded-full border px-3 py-1 text-xs ${
            unit === u
              ? "border-accent-400/50 bg-accent-400/10 text-accent-300"
              : "border-ink-800 text-ink-400 hover:text-ink-200"
          }`}
        >
          {UNIT_LABEL[u]}로 보기
        </Link>
      ))}
    </div>
  );
}

/**
 * 고른 단위로 전적을 그린다.
 *
 * 3판 2선승을 2:1 로 이기면 **매치로는 1승 0패, 세트로는 2승 1패**다.
 * 둘은 다른 사실이라 한 막대에 섞으면 둘 다 틀린다. 그래서 고른 쪽을 크게 그리고
 * 다른 쪽은 작은 글씨로 남긴다 — 지워버리면 "그럼 반대로 세면 몇이지?" 를 답할 수 없다.
 *
 * 전부 단판이면 두 수치가 같으므로 보조 줄을 그리지 않는다.
 * 같은 숫자를 두 번 쓰면 다른 뜻인 줄 오해한다.
 */
export function DualRecord({
  match, set, unit, label,
}: { match: HeadToHead; set: HeadToHead; unit: RecordUnit; label?: string }) {
  const shown = unit === "match" ? match : set;
  const other = unit === "match" ? set : match;
  const otherUnit: RecordUnit = unit === "match" ? "set" : "match";
  const sameUnit = match.wins === set.wins && match.losses === set.losses;

  return (
    <div>
      <RecordBar record={shown} label={label} />
      {!sameUnit && (other.wins + other.losses > 0) && (
        <p className="tabular mt-2 text-[11px] text-ink-500">
          {UNIT_LABEL[otherUnit]}로는 {other.wins}승 {other.losses}패
          <span className="ml-1">({Math.round((rawWinRate(other) ?? 0) * 100)}%)</span>
        </p>
      )}
    </div>
  );
}

export function SeriesLog({
  rows, label,
}: {
  rows: {
    series_key: string;
    played_at: Date | string;
    event_name: string | null;
    source: string;
    sets: number;
    set_wins: number;
    all_lane: boolean;
  }[];
  label: string;
}) {
  if (rows.length === 0) return null;
  return (
    <details className="mt-3 border-t border-ink-800 pt-2">
      <summary className="cursor-pointer text-[11px] text-ink-400 hover:text-ink-200">
        {label} {rows.length}경기 — 언제였는지 보기
      </summary>
      <ul className="mt-2 grid gap-1">
        {rows.map((r) => {
          const won = r.set_wins * 2 > r.sets;
          const d = new Date(r.played_at);
          return (
            <li key={r.series_key} className="flex flex-wrap items-baseline gap-x-2 text-[11px]">
              <span className={`tabular w-9 shrink-0 font-medium ${won ? "text-win" : "text-lose"}`}>
                {won ? "승" : "패"}
              </span>
              <span className="tabular w-20 shrink-0 text-ink-400">
                {d.getFullYear()}.{String(d.getMonth() + 1).padStart(2, "0")}.
                {String(d.getDate()).padStart(2, "0")}
              </span>
              <span className="tabular w-10 shrink-0 text-ink-300">
                {r.set_wins}:{r.sets - r.set_wins}
              </span>
              <span className="min-w-0 flex-1 truncate text-ink-400">
                {r.event_name ?? (r.source === "public_queue" ? "공개 큐" : "-")}
              </span>
              {r.all_lane && (
                <span className="shrink-0 rounded border border-ink-700 px-1 text-[10px] text-ink-400">
                  맞라인
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </details>
  );
}

export function RecordBar({ record, label }: { record: HeadToHead; label?: string }) {
  const n = record.wins + record.losses;
  if (n === 0) return <EmptyLine>{label ? `${label} 기록이 없습니다.` : "기록이 없습니다."}</EmptyLine>;

  const raw = rawWinRate(record) ?? 0;
  const small = isSmallSample(record);
  const pct = Math.round(raw * 100);

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="tabular text-sm text-ink-200">
          {formatRecord(record)}
          <span className="ml-2 text-ink-400">{pct}%</span>
        </span>
        {small && (
          <span className="rounded-md border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-[11px] text-amber-300">
            표본 {n}판 · 참고용
          </span>
        )}
      </div>
      <div className="mt-2 flex h-2 overflow-hidden rounded-full bg-ink-800">
        <div className="bg-win" style={{ width: `${raw * 100}%` }} />
        <div className="bg-lose" style={{ width: `${(1 - raw) * 100}%` }} />
      </div>
      {small && (
        <p className="mt-2 text-[11px] leading-relaxed text-ink-400">
          {SMALL_SAMPLE_THRESHOLD}판 미만이라 승률이 크게 흔들립니다.
          정렬에는 보정값({affinity(record).toFixed(2)})을 씁니다.
        </p>
      )}
    </div>
  );
}

export function Kda({ k, d, a }: { k: number; d: number; a: number }) {
  const ratio = d === 0 ? k + a : (k + a) / d;
  return (
    <span className="tabular text-xs text-ink-400">
      {k}/{d}/{a}
      <span className="ml-1.5 text-ink-200">{ratio.toFixed(2)}</span>
    </span>
  );
}

export function QueueTag({ queueId }: { queueId: number }) {
  return (
    <span className="rounded border border-ink-700 bg-ink-800 px-1.5 py-0.5 text-[11px] text-ink-400">
      {QUEUE_LABEL[queueId] ?? `큐 ${queueId}`}
    </span>
  );
}

export function PositionTag({ position }: { position: string | null }) {
  if (!position) return <span className="text-[11px] text-ink-400">—</span>;
  const label = POSITION_LABEL[position as Position] ?? position;
  return <span className="text-[11px] text-ink-400">{label}</span>;
}

export function WinPill({ win }: { win: boolean }) {
  return (
    <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${
      win ? "bg-win/15 text-win" : "bg-lose/15 text-lose"}`}>
      {win ? "승" : "패"}
    </span>
  );
}

export function EmptyLine({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed border-ink-700 px-4 py-6 text-center text-sm text-ink-400">{children}</p>;
}

export function SectionTitle({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="mb-3 flex items-baseline justify-between gap-3">
      <h2 className="text-sm font-semibold text-ink-200">{children}</h2>
      {hint && <span className="text-[11px] text-ink-400">{hint}</span>}
    </div>
  );
}

export function relativeDate(d: Date | string): string {
  const t = typeof d === "string" ? new Date(d) : d;
  const days = Math.floor((Date.now() - t.getTime()) / 86400000);
  if (days <= 0) return "오늘";
  if (days === 1) return "어제";
  if (days < 30) return `${days}일 전`;
  if (days < 365) return `${Math.floor(days / 30)}달 전`;
  return `${Math.floor(days / 365)}년 전`;
}
