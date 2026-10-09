"use client";

import { AdminScrollMemory } from "./AdminScrollMemory";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { adminLoLCollection, LOL_ADMIN } from "@/lib/admin-lol";
import { ClipboardCheck, LayoutDashboard, Radio, Trophy, Users, CalendarDays, MessageSquare } from "lucide-react";
import { Suspense, type ReactNode } from "react";

const NAV = [
  { href: "/admin", label: "검수 대기", icon: LayoutDashboard, match: (path: string) => path === "/admin" },
  { href: "/admin/ck", label: "협곡 경기", icon: ClipboardCheck, match: (path: string) => path.startsWith("/admin/ck") || path.startsWith("/admin/overview") },
  { href: "/admin/aram", label: "칼바람 경기", icon: ClipboardCheck, match: (path: string) => path.startsWith("/admin/aram") },
  { href: "/admin/fco", label: "FC 경기", icon: Trophy, match: (path: string) => path.startsWith("/admin/fco") },
  { href: "/admin/streamers", label: "스트리머·계정", icon: Users, match: (path: string) => path.startsWith("/admin/streamers") || path.startsWith("/admin/candidates") },
  { href: "/admin/schedule", label: "편성표", icon: CalendarDays, match: (path: string) => path.startsWith("/admin/schedule") },
  { href: "/admin/community", label: "커뮤니티", icon: MessageSquare, match: (path: string) => path.startsWith("/admin/community") },
] as const;

export function AdminShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const isLoLDetail = pathname.startsWith("/admin/ck/") && pathname !== "/admin/ck/unknown";
  const collection = (isLoLDetail ? adminLoLCollection(params.get("from")) : undefined) ?? adminLoLCollection(pathname);
  const section = collection ? LOL_ADMIN[collection] : undefined;
  const current = NAV.find((item) => item.match(section?.queue ?? pathname)) ?? NAV[0];

  return (
    <div className="admin-shell" data-admin-shell>
      <Suspense fallback={null}><AdminScrollMemory /></Suspense>
      <aside className="admin-sidebar" aria-label="관리자 메뉴">
        <Link href="/admin" className="admin-brand">
          <span className="admin-brand-mark"><Radio size={15} aria-hidden /></span>
          <span>SOOP LOL <b>운영 콘솔</b></span>
        </Link>
        <nav className="admin-navigation" aria-label="운영 메뉴">
          <p className="admin-nav-group-label">운영</p>
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = current.href === href;
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
        <div className="admin-content">
          {(section || current.href === "/admin/streamers") && <nav className="admin-section-tabs" aria-label={`${current.label} 보기`}>
            {(section ? [
              [section.queue, "검수 목록"], [section.compare, "시리즈 비교"], [section.unknown, "참가자 연결"],
            ] : [["/admin/streamers", "스트리머"], ["/admin/candidates", "계정 후보"]]).map(([href, label]) =>
              <Link key={href} href={href} aria-current={pathname === href ? "page" : undefined}>{label}</Link>)}
          </nav>}
          {children}
        </div>
      </main>
    </div>
  );
}
