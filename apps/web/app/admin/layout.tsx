import Link from "next/link";

export const metadata = { title: "관리자" };

const NAV = [
  { href: "/admin", label: "대시보드" },
  { href: "/admin/streamers", label: "스트리머" },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <header className="mb-8 flex items-center justify-between border-b border-ink-800 pb-4">
        <div className="flex items-baseline gap-4">
          <Link href="/admin" className="text-lg font-semibold text-ink-200">
            SOOP LOL <span className="text-accent-500">관리자</span>
          </Link>
          <nav className="flex gap-3 text-sm text-ink-400">
            {NAV.map((item) => (
              <Link key={item.href} href={item.href} className="hover:text-ink-200">
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
        <Link href="/" className="text-xs text-ink-400 hover:text-ink-200">
          사이트 보기 →
        </Link>
      </header>
      {children}
    </div>
  );
}
