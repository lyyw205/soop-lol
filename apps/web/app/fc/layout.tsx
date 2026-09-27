import type { Metadata } from "next";
import Link from "next/link";
import { GameSwitcher, PageShell } from "@/components/public";
import { SiteNav } from "@/components/site-nav";
import { moduleNavRoutes } from "@soop-lol/modules/registry";
import { fcVersusIndexHref } from "@/lib/module-links";

export const metadata: Metadata = {
  title: { default: "SOOP FC 온라인", template: "%s · SOOP FC 온라인" },
  description: "SOOP 스트리머의 FC 온라인 개인기록, 상대전적, 대회와 경기 분석",
};

export default function FcLayout({ children }: { children: React.ReactNode }) {
  // LoL 머리말과 같은 규칙 — core 메뉴와 FC 모듈 메뉴를 navOrder 한 줄로 섞는다.
  // FC 상대전적은 '전적 검색' 안에 들어간다(그 화면에 있을 때 전적 검색이 켜진다).
  const versusPath = fcVersusIndexHref();
  const routes = [
    { path: "/fc", title: "전적 검색", activePaths: versusPath ? [versusPath] : [], navOrder: 0 },
    ...moduleNavRoutes("fconline").filter((route) => route.path !== versusPath),
  ].sort((a, b) => a.navOrder - b.navOrder);
  return <div className="fc-site">
    <header className="arena-header fc-header">
      <div className="arena-header-inner">
        <Link className="arena-brand" href="/fc" aria-label="SOOP FC 온라인 홈"><span className="arena-brandmark">S</span>SOOP<span>FC 온라인</span></Link>
        <GameSwitcher game="fconline" />
        <SiteNav routes={routes} />
        <span className="arena-header-note">FC ONLINE · 스트리머 기록실</span>
      </div>
    </header>
    <PageShell>{children}</PageShell>
  </div>;
}
