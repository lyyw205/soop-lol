import Link from "next/link";
import { adminHref } from "@/lib/admin-navigation";

export function AdminPagination({ href, page, total, size = 50, unit = "건" }: { href: string; page: number; total: number; size?: number; unit?: string }) {
  const pages = Math.max(1, Math.ceil(total / size));
  return <nav className="admin-pagination" aria-label="목록 페이지">
    <span>전체 {total.toLocaleString("ko-KR")}{unit} · {page}/{pages}페이지</span>
    {page > 1 && <Link href={adminHref(href, { page: page - 1 })}>← 이전</Link>}
    {page < pages && <Link href={adminHref(href, { page: page + 1 })}>다음 →</Link>}
    {page > pages && <Link href={adminHref(href, { page: 1 })}>첫 페이지</Link>}
  </nav>;
}
