import Link from "next/link";
import { countOverviewSeries, listOverviewSeries } from "@soop-lol/core/lib/db/match-overview";
import { listEventLeads, type LeadEventKind } from "@soop-lol/core/lib/db/ck";
import { listDuplicateSuspects } from "@soop-lol/core/lib/db/ck-duplicates";
import { Card, EmptyState } from "@/components/ui";
import { MatchOverview } from "./MatchOverview";
import { AdminPagination } from "./AdminPagination";
import { adminHref, adminPage } from "@/lib/admin-navigation";
import { EVENT_KIND_LABEL } from "@/lib/admin-labels";
import { LOL_ADMIN } from "@/lib/admin-lol";
import type { LoLReviewCollection } from "@soop-lol/core/lib/db/lol-review-scope";

export type LoLListQuery = { kind?: string; review?: string; q?: string; page?: string; event?: string; focus?: string; channel?: string; queue?: string };
const KINDS = ["ck", "land", "tournament", "showmatch", "scrim", "other"] as const;
export async function LoLReviewList({ query, mode, collection = "rift" }: { query: LoLListQuery; mode: "queue" | "compare"; collection?: LoLReviewCollection }) {
  const kind = KINDS.includes(query.kind as LeadEventKind) ? query.kind as LeadEventKind : undefined;
  const queue: "priority" | "general" | undefined = query.queue === "general" ? "general" : query.queue === "all" ? undefined : "priority";
  const page = adminPage(query.page), size = 50, pending = query.review !== "all";
  const section = LOL_ADMIN[collection];
  const path = section[mode];
  const href = adminHref(path, { ...query, queue: queue ?? "all", page });
  const opts = { collection, kind, unreviewed: pending, q: query.q, event: query.event, focus: query.focus, queue };
  const [series, total, duplicates] = await Promise.all([listOverviewSeries({ ...opts, limit: size, offset: (page - 1) * size }), countOverviewSeries(opts),
    mode === "queue" ? listDuplicateSuspects() : Promise.resolve([])]);
  const leads = query.channel ? await listEventLeads({ collection, channel_id: query.channel, event_kind: kind, with_matches: true, unreviewed: pending }) : [];
  return <Card title={`${section.label} ${mode === "queue" ? "경기 검수" : "시리즈 비교"}`} description={collection === "aram" ? "일반 칼바람과 증강 칼바람 경기를 함께 검수합니다." : undefined}>
    {/* 저장 뒤 값이 채워져서야 드러난 같은 판 — 판정은 ck:record --todo 와 같은 코어 함수다. 다르면 distinct_from 으로 남긴다. */}
    {duplicates.length > 0 && <details className="mb-3 rounded border border-amber-700/60 bg-amber-950/20 p-3 text-xs">
      <summary className="cursor-pointer text-amber-300">같은 판으로 보이는 공개 경기 {duplicates.length}쌍 — 두 경기 결과창을 대조해 주세요</summary>
      <ul className="mt-2 grid gap-1">{duplicates.map(d => <li key={`${d.a}|${d.b}`} className="flex flex-wrap items-center gap-2">
        <Link href={adminHref(`/admin/ck/match/${encodeURIComponent(d.a)}`, { from: href })} className="text-accent-400">{d.a}</Link>
        <span className="text-ink-500">↔</span>
        <Link href={adminHref(`/admin/ck/match/${encodeURIComponent(d.b)}`, { from: href })} className="text-accent-400">{d.b}</Link>
        <span className="text-ink-400">이름 무관 {d.blind}·사람별 KDA {d.kda}·챔피언 {d.champ}명 일치</span>
      </li>)}</ul>
    </details>}
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
      <Link href={adminHref(mode === "queue" ? section.compare : section.queue, { ...query, queue: queue ?? "all", page })} className="text-accent-400">{mode === "queue" ? "같은 목록을 시리즈로 비교" : "같은 목록을 검수"}</Link>
      {query.event && <span className="text-ink-400">행사: {query.event === "unlinked" ? "미연결" : series[0]?.event_name ?? query.event}</span>}
    </div>
    <details className="mt-3 text-xs text-ink-400" open={!!query.channel}><summary className="cursor-pointer">방송 채널로 찾기</summary>
      <form className="mt-2 flex gap-2"><input name="channel" defaultValue={query.channel} aria-label="채널 아이디" placeholder="SOOP 채널 아이디" className="admin-input max-w-xs" /><button className="rounded border border-ink-700 px-3">찾기</button></form>
      {query.channel && <ul className="mt-2 grid gap-2">{leads.length ? leads.map(l => <li key={l.id}><Link href={adminHref(`/admin/ck/${l.id}`, { from: href })} className="text-accent-400">{l.title} · {l.match_count}경기</Link></li>) : <li>연결된 방송이 없습니다.</li>}</ul>}
    </details>
    <AdminPagination href={href} page={page} total={total} size={size} />
    {series.length === 0 && <EmptyState>조건에 맞는 경기가 없습니다.</EmptyState>}
    <MatchOverview key={href} series={series} mode={mode} collection={collection} returnTo={href} focus={query.focus} />
    <AdminPagination href={href} page={page} total={total} size={size} />
  </Card>;
}
