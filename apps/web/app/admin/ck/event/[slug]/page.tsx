import Link from "next/link";
import { Fragment } from "react";
import { notFound } from "next/navigation";

import { getReviewEvent, type ReviewSeriesRow, type ReviewSetRow } from "@soop-lol/core/lib/db/event-review";
import { isStandaloneSet, setLabel } from "@soop-lol/core/lib/metrics/set-label";
import { kstPlayedAt } from "@soop-lol/core/lib/time";

import { ReviewProgress, ReviewProgressHeaders } from "@/components/admin/ReviewProgress";
import { EventMatchRow } from "@/components/admin/EventMatchRow";
import { Card, EmptyState, Tag } from "@/components/ui";
import { rosterFocus } from "@/lib/ck-review-progress";
import { EVENT_KIND_LABEL } from "@/lib/admin-labels";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const detail = await getReviewEvent(slug);
  return { title: detail ? `검수 · ${detail.event.name}` : "검수" };
}

const TAB_OF: Record<string, string> = { tournament: "tournament", showmatch: "showmatch" };



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

export default async function CkEventReviewPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ review?: string; focus?: string }> }) {
  const query = await searchParams;
  const { slug } = await params;
  const detail = await getReviewEvent(slug);
  if (!detail) notFound();
  const { event, series } = detail;
  const back = TAB_OF[event.kind] ? `/admin/ck?kind=${TAB_OF[event.kind]}` : "/admin/ck";
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
