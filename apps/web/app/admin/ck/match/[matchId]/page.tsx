import { adminLoLCollection, inLoLCollection, LOL_ADMIN } from "@/lib/admin-lol";
import { AdminBackLink } from "@/components/admin/AdminBackLink";
import { adminHref, adminReturn } from "@/lib/admin-navigation";
import { notFound } from "next/navigation";
import { getMatchReviewWorkspace } from "@soop-lol/core/lib/db/ck";
import { getMatchReviewEvidence } from "@soop-lol/core/lib/db/match-review";
import { listOverviewWorkList } from "@soop-lol/core/lib/db/match-overview";
import { getMatchSeriesContext } from "@soop-lol/core/lib/db/match-series-review";
import { MatchReviewer } from "@/components/admin/MatchReviewer";
import { matchEvidence, matchReviewTitle, nextUncompleted, workPosition } from "@/components/admin/ck-match-review";
import { reviewMatchData } from "@/lib/ck-review-data";
import { reviewListScopeFromHref } from "@/lib/lol-review-list";

export const dynamic = "force-dynamic";
export const metadata = { title: "경기 검수" };

/**
 * 경기 하나의 검수 화면 — **모든 검수 입구가 여기로 온다.** 분류(CK·대회)나 시점 기록 유무에 따라
 * 대회 화면·VOD 화면으로 보내지 않는다(2026-10-11). 같은 경기는 어디서 열어도 같은 값·같은 근거다.
 * - 근거: 이 경기에 연결된 사진(모든 방송) + 방송별 판독(getMatchReviewEvidence)
 * - 작업 목록: 돌아갈 목록 주소(`from`)를 목록 화면과 같은 규칙으로 풀어 같은 범위·같은 순서로 만든다
 */
export default async function MatchReviewPage({ params, searchParams }: {
  params: Promise<{ matchId: string }>; searchParams: Promise<{ focus?: string; from?: string; tab?: string }>;
}) {
  const { matchId: routeId } = await params;
  let matchId: string;
  try { matchId = decodeURIComponent(routeId); } catch { notFound(); }
  const query = await searchParams;
  // 서로 기다릴 필요가 없는 읽기는 한꺼번에 시작한다. 작업 목록은 들어온 주소에 모음(협곡·칼바람)이 있으면 바로,
  // 없으면 경기를 읽은 뒤 정한다(2026-10-12: 순서대로 기다리던 것을 병렬로 — 검수 화면 이동 속도).
  const wsPromise = getMatchReviewWorkspace(matchId);
  const vodsPromise = getMatchReviewEvidence(matchId);
  const seriesPromise = getMatchSeriesContext(matchId);
  const workFor = async (listCollection: ReturnType<typeof adminLoLCollection>) => {
    const list = adminReturn(query.from, LOL_ADMIN[listCollection ?? "rift"].queue);
    const listScope = reviewListScopeFromHref(list);
    return listScope ? listOverviewWorkList(listScope.opts) : null;
  };
  const early = adminLoLCollection(query.from);
  const earlyWork = early ? workFor(early) : null;
  const ws = await wsPromise;
  if (!ws) notFound();
  const collection = early ?? (inLoLCollection(ws.detail.match, "aram") ? "aram" : "rift");
  const from = adminReturn(query.from, LOL_ADMIN[collection].queue);
  const [vods, work, series] = await Promise.all([vodsPromise, earlyWork ?? workFor(collection), seriesPromise]);
  if (!series) notFound();
  // 사진 계산(연결 사진 + 같은 구간 참고 사진)은 서버에서 끝낸다 — 방송의 사진 수백 장을 화면으로 보내지 않는다.
  // 작업 목록 전체(수천 건)가 아니라 이 경기의 자리와 앞뒤·다음 미완료만 화면으로 보낸다.
  const nav = work ? { ...workPosition(work, matchId), nextUncompleted: nextUncompleted(work, matchId) } : null;
  const evidence = matchEvidence(matchId, vods).map(({ vod, frames, linked, reference }) => ({
    vod: { lead_id: vod.lead_id, source_key: vod.source_key, title: vod.title, url: vod.url, streamer_name: vod.streamer_name, pov: vod.pov },
    frames, linked, reference,
  }));
  // 시리즈 비교 화면은 검색어로 시리즈 키를 찾는다(목록 검색이 시리즈 키를 본다).
  const compareHref = series.series ? adminHref(LOL_ADMIN[collection].compare, { q: series.series.id, queue: "all", review: "all" }) : null;
  const match = reviewMatchData(ws.detail);
  const event = ws.events.find((e) => e.id === match.event_id) ?? null;
  return <div className="ck-review-page">
    <header className="ck-review-page-head">
      <AdminBackLink fallback={from}>검수 목록</AdminBackLink>
      <h1 className="min-w-0 flex-1 truncate text-base text-ink-200">{matchReviewTitle(match, event?.name ?? null)}</h1>
      <p className="flex shrink-0 items-center gap-2 text-[11px] text-ink-400">
        <span className="font-mono">{match.match_id}</span>
        {match.source_url && <a href={match.source_url} target="_blank" rel="noreferrer" className="text-accent-400">출처 열기 ↗</a>}
      </p>
    </header>
    <MatchReviewer key={matchId} match={match} evidence={evidence} series={series} compareHref={compareHref} streamers={ws.streamers} events={ws.events} nav={nav} from={from}
      initialFocus={query.focus} />
  </div>;
}
