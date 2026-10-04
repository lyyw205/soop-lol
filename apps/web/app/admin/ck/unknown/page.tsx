import Link from "next/link";
import { countUnidentifiedNames, listUnidentifiedParticipants } from "@soop-lol/core/lib/db/ck";
import { listAdminStreamerChoices } from "@soop-lol/core/lib/db/streamers";
import { kstDateString } from "@soop-lol/core/lib/time";
import { LinkUnknownForm } from "@/components/admin/LinkUnknownForm";
import { AdminPagination } from "@/components/admin/AdminPagination";
import { adminHref, adminPage } from "@/lib/admin-navigation";
export const dynamic = "force-dynamic";
export default async function UnknownParticipantsPage({ searchParams }: { searchParams: Promise<{ page?: string; q?: string }> }) {
  const { page: raw, q = "" } = await searchParams;
  const page = adminPage(raw), size = 50;
  const [rows, total, people] = await Promise.all([listUnidentifiedParticipants(size, (page - 1) * size, q), countUnidentifiedNames(q), listAdminStreamerChoices()]);
  const href = adminHref("/admin/ck/unknown", { q, page });
  return <div className="grid gap-4">
    <header><h1 className="text-lg text-ink-200">미확인 참가자</h1><p className="mt-1 text-xs text-ink-400">인게임명만 있는 자리를 스트리머와 연결합니다. 등장 횟수가 많은 이름부터 표시합니다.</p></header>
    <form className="flex flex-wrap gap-2" action="/admin/ck/unknown"><input name="q" defaultValue={q} placeholder="인게임명 검색" aria-label="인게임명 검색" className="admin-input" /><button className="admin-input">검색</button><Link className="self-center text-xs" href="/admin/ck/unknown">초기화</Link></form>
    <AdminPagination href={href} page={page} total={total} size={size} unit="이름" />
    {!rows.length && <p className="admin-empty">조건에 맞는 미확인 참가자가 없습니다.</p>}
    <ul className="divide-y divide-ink-800">{rows.map(row => <li key={row.observed_name} className="py-3">
      <details><summary className="flex cursor-pointer flex-wrap items-baseline gap-2 text-sm"><strong>{row.observed_name}</strong><span className="text-xs text-amber-400">{row.seats}자리</span><span className="text-xs text-ink-400">{kstDateString(row.first_seen)} ~ {kstDateString(row.last_seen)} · 열어서 연결</span></summary>
        <p className="mt-2 text-xs text-ink-400">같은 팀: {row.teammates.join(" · ") || "미확인"}<br />챔피언: {row.champions.join(" · ") || "미확인"}</p>
        <LinkUnknownForm targets={row.targets} people={people} />
      </details>
    </li>)}</ul>
    <AdminPagination href={href} page={page} total={total} size={size} unit="이름" />
  </div>;
}
