import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getMatchReviewWorkspace } from "@soop-lol/core/lib/db/ck";
import { CkReviewer } from "@/components/admin/CkReviewer";
import { rosterFocus } from "@/lib/ck-review-progress";
import { reviewMatchData } from "@/lib/ck-review-data";

export const dynamic = "force-dynamic";
export const metadata = { title: "경기 검수" };

export default async function MatchReviewPage({ params, searchParams }: {
  params: Promise<{ matchId: string }>; searchParams: Promise<{ focus?: string }>;
}) {
  const { matchId: routeId } = await params;
  let matchId: string;
  try { matchId = decodeURIComponent(routeId); } catch { notFound(); }
  const { focus } = await searchParams;
  const ws = await getMatchReviewWorkspace(matchId);
  if (!ws) notFound();
  if (ws.leadId) {
    const q = new URLSearchParams({ match: matchId });
    if (rosterFocus(focus)) q.set("focus", focus!);
    redirect(`/admin/ck/${ws.leadId}?${q}`);
  }
  const event = ws.events.find(e => e.id === ws.detail.match.event_id);
  return <div className="ck-review-page">
    <header className="ck-review-page-head"><div>
      <Link href={event?.slug ? `/admin/ck/event/${event.slug}` : "/admin/ck"} className="text-xs text-ink-400">← 경기 목록</Link>
      <h1 className="mt-1 text-lg text-ink-200">{event?.name ?? "경기 검수"}</h1>
      {ws.detail.match.source_url && <a href={ws.detail.match.source_url} target="_blank" rel="noreferrer" className="text-xs text-accent-400">출처 열기 ↗</a>}
    </div></header>
    <CkReviewer key={focus} leadId="" frames={[]} matches={[reviewMatchData(ws.detail)]}
      streamers={ws.streamers} events={ws.events} initialFocus={focus} initialMatchId={matchId} />
  </div>;
}
