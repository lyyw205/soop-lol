import Link from "next/link";
import { SiteNav, type SiteNavRoute } from "./site-nav";
import { fcVersusIndexHref, versusIndexHref } from "@/lib/module-links";
import { gameHomeHref, lobbyHref, profilePrefix, streamersHref, type SiteGame } from "@soop-lol/core/lib/site-paths";

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

// ── 크롬 ─────────────────────────────────────────────────────────────

export type Site = "platform" | SiteGame;

const SITE_LABEL: Record<Site, string> = { platform: "전체", lol: "LOL", fconline: "FC 온라인" };
const SITE_NOTE: Record<Site, string> = {
  platform: "SOOP · 스트리머 기록실",
  lol: "LEAGUE OF LEGENDS · 스트리머 기록실",
  fconline: "FC ONLINE · 스트리머 기록실",
};
const siteHome = (site: Site) => site === "platform" ? lobbyHref() : gameHomeHref(site);

/**
 * 공간마다의 메뉴. core 메뉴와 그 공간의 모듈 메뉴를 navOrder 한 줄로 섞고, 게임 공간이면 끝에
 * 플랫폼(로비) 모듈 메뉴를 붙인다 — 게임 안에서 편성표를 누르면 그 게임 필터(`?game=`)가 걸린 채로 로비로 간다.
 * ★ 상대전적은 '전적 검색' 한 메뉴가 같이 맡는다(그 화면에서 전적 검색이 켜진다). 모듈이 없으면 그 자리는 그냥 사라진다.
 */
function siteRoutes(site: Site): SiteNavRoute[] {
  const platform: SiteNavRoute[] = moduleNavRoutes("platform").map((r) => ({
    path: r.path, title: r.title, group: "platform",
    href: site === "platform" ? r.path : `${r.path}?game=${site}`,
  }));
  if (site === "platform") return platform;
  const versusPath = site === "lol" ? versusIndexHref() : fcVersusIndexHref();
  const mods = moduleNavRoutes(site);
  const hasVersus = mods.some((r) => r.path === versusPath);
  // 모듈 순서는 module.json 의 navOrder(상대전적 10 · 대회 15) — 롤 스트리머 목록은 대회 뒤에 오도록 18 이다.
  const own = [
    { path: gameHomeHref(site), title: site === "lol" && !hasVersus ? "홈" : "전적 검색",
      activePaths: versusPath ? [versusPath] : [], activePrefixes: [profilePrefix(site)], exact: true, navOrder: 0 },
    ...(site === "lol" ? [{ path: streamersHref(), title: "스트리머", navOrder: 18 }] : []),
    ...mods.filter((r) => r.path !== versusPath),
  ].sort((a, b) => a.navOrder - b.navOrder);
  return [...own, ...platform];
}

/** 공개 화면 머리말. 로비·롤·FC 가 같은 부품을 쓴다 — 공간마다 따로 그리면 메뉴 규칙이 어긋난다. */
export function SiteHeader({ site }: { site: Site }) {
  return (
    <header className={site === "fconline" ? "arena-header fc-header" : "arena-header"}>
      <div className="arena-header-inner">
        <Link href={siteHome(site)} className="arena-brand" aria-label={site === "platform" ? "SOOP 홈" : `SOOP ${SITE_LABEL[site]} 홈`}>
          <span className="arena-brandmark">S</span>SOOP{site !== "platform" && <span>{SITE_LABEL[site]}</span>}
        </Link>
        <GameSwitcher site={site} />
        <SiteNav routes={siteRoutes(site)} />
        <span className="arena-header-note">{SITE_NOTE[site]}</span>
      </div>
    </header>
  );
}

export function GameSwitcher({ site }: { site: Site }) {
  return <details className="game-switcher">
    <summary aria-label="게임 선택">{SITE_LABEL[site]}<span aria-hidden="true">⌄</span></summary>
    <div className="game-switcher-menu">
      {(["platform", "lol", "fconline"] as const).map((s) =>
        <Link key={s} href={siteHome(s)} aria-current={site === s ? "page" : undefined}>{SITE_LABEL[s]}</Link>)}
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

export function RecordBar({ record, label }: { record: HeadToHead; label?: string }) {
  const n = record.wins + record.losses;
  if (n === 0) return <EmptyLine>{label ? `${label} 기록이 없습니다.` : "기록이 없습니다."}</EmptyLine>;

  const raw = rawWinRate(record) ?? 0;
  const small = isSmallSample(record);

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

export function SectionTitle({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="mb-3 flex items-baseline justify-between gap-3">
      <h2 className="text-sm font-semibold text-ink-200">{children}</h2>
      {hint && <span className="text-[11px] text-ink-400">{hint}</span>}
    </div>
  );
}
