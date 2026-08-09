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
