import { adminLoLCollection, inLoLCollection, LOL_ADMIN } from "@/lib/admin-lol";
import { lolReviewQueueIds } from "@soop-lol/core/lib/db/review-priority";
import Link from "next/link";
import { cache } from "react";
import { notFound, redirect } from "next/navigation";

import { getLeadWorkspace } from "@soop-lol/core/lib/db/ck";
import { listEventPovLeads, povDiffsForLead } from "@soop-lol/core/lib/db/ck-pov";
import { getReviewEvent } from "@soop-lol/core/lib/db/event-review";

import { CkReviewer } from "@/components/admin/CkReviewer";
import { PovChips } from "@/components/admin/PovChips";
import { reviewMatchData } from "@/lib/ck-review-data";
import { rosterFocus } from "@/lib/ck-review-progress";

import { AdminBackLink } from "@/components/admin/AdminBackLink";
import { adminHref } from "@/lib/admin-navigation";
const loadEvent = cache(getReviewEvent);

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const detail = await loadEvent(slug);
  return { title: detail ? `검수 · ${detail.event.name}` : "검수" };
}

const TAB_OF: Record<string, string> = { tournament: "tournament", showmatch: "showmatch", ck: "ck" };



/** KST 시:분 (24시간). 서버 로캘에 따라 AM/오전이 바뀌지 않게 직접 만든다. */
const kstClock = (d: Date) => new Date(new Date(d).getTime() + 9 * 3600_000).toISOString().slice(11, 16);

export default async function CkEventReviewPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ review?: string; focus?: string; pov?: string; match?: string; tab?: string; from?: string }> }) {
  const query = await searchParams;
  const { slug } = await params;
  const detail = await loadEvent(slug);
  if (!detail) notFound();
  const { event, series } = detail;
  const collection = adminLoLCollection(query.from);
  const listPath = LOL_ADMIN[collection ?? "rift"].queue;
  const back = adminHref(listPath, { kind: TAB_OF[event.kind] });

  // ★ CK 는 여러 스트리머가 같은 판을 방송한다. 방송마다 시간축이 다르므로 **시점(VOD)을 먼저 고르고**,
  //   고른 VOD 기준으로 큐·프레임·미니맵·인스펙터가 통째로 바뀐다(docs/CK-MULTI-POV-PLAN.md §6).
  if (event.kind === "ck") {
    const povs = await listEventPovLeads(event.id, collection);
    if (povs.length > 0) {
      const eventMatchIds = new Set(series.flatMap(s => s.sets.map(set => set.match_id)));
      const pov = povs.find(p => p.lead_id === query.pov) ?? povs.find(p => p.creates) ?? povs[0];
      const ws = await getLeadWorkspace(pov.lead_id, { records: false });
      if (!ws) notFound();
      const matches = ws.matches.filter(m => eventMatchIds.has(m.match.match_id) && inLoLCollection(m.match, collection)).map(reviewMatchData);
      const scopedMatchIds = new Set(matches.map(m => m.match_id));
      const frames = ws.frames.filter(f => f.match_id == null || scopedMatchIds.has(f.match_id)).map(f => ({
        id: f.id, match_id: f.match_id, frame_path: f.frame_path, at_sec: f.at_sec, kind: f.kind,
      }));
      const povDiffs = await povDiffsForLead(pov.lead_id, matches.map(m => m.match_id));
      const field = rosterFocus(query.focus);
      const initialMatchId = matches.find(m => m.match_id === query.match)?.match_id
        ?? matches.find(m => field ? m[field.count] < 10 : query.review === "pending" ? !m.review_completed_at : false)?.match_id;
      return (
        <div className="ck-review-page">
          <header className="ck-review-page-head"><div className="min-w-0">
            <AdminBackLink fallback={back}>검수 목록</AdminBackLink>
            <h1 className="mt-1 truncate text-lg font-semibold text-ink-200">{event.name}</h1>
            <PovChips slug={slug} currentLeadId={pov.lead_id} povs={povs.map(p => ({
              lead_id: p.lead_id, source_key: p.source_key, title: p.title, streamer_name: p.streamer_name,
              time_label: kstClock(p.observed_at), match_count: p.match_count, mismatch_open: p.mismatch_open,
            }))} />
            <p className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-ink-400">
              <span>{pov.title}</span>
              {pov.url && <a href={pov.url} target="_blank" rel="noreferrer" className="hover:text-ink-200">VOD 열기 ↗</a>}
              <Link href={adminHref(`/admin/ck/${pov.lead_id}`, { from: query.from ?? back, match: query.match, tab: query.tab, focus: query.focus })} className="hover:text-ink-200">이 VOD 의 다른 경기까지 보기</Link>
            </p>
          </div></header>
          <CkReviewer reviewQueueIds={await lolReviewQueueIds(matches.map(m => m.match_id), query.from, collection)}
            key={`${pov.lead_id}:${collection ?? "all"}`}
            leadId={pov.lead_id}
            vodUrl={pov.url}
            initialMatchId={initialMatchId}
            initialFocus={query.focus}
            initialTab={query.tab === "roster" ? "roster" : undefined}
            syncUrl
            frames={frames}
            matches={matches}
            streamers={ws.streamers}
            events={ws.events}
            vodStartedAt={typeof ws.lead.raw.vod_started_at === "string" ? ws.lead.raw.vod_started_at : null}
            povDiffs={povDiffs}
          />
        </div>
      );
    }
  }
  // Non-CK event summaries now live inside the shared list; retain this permalink.
  redirect(adminHref(listPath, { event: slug, review: query.review, focus: query.focus }));
}
