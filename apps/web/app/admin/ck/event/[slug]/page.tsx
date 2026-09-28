import Link from "next/link";
import { Fragment } from "react";
import { notFound } from "next/navigation";

import { getLeadWorkspace } from "@soop-lol/core/lib/db/ck";
import { listEventPovLeads, povDiffsForLead } from "@soop-lol/core/lib/db/ck-pov";
import { getReviewEvent, type ReviewSeriesRow, type ReviewSetRow } from "@soop-lol/core/lib/db/event-review";
import { isStandaloneSet, setLabel } from "@soop-lol/core/lib/metrics/set-label";
import { kstPlayedAt } from "@soop-lol/core/lib/time";

import { ReviewProgress, ReviewProgressHeaders } from "@/components/admin/ReviewProgress";
import { CkReviewer } from "@/components/admin/CkReviewer";
import { EventMatchRow } from "@/components/admin/EventMatchRow";
import { reviewMatchData } from "@/lib/ck-review-data";
import { Card, EmptyState, Tag } from "@/components/ui";
import { rosterFocus } from "@/lib/ck-review-progress";
import { EVENT_KIND_LABEL } from "@/lib/admin-labels";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const detail = await getReviewEvent(slug);
  return { title: detail ? `검수 · ${detail.event.name}` : "검수" };
}

const TAB_OF: Record<string, string> = { tournament: "tournament", showmatch: "showmatch", ck: "ck" };



const winnerOf = (set: ReviewSetRow) =>
  set.winning_team === 100 ? set.blue_team : set.winning_team === 200 ? set.red_team : null;

/** 시리즈 스코어. 세트마다 진영이 바뀌므로 진영이 아니라 팀 이름으로 센다. */
function score(series: ReviewSeriesRow) {
  const wins = new Map<string, number>();
  for (const set of series.sets) {
    for (const team of [set.blue_team, set.red_team]) if (team && !wins.has(team)) wins.set(team, 0);
    const w = winnerOf(set);
    if (w) wins.set(w, (wins.get(w) ?? 0) + 1);
  }
  return [...wins.entries()];
}

export default async function CkEventReviewPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ review?: string; focus?: string; pov?: string; match?: string }> }) {
  const query = await searchParams;
  const { slug } = await params;
  const detail = await getReviewEvent(slug);
  if (!detail) notFound();
  const { event, series } = detail;
  const back = TAB_OF[event.kind] ? `/admin/ck?kind=${TAB_OF[event.kind]}` : "/admin/ck";

  // ★ CK 는 여러 스트리머가 같은 판을 방송한다. 방송마다 시간축이 다르므로 **시점(VOD)을 먼저 고르고**,
  //   고른 VOD 기준으로 큐·프레임·미니맵·인스펙터가 통째로 바뀐다(docs/CK-MULTI-POV-PLAN.md §6).
  if (event.kind === "ck") {
    const povs = await listEventPovLeads(event.id);
    if (povs.length > 0) {
      const eventMatchIds = new Set(series.flatMap(s => s.sets.map(set => set.match_id)));
      const pov = povs.find(p => p.lead_id === query.pov) ?? povs.find(p => p.creates) ?? povs[0];
      const ws = await getLeadWorkspace(pov.lead_id);
      if (!ws) notFound();
      const matches = ws.matches.filter(m => eventMatchIds.has(m.match.match_id)).map(reviewMatchData);
      const frames = ws.frames.filter(f => f.match_id != null && eventMatchIds.has(f.match_id)).map(f => ({
        id: f.id, match_id: f.match_id, frame_path: f.frame_path, at_sec: f.at_sec, kind: f.kind,
      }));
      const povDiffs = await povDiffsForLead(pov.lead_id, matches.map(m => m.match_id));
      const sameName = (name: string | null) => povs.filter(p => p.streamer_name === name).length > 1;
      const chipHref = (leadId: string) => {
        const q = new URLSearchParams({ pov: leadId });
        if (query.review) q.set("review", query.review);
        return `/admin/ck/event/${slug}?${q}`;
      };
      const initialMatchId = matches.some(m => m.match_id === query.match) ? query.match : undefined;
      return (
        <div className="ck-review-page">
          <header className="ck-review-page-head"><div className="min-w-0">
            <Link href={back} className="text-xs text-ink-400 hover:text-ink-200">← 경기 검수</Link>
            <h1 className="mt-1 truncate text-lg font-semibold text-ink-200">{event.name}</h1>
            <nav className="mt-2 flex flex-wrap gap-1.5" aria-label="시점 선택">
              {povs.map((p) => {
                const current = p.lead_id === pov.lead_id;
                return (
                  <Link key={p.lead_id} href={chipHref(p.lead_id)} aria-current={current ? "page" : undefined}
                    title={`${p.title} · 이 대회 경기 ${p.match_count}개`}
                    className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs ${current
                      ? "border-accent-600/60 bg-accent-600/15 text-accent-400"
                      : "border-ink-700 text-ink-300 hover:text-ink-100"}`}>
                    {p.streamer_name ?? p.source_key}
                    {sameName(p.streamer_name) && <span className="text-[10px] text-ink-500">{new Date(p.observed_at).toLocaleTimeString("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit" })}</span>}
                    {p.mismatch_open > 0 && <span className="h-1.5 w-1.5 rounded-full bg-amber-400" aria-label={`미해결 불일치 ${p.mismatch_open}`} />}
                  </Link>
                );
              })}
            </nav>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-ink-400">
              <span>{pov.title}</span>
              {pov.url && <a href={pov.url} target="_blank" rel="noreferrer" className="hover:text-ink-200">VOD 열기 ↗</a>}
              <Link href={`/admin/ck/${pov.lead_id}`} className="hover:text-ink-200">이 VOD 의 다른 경기까지 보기</Link>
            </p>
          </div></header>
          <CkReviewer
            key={pov.lead_id}
            leadId={pov.lead_id}
            vodUrl={pov.url}
            initialMatchId={initialMatchId}
            initialPending={query.review === "pending"}
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
  const sets = series.flatMap(s => s.sets);
  const field = rosterFocus(query.focus);
  const visible = series.map(s => ({ ...s, sets: s.sets.filter(set =>
    query.review === "pending" ? !set.review_completed_at
      : field ? set[field.count] < 10 : true) })).filter(s => s.sets.length);
  const baseHref = `/admin/ck/event/${slug}`;


  return (
    <div className="grid gap-6">
      <div>
        <Link href={back} className="text-xs text-ink-400 hover:text-ink-200">← 경기 검수</Link>
        <h1 className="mt-1 text-lg font-semibold text-ink-200">{event.name}</h1>
        <p className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-ink-400">
          <Tag tone="neutral">{EVENT_KIND_LABEL[event.kind] ?? event.kind}</Tag>
          {event.organizer && <span>주최 {event.organizer}</span>}
          {event.source_url && (
            <a href={event.source_url} target="_blank" rel="noreferrer" className="hover:text-ink-200">출처 ↗</a>
          )}
        </p>
      </div>

      <ReviewProgress matches={sets.length} completed={sets.filter(s => s.review_completed_at).length}
        positions={sets.reduce((n, s) => n + s.position_count, 0)} champions={sets.reduce((n, s) => n + s.champion_count, 0)}
        linked={sets.reduce((n, s) => n + s.linked_count, 0)} kda={sets.reduce((n, s) => n + s.kda_count, 0)} href={baseHref} />
      <nav className="flex gap-3 text-xs" aria-label="검수 상태">
        <Link href={baseHref} className={!query.review && !query.focus ? "text-accent-400" : "text-ink-400"}>전체</Link>
        <Link href={`${baseHref}?review=pending`} className={query.review === "pending" ? "text-accent-400" : "text-ink-400"}>미검수</Link>
      </nav>
      <Card title={field ? `${field.label}이 필요한 경기` : "등록 경기"}>
        {visible.length === 0 ? (
          <EmptyState>해당하는 경기가 없습니다.</EmptyState>
        ) : (
          <div className="ck-progress-scroll">
          <table className="ck-progress-table ck-progress-table--event">
            <caption className="sr-only">등록 경기별 검수·입력 현황</caption>
            <thead><tr><th scope="col" className="ck-progress-title">경기</th><ReviewProgressHeaders includeRegistration={false} /></tr></thead>
            <tbody>
            {visible.map((s) => (
              <Fragment key={s.key}>
                <tr className="ck-event-series-row"><th colSpan={6}>
                  <span className="font-medium text-ink-200">{s.round_label ?? <span className="text-ink-500">라운드 미기재</span>}</span>
                  <span className="ml-3 text-xs text-ink-400">{score(series.find(original => original.key === s.key)!).map(([team, w]) => `${team} ${w}`).join(" : ")}</span>
                  {s.best_of && <span className="ml-3 text-[11px] text-ink-500">{s.best_of}판 {Math.ceil(s.best_of / 2)}선승</span>}
                </th></tr>
                {s.sets.map((set) => <EventMatchRow key={set.match_id} match={{
                  match_id: set.match_id, review_version: set.review_version, review_completed_at: set.review_completed_at,
                  position_count: set.position_count, linked_count: set.linked_count, champion_count: set.champion_count, kda_count: set.kda_count,
                  label: setLabel({
                        standalone: isStandaloneSet(set.match_id, s.key), best_of: s.best_of,
                        set_order_known: s.set_order_known, series_game_no: set.series_game_no,
                      }), playedAt: kstPlayedAt(new Date(set.game_creation), set.game_creation_precision),
                  winner: winnerOf(set) ?? "승자 미정", hidden: set.visibility === "hidden",
                }} href={`/admin/ck/match/${encodeURIComponent(set.match_id)}`} />)}
              </Fragment>
            ))}
            </tbody>
          </table>
          </div>
        )}
      </Card>
    </div>
  );
}
