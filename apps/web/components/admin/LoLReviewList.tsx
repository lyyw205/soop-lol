import Link from "next/link";
import { countOverviewSeries, listOverviewSeries } from "@soop-lol/core/lib/db/match-overview";
import { listEventLeads, type LeadEventKind } from "@soop-lol/core/lib/db/ck";
import { Card, EmptyState } from "@/components/ui";
import { MatchOverview } from "./MatchOverview";
import { AdminPagination } from "./AdminPagination";
import { adminHref, adminPage } from "@/lib/admin-navigation";
import { EVENT_KIND_LABEL } from "@/lib/admin-labels";

export type LoLListQuery = { kind?: string; review?: string; q?: string; page?: string; event?: string; focus?: string; channel?: string; queue?: string };
const KINDS = ["ck", "land", "tournament", "showmatch", "scrim", "other"] as const;
export async function LoLReviewList({ query, mode }: { query: LoLListQuery; mode: "queue" | "compare" }) {
  const kind = KINDS.includes(query.kind as LeadEventKind) ? query.kind as LeadEventKind : undefined;
  const queue: "priority" | "general" | undefined = query.queue === "general" ? "general" : query.queue === "all" ? undefined : "priority";
  const page = adminPage(query.page), size = 50, pending = query.review !== "all";
  const path = mode === "queue" ? "/admin/ck" : "/admin/overview";
  const href = adminHref(path, { ...query, queue: queue ?? "all", page });
  const opts = { kind, unreviewed: pending, q: query.q, event: query.event, focus: query.focus, queue };
  const [series, total] = await Promise.all([listOverviewSeries({ ...opts, limit: size, offset: (page - 1) * size }), countOverviewSeries(opts)]);
  const leads = query.channel ? await listEventLeads({ channel_id: query.channel, event_kind: kind, with_matches: true, unreviewed: pending }) : [];
  return <Card title={mode === "queue" ? "LoL 경기 검수" : "시리즈 비교"}>
    <nav aria-label="검수 우선순위" className="mb-3 flex flex-wrap gap-3 text-xs">{[['priority','우선 검수'],['general','일반 검수'],['all','전체']].map(([key,label]) => <Link key={key} href={adminHref(href, { queue: key, page: undefined })} aria-current={(queue ?? 'all') === key ? 'page' : undefined} className={(queue ?? 'all') === key ? 'text-accent-400' : 'text-ink-400'}>{label}</Link>)}</nav>
    <form className="mb-3 flex flex-wrap items-center gap-2">
      <input type="hidden" name="queue" value={queue ?? "all"} />
      {query.event && <input type="hidden" name="event" value={query.event} />}
      <input name="q" defaultValue={query.q} placeholder="대회·선수·경기 검색" aria-label="경기 검색" className="admin-input max-w-xs" />
      <select name="kind" defaultValue={kind ?? ""} aria-label="경기 분류" className="admin-input max-w-32"><option value="">모든 분류</option>{KINDS.map(k => <option key={k} value={k}>{EVENT_KIND_LABEL[k]}</option>)}</select>
      <select name="review" defaultValue={pending ? "pending" : "all"} aria-label="검수 상태" className="admin-input max-w-32"><option value="pending">미검수</option><option value="all">전체 상태</option></select>
      <select name="focus" defaultValue={query.focus ?? ""} aria-label="누락 항목" className="admin-input max-w-36"><option value="">누락 항목 전체</option><option value="identity">참가자 미연결</option><option value="position">포지션 누락</option><option value="champion">챔피언 누락</option><option value="kda">KDA 누락</option></select>
      <button className="rounded border border-ink-700 px-3 py-2 text-xs">검색</button>
      <Link href={path} className="text-xs text-ink-400">초기화</Link>
    </form>
    <div className="flex flex-wrap items-center gap-4 text-xs">
      <Link href={adminHref(path, { event: "unlinked", review: query.review, queue: queue ?? "all" })} className="text-accent-400">행사 미연결 경기</Link>
      <Link href={adminHref(mode === "queue" ? "/admin/overview" : "/admin/ck", { ...query, queue: queue ?? "all", page })} className="text-accent-400">{mode === "queue" ? "같은 목록을 시리즈로 비교" : "같은 목록을 검수"}</Link>
      {query.event && <span className="text-ink-400">행사: {query.event === "unlinked" ? "미연결" : series[0]?.event_name ?? query.event}</span>}
    </div>
    <details className="mt-3 text-xs text-ink-400" open={!!query.channel}><summary className="cursor-pointer">방송 채널로 찾기</summary>
      <form className="mt-2 flex gap-2"><input name="channel" defaultValue={query.channel} aria-label="채널 아이디" placeholder="SOOP 채널 아이디" className="admin-input max-w-xs" /><button className="rounded border border-ink-700 px-3">찾기</button></form>
      {query.channel && <ul className="mt-2 grid gap-2">{leads.length ? leads.map(l => <li key={l.id}><Link href={adminHref(`/admin/ck/${l.id}`, { from: href })} className="text-accent-400">{l.title} · {l.match_count}경기</Link></li>) : <li>연결된 방송이 없습니다.</li>}</ul>}
    </details>
    <AdminPagination href={href} page={page} total={total} size={size} />
    {series.length === 0 && <EmptyState>조건에 맞는 경기가 없습니다.</EmptyState>}
    <MatchOverview key={href} series={series} mode={mode} returnTo={href} focus={query.focus} />
    <AdminPagination href={href} page={page} total={total} size={size} />
  </Card>;
}
