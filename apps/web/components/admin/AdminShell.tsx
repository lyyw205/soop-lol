"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ClipboardCheck, Database, LayoutDashboard, ListChecks, Radio, Trophy, Users, CalendarDays } from "lucide-react";
import type { ReactNode } from "react";

const NAV = [
  { href: "/admin", label: "대시보드", icon: LayoutDashboard, match: (path: string) => path === "/admin" },
  { href: "/admin/streamers", label: "스트리머", icon: Users, match: (path: string) => path.startsWith("/admin/streamers") },
  { href: "/admin/candidates", label: "계정 후보", icon: Database, match: (path: string) => path.startsWith("/admin/candidates") },
  { href: "/admin/ck", label: "경기 검수", icon: ClipboardCheck, match: (path: string) => path.startsWith("/admin/ck") },
  { href: "/admin/overview", label: "경기 확인", icon: ListChecks, match: (path: string) => path.startsWith("/admin/overview") },
  { href: "/admin/fco", label: "FC 맥락 검수", icon: Trophy, match: (path: string) => path.startsWith("/admin/fco") },
  { href: "/admin/schedule", label: "편성표", icon: CalendarDays, match: (path: string) => path.startsWith("/admin/schedule") },
] as const;

export function AdminShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const current = NAV.find((item) => item.match(pathname)) ?? NAV[0];

  return (
    <div className="admin-shell" data-admin-shell>
      <aside className="admin-sidebar" aria-label="관리자 메뉴">
        <Link href="/admin" className="admin-brand">
          <span className="admin-brand-mark"><Radio size={15} aria-hidden /></span>
          <span>SOOP LOL <b>운영 콘솔</b></span>
        </Link>
        <nav className="admin-navigation" aria-label="운영 메뉴">
          <p className="admin-nav-group-label">운영</p>
          {NAV.map(({ href, label, icon: Icon, match }) => {
            const active = match(pathname);
            return (
              <Link key={href} href={href} className="admin-nav-item" aria-current={active ? "page" : undefined}>
                <Icon size={16} aria-hidden />
                <span>{label}</span>
              </Link>
            );
          })}
        </nav>
      </aside>

      <header className="admin-topbar">
        <div>
          <p className="admin-topbar-eyebrow">SOOP LOL 운영</p>
          <h1>{current.label}</h1>
        </div>
        <Link href="/" className="admin-site-link">사이트 보기 <span aria-hidden>↗</span></Link>
      </header>

      <main className="admin-workspace" data-admin-workspace>
        <div className="admin-content">{children}</div>
      </main>
    </div>
  );
}
