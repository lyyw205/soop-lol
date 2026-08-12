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
import { formatRank } from "@soop-lol/core/lib/metrics/lp";
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
        {/* ★ 이 사이트의 한 문장이 곧 이 링크다 — "스트리머끼리 누가 누구를 이겼나".
            실제 페이지는 /vs/<a>/<b> 라 두 slug 가 경로에 박혀 있어서 nav 로는 못 간다.
            /vs 가 고르는 화면이 되어 준다. */}
        <Link href="/vs" className="text-ink-400 hover:text-ink-200">상대전적</Link>
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

export function DualRecord({
  match, set, label,
}: { match: HeadToHead; set: HeadToHead; label?: string }) {
  const sameUnit = match.wins === set.wins && match.losses === set.losses;
  return (
    <div>
      <RecordBar record={match} label={label} />
      {!sameUnit && (
        <p className="tabular mt-2 text-[11px] text-ink-500">
          세트로는 {set.wins}승 {set.losses}패
          <span className="ml-1">({Math.round((rawWinRate(set) ?? 0) * 100)}%)</span>
        </p>
      )}
    </div>
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
        {/* ★ formatRecord 가 이미 괄호 승률을 포함한다. 뒤에 pct 를 또 찍어서
            화면에 "5승 2패 (71%) 71%" 로 나왔다. 표본이 작으면 formatRecord 의
            '· N경기 참고용' 과 옆 뱃지 '표본 N판 · 참고용' 까지 겹쳐 세 번 경고했다. */}
        <span className="tabular text-sm text-ink-200">{formatRecord(record)}</span>
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
