"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function SiteNav({ routes }: { routes: { path: string; title: string; activePaths?: string[] }[] }) {
  const pathname = usePathname();
  return <nav className="arena-nav" aria-label="주요 메뉴">
    {routes.map((route) => {
      const active = pathname === route.path || route.activePaths?.includes(pathname)
        || (route.path === "/" && pathname.startsWith("/s/"))
        || (route.path === "/fc" && pathname.startsWith("/fc/s/"))
        || (route.path !== "/" && route.path !== "/fc" && pathname.startsWith(`${route.path}/`));
      return <Link key={route.path} href={route.path} aria-current={active ? "page" : undefined}>{route.title}</Link>;
    })}
  </nav>;
}
