import { adminLoLCollection, inLoLCollection, LOL_ADMIN } from "@/lib/admin-lol";
import { lolReviewQueueIds } from "@soop-lol/core/lib/db/review-priority";
import { AdminBackLink } from "@/components/admin/AdminBackLink";
import { adminHref } from "@/lib/admin-navigation";
import { notFound, redirect } from "next/navigation";
import { getMatchReviewWorkspace } from "@soop-lol/core/lib/db/ck";
import { getMatchPovViews } from "@soop-lol/core/lib/db/ck-pov";
import { CkReviewer } from "@/components/admin/CkReviewer";
import { reviewMatchData } from "@/lib/ck-review-data";

export const dynamic = "force-dynamic";
export const metadata = { title: "경기 검수" };

/**
 * 경기 하나의 검수로 들어오는 입구.
 * - 여러 VOD 시점이 붙은 CK 경기 → 그 대회 검수 화면으로 보낸다. 거기서 시점 칩을 고르면 큐·프레임·
 *   인스펙터가 그 VOD 기준으로 바뀐다(docs/CK-MULTI-POV-PLAN.md §6). 처음엔 경기를 만든 시점으로 연다.
 * - VOD 에서 나왔지만 시점 기록이 없는 예전 경기 → 그 VOD 화면.
 * - VOD 가 없는 경기(시드 등) → 여기서 값만 고친다.
 */
export default async function MatchReviewPage({ params, searchParams }: {
  params: Promise<{ matchId: string }>; searchParams: Promise<{ focus?: string; from?: string; review?: string; tab?: string }>;
}) {
  const { matchId: routeId } = await params;
  let matchId: string;
  try { matchId = decodeURIComponent(routeId); } catch { notFound(); }
  const query = await searchParams;
  const { focus } = query;
  const ws = await getMatchReviewWorkspace(matchId);
  if (!ws) notFound();
  const collection = adminLoLCollection(query.from) ?? (inLoLCollection(ws.detail.match, "aram") ? "aram" : "rift");
  const listPath = LOL_ADMIN[collection].queue;
  query.from ??= listPath;
  const event = ws.events.find(e => e.id === ws.detail.match.event_id);
  const povs = await getMatchPovViews(matchId);
  if (povs.length > 0 && event?.slug && event.kind === "ck") {
    const pov = povs.find(p => p.role === "created") ?? povs[0];
    redirect(adminHref(`/admin/ck/event/${event.slug}`, { ...query, pov: pov.lead_id, match: matchId }));
  }
  const leadId = povs[0]?.lead_id ?? ws.leadId;
  if (leadId) {
    redirect(adminHref(`/admin/ck/${leadId}`, { ...query, match: matchId }));
  }
  return <div className="ck-review-page">
    <header className="ck-review-page-head"><div>
      <AdminBackLink fallback={event?.slug ? adminHref(listPath, { event: event.slug }) : listPath}>검수 목록</AdminBackLink>
      <h1 className="mt-1 text-lg text-ink-200">{event?.name ?? "경기 검수"}</h1>
      {ws.detail.match.source_url && <a href={ws.detail.match.source_url} target="_blank" rel="noreferrer" className="text-xs text-accent-400">출처 열기 ↗</a>}
    </div></header>
    <CkReviewer reviewQueueIds={await lolReviewQueueIds([matchId], query.from, collection)} key={focus} leadId="" frames={[]} matches={[reviewMatchData(ws.detail)]}
      streamers={ws.streamers} events={ws.events} initialFocus={focus} initialMatchId={matchId} initialTab={query.tab === "roster" ? "roster" : undefined} />
  </div>;
}
