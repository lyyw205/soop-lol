import Link from "next/link";
import { candidateCounts, countCandidates, listCandidates, listAdminStreamerChoices } from "@soop-lol/core/lib/db/streamers";
import { kstDotted } from "@soop-lol/core/lib/time";
import { AccountLinkForm } from "@/components/admin/AccountLinkForm";
import { CandidateActions } from "@/components/admin/CandidateActions";
import { AdminPagination } from "@/components/admin/AdminPagination";
import { Card, EmptyState } from "@/components/ui";
import { adminHref, adminPage } from "@/lib/admin-navigation";

export const metadata = { title: "계정 후보" };
export const dynamic = "force-dynamic";
const STATES = { pending: "대기", ignored: "보류", rejected: "대상 아님", approved: "연결 완료" };
const SIZE = 50;
export default async function CandidatesPage({ searchParams }: { searchParams: Promise<{ state?: string; q?: string; page?: string; sort?: string }> }) {
  const query = await searchParams;
  const state = query.state && query.state in STATES ? query.state : "pending";
  const page = adminPage(query.page), q = query.q?.trim() ?? "";
  const [candidates, total, counts, people] = await Promise.all([
    listCandidates(state, SIZE, { q, offset: (page - 1) * SIZE, sort: query.sort }), countCandidates(state, q), candidateCounts(), listAdminStreamerChoices(),
  ]);
  const href = adminHref("/admin/candidates", { state, q, sort: query.sort, page });
  return <Card title="계정 후보" description="목격 기록과 근거를 확인하고 스트리머에 연결합니다.">
    <nav className="admin-section-tabs" aria-label="후보 상태">{Object.entries(STATES).map(([key, label]) =>
      <Link key={key} href={adminHref(href, { state: key, page: 1 })} aria-current={key === state ? "page" : undefined}>{label} {counts[key] ?? 0}</Link>)}
    </nav>
    <form className="mb-3 flex flex-wrap gap-2">
      <input type="hidden" name="state" value={state} />
      <input name="q" aria-label="계정 검색" defaultValue={q} placeholder="닉네임·태그·계정 식별자" className="admin-input max-w-sm" />
      <select name="sort" aria-label="후보 정렬" defaultValue={query.sort ?? "seen"} className="admin-input max-w-40"><option value="seen">많이 목격된 순</option><option value="recent">최근 목격순</option></select>
      <button className="rounded border border-ink-700 px-3 text-sm">검색</button>
      {q && <Link href={adminHref(href, { q: null, page: 1 })} className="self-center text-xs text-ink-400">초기화</Link>}
    </form>
    <p className="text-xs text-ink-400">보류는 근거가 부족한 후보, 대상 아님은 일반 유저·오탐입니다.</p>
    <AdminPagination href={href} page={page} total={total} size={SIZE} />
    {candidates.length === 0 ? <EmptyState>{q ? "검색 결과가 없습니다." : "해당 상태의 후보가 없습니다."}</EmptyState> :
      <ul className="divide-y divide-ink-800">{candidates.map(c => <li key={c.id} className="py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><b className="text-sm text-ink-200">{c.game_name ? `${c.game_name}#${c.tag_line ?? "?"}` : "닉네임 미상"}</b>
            <p className="mt-1 text-xs text-ink-400">{c.seen_count}회 목격 · 최근 {kstDotted(new Date(c.last_seen_at))}</p></div>
          <CandidateActions id={c.id} state={state} />
        </div>
        {c.owners.length > 0 && <p className="mt-2 text-xs">연결된 스트리머 · {c.owners.map(person => <Link key={person.id} className="mr-2 text-accent-400" href={adminHref(`/admin/streamers/${person.id}`, { from: href })}>{person.name} ↗</Link>)}</p>}
        <details className="mt-2 text-xs text-ink-400"><summary className="cursor-pointer">목격 정보·전체 계정 식별자</summary>
          <p className="mt-2">같이 본 스트리머 · {c.companions.length ? c.companions.map(person => <Link key={person.id} href={adminHref(`/admin/streamers/${person.id}`, { from: href })} className="mr-2 text-accent-400">{person.name} ↗</Link>) : "없음"}</p>
          <p className="mt-2 break-all font-mono select-all">{c.puuid}</p>
        </details>
        {state !== "approved" && <details className="mt-3 rounded border border-ink-800 p-3"><summary className="cursor-pointer text-sm text-accent-400">스트리머에 연결</summary>
          <div className="mt-3"><AccountLinkForm candidate={c} people={people} hasKey={false} /></div>
        </details>}
      </li>)}</ul>}
    <AdminPagination href={href} page={page} total={total} size={SIZE} />
  </Card>;
}
