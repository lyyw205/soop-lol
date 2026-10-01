"use client";

import Link from "next/link";
import { Fragment } from "react";
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
  /** 누르면 갈 주소. 없으면 path. (게임 안의 플랫폼 메뉴는 `?game=` 를 붙여 보낸다 — 판정은 path 로 한다) */
  href?: string;
  /** 'platform' 이면 게임 메뉴와 구분선을 두고 뒤에 선다. */
  group?: "platform";
}

export function SiteNav({ routes }: { routes: SiteNavRoute[] }) {
  const pathname = usePathname();
  return <nav className="arena-nav" aria-label="주요 메뉴">
    {routes.map((route, i) => {
      const active = pathname === route.path || route.activePaths?.includes(pathname)
        || route.activePrefixes?.some((prefix) => pathname.startsWith(prefix))
        || (!route.exact && pathname.startsWith(`${route.path}/`));
      const divider = route.group === "platform" && i > 0 && routes[i - 1].group !== "platform";
      return <Fragment key={route.path}>
        {divider && <span className="arena-nav-divider" aria-hidden="true" />}
        <Link href={route.href ?? route.path} aria-current={active ? "page" : undefined}>{route.title}</Link>
      </Fragment>;
    })}
  </nav>;
}
