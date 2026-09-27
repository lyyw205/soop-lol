import Link from "next/link";
import { SiteNav } from "./site-nav";
import { versusIndexHref } from "@/lib/module-links";

import { moduleNavRoutes } from "@soop-lol/modules/registry";
import type { ReactNode } from "react";
// 표시 전용이라 packages/ui 에 산다. 여기서 다시 내보내 기존 import 경로를 지킨다.
import { EmptyLine } from "../../../packages/ui/empty-line";
export { EmptyLine };

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
  const versusPath = versusIndexHref();
  const moduleRoutes = moduleNavRoutes();
  const versusRoute = moduleRoutes.find((route) => route.path === versusPath);
  // core 메뉴와 모듈 메뉴를 navOrder 한 줄로 섞는다. 모듈 순서는 module.json 의 navOrder
  // (상대전적 10 · 대회 15) — 스트리머는 대회 뒤에 오도록 18 이다.
  const routes = [
    { path: "/", title: versusRoute ? "전적 검색" : "홈", activePaths: versusPath ? [versusPath] : [], navOrder: 0 },
    { path: "/streamers", title: "스트리머", navOrder: 18 },
    ...moduleRoutes.filter((route) => route.path !== versusPath),
  ].sort((a, b) => a.navOrder - b.navOrder);
  return (
    <header className="arena-header">
      <div className="arena-header-inner">
        <Link href="/" className="arena-brand" aria-label="SOOP LOL 홈"><span className="arena-brandmark">S</span>SOOP<span>LOL</span></Link>
        <GameSwitcher game="lol" />
        <SiteNav routes={routes} />
        <span className="arena-header-note">LEAGUE OF LEGENDS · 스트리머 기록실</span>
      </div>
    </header>
  );
}

export function GameSwitcher({ game }: { game: "lol" | "fconline" }) {
  return <details className="game-switcher">
    <summary aria-label="게임 선택">{game === "lol" ? "LOL" : "FC 온라인"}<span aria-hidden="true">⌄</span></summary>
    <div className="game-switcher-menu">
      <Link href="/" aria-current={game === "lol" ? "page" : undefined}>LOL</Link>
      <Link href="/fc" aria-current={game === "fconline" ? "page" : undefined}>FC 온라인</Link>
    </div>
  </details>;
}

export function PageShell({ children }: { children: ReactNode }) {
  return <main className="arena-shell">{children}</main>;
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

export function SectionTitle({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="mb-3 flex items-baseline justify-between gap-3">
      <h2 className="text-sm font-semibold text-ink-200">{children}</h2>
      {hint && <span className="text-[11px] text-ink-400">{hint}</span>}
    </div>
  );
}
