import Link from "next/link";
import { listEventLeads, type LeadEventKind } from "@soop-lol/core/lib/db/ck";
import { listReviewEvents } from "@soop-lol/core/lib/db/event-review";
import { Card, EmptyState } from "@/components/ui";
import { ReviewProgressCells, ReviewProgressHeaders } from "@/components/admin/ReviewProgress";
import { EVENT_KIND_LABEL } from "@/lib/admin-labels";

export const metadata = { title: "경기 검수" };
export const dynamic = "force-dynamic";
const KINDS = ["ck", "tournament", "showmatch", "scrim", "other"] as const;
const kstDate = (date: Date) => date.toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" });

export default async function CkLeadsPage({ searchParams }: {
  searchParams: Promise<{ kind?: string; channel?: string; review?: string }>;
}) {
  const query = await searchParams;
  const kind = KINDS.includes(query.kind as LeadEventKind) ? query.kind as LeadEventKind : "";
  const pending = query.review === "pending";
  const byEvent = kind === "tournament" || kind === "showmatch";
  const events = byEvent ? await listReviewEvents(kind, pending) : [];
  const leads = byEvent ? [] : await listEventLeads({
    event_kind: kind || undefined, channel_id: query.channel, with_matches: true, unreviewed: pending,
  });
  const href = (nextKind: string, nextPending: boolean) => {
    const q = new URLSearchParams();
    if (nextKind) q.set("kind", nextKind);
    if (nextPending) q.set("review", "pending");
    if (query.channel) q.set("channel", query.channel);
    return `/admin/ck${q.size ? `?${q}` : ""}`;
  };
  const chip = (active: boolean) => `rounded-md border px-3 py-1.5 text-xs ${active
    ? "border-accent-600/40 bg-accent-600/10 text-accent-400"
    : "border-ink-700 text-ink-400 hover:text-ink-200"}`;

  return <Card title="경기 검수" description="등록된 경기의 값을 확인하고 수정합니다.">
    <nav className="mb-4 flex flex-wrap items-center gap-2" aria-label="경기 분류">
      <Link href={href("", pending)} className={chip(!kind)}>전체 분류</Link>
      {KINDS.map(k => <Link key={k} href={href(k, pending)} className={chip(kind === k)}>{EVENT_KIND_LABEL[k]}</Link>)}
      <Link href="/admin/ck/unknown" className="ml-auto text-xs text-ink-400 hover:text-accent-400">참가자 연결</Link>
    </nav>
    <nav className="mb-3 flex gap-2" aria-label="검수 상태">
      <Link href={href(kind, false)} className={chip(!pending)}>전체</Link>
      <Link href={href(kind, true)} className={chip(pending)}>미검수</Link>
    </nav>
    {!(byEvent ? events.length : leads.length) ? <EmptyState>{pending ? "미검수 경기가 없습니다." : "등록된 경기가 없습니다."}</EmptyState>
      : <>
      <p className="mb-3 flex justify-end gap-3 text-[11px]" aria-label="현황 색상 안내">
        <span className="text-win">● 모두 채움</span><span className="text-amber-300">● 일부 채움</span><span className="text-ink-400">● 비어 있음</span>
      </p>
      <div className="ck-progress-scroll" role="region" aria-label={byEvent ? "대회별 검수 현황" : "VOD별 검수 현황"} tabIndex={0}>
      <table className="ck-progress-table ck-progress-table--list">
        <caption className="sr-only">{byEvent ? "대회" : "VOD"}별 등록 경기와 검수·입력 현황</caption>
        <thead><tr><th scope="col" className="ck-progress-title">{byEvent ? "대회" : "VOD"}</th><ReviewProgressHeaders /></tr></thead>
        <tbody>
        {byEvent ? events.map(e => {
          const link = `/admin/ck/event/${e.slug}`;
          return <tr key={e.id}>
            <th scope="row" className="ck-progress-title"><Link href={pending ? `${link}?review=pending` : link} className="text-sm text-ink-200 hover:text-accent-400">{e.name}</Link>
              <p className="mt-1 text-xs text-ink-500">{e.starts_at ? kstDate(e.starts_at) : e.first_played ? kstDate(e.first_played) : "날짜 미상"}</p></th>
            <ReviewProgressCells matches={e.match_count} completed={e.completed_count} positions={e.position_count} linked={e.linked_count} champions={e.champion_count} kda={e.kda_count} href={link} />
          </tr>;
        }) : leads.map(l => {
          const link = `/admin/ck/${l.id}`;
          return <tr key={l.id}>
            <th scope="row" className="ck-progress-title"><Link href={pending ? `${link}?review=pending` : link} className="text-sm text-ink-200 hover:text-accent-400">{l.title}</Link>
              <p className="mt-1 flex gap-3 text-xs text-ink-500"><span>{kstDate(new Date(l.observed_at))}</span>
                {l.url && <a href={l.url} target="_blank" rel="noreferrer" className="hover:text-accent-400">VOD 열기 ↗</a>}</p></th>
            <ReviewProgressCells matches={l.match_count} completed={l.completed_count} positions={l.position_count} linked={l.linked_count} champions={l.champion_count} kda={l.kda_count} href={link} />
          </tr>;
        })}
        </tbody>
      </table>
      </div>
      </>}
  </Card>;
}
