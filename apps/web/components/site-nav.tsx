"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export interface SiteNavRoute {
  path: string;
  title: string;
  /** 이 주소들에서도 불을 켠다(전적 검색 ↔ 상대전적처럼 한 메뉴가 두 화면을 맡을 때). */
  activePaths?: string[];
  /** 이 앞부분으로 시작하는 주소에서도 불을 켠다(홈 메뉴 ↔ 프로필). */
  activePrefixes?: string[];
  /** 게임 홈처럼 모든 주소의 앞부분인 메뉴. 하위 주소로 불을 켜지 않는다. */
  exact?: boolean;
}

export function SiteNav({ routes }: { routes: SiteNavRoute[] }) {
  const pathname = usePathname();
  return <nav className="arena-nav" aria-label="주요 메뉴">
    {routes.map((route) => {
      const active = pathname === route.path || route.activePaths?.includes(pathname)
        || route.activePrefixes?.some((prefix) => pathname.startsWith(prefix))
        || (!route.exact && pathname.startsWith(`${route.path}/`));
      return <Link key={route.path} href={route.path} aria-current={active ? "page" : undefined}>{route.title}</Link>;
    })}
  </nav>;
}
