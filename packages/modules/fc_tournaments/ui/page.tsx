/**
 * FC 대회 모듈 화면. host 가 /fc/tournaments 와 /fc/tournaments/[slug] 에 띄운다.
 * core 의 FC 공개 조회를 계약으로 읽는다. 경기·스트리머 링크는 core 화면(/fc/m, /fc/s)이다.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { fcoMetadata, getFcoEvent, listFcoEventGames, listFcoEvents } from "@soop-lol/core/lib/contract";
import { fcDate, FcoMatchList, FcoStatsTable, FcoTournamentPlayers } from "../../../ui/fc/fco-records.tsx";
import { RecordContentPanel, RecordEventItem, RecordEventList } from "../../../ui/record-structure.tsx";
import { FcoSeriesSummary } from "./fco-series.tsx";
import { tournamentDetailHref, tournamentsIndexHref } from "./paths.ts";


type Props = {
  params: Record<string, string>;
  searchParams: Record<string, string | string[] | undefined>;
};

const loadEvent = cache(getFcoEvent);

export async function generateMetadata({ params }: Props) {
  if (!params.slug) return { title: "대회" };
  return { title: (await loadEvent(params.slug))?.name ?? "대회" };
}

export default async function FcTournaments({ params }: Props) {
  return params.slug ? <Detail slug={params.slug} /> : <Index />;
}

async function Index() {
  const events = await listFcoEvents();
  return <div className="arena-workspace record-workspace"><div className="record-main">
    <p className="fc-eyebrow">TOURNAMENT ARCHIVE</p><h1 className="fc-title">대회</h1>
    <p className="fc-desc">대회별로 확인된 경기와 당시 스쿼드, 경기 지표를 묶어 봅니다.</p>
    <RecordContentPanel className="fc-section fc-tab-panel">
      {events.length ? <RecordEventList>{events.map((event) => <RecordEventItem key={event.id}><div className="record-event-item-split">
        <Link href={tournamentDetailHref(event.slug)}>{event.name} →</Link>
        <span>{event.starts_at ? fcDate(event.starts_at) : "일정 미정"} · {event.organizer ?? "주최 미상"} · 확인된 경기 {event.game_count}개</span>
      </div></RecordEventItem>)}</RecordEventList> : <div className="fc-empty">등록된 FC 온라인 대회가 없습니다.</div>}
    </RecordContentPanel>
  </div><aside className="record-sidebar record-sidebar-empty" aria-label="추가 정보" /></div>;
}

async function Detail({ slug }: { slug: string }) {
  const event = await loadEvent(slug);
  if (!event) notFound();
  const games = await listFcoEventGames(event.id);
  const names = games.length ? (await fcoMetadata()).names : new Map<number, string>();
  return <div className="arena-workspace record-workspace"><div className="record-main">
    <p className="fc-eyebrow">TOURNAMENT</p><h1 className="fc-title">{event.name}</h1>
    <p className="fc-desc">{event.starts_at ? fcDate(event.starts_at) : "일정 미정"} · {event.organizer ?? "주최 미상"} · 확인된 경기 {games.length}개</p>
    {event.source_url && <p className="mt-3"><a className="fc-card-link" href={event.source_url} target="_blank" rel="noreferrer">대회 출처 ↗</a></p>}
    <RecordContentPanel className="fc-section fc-tab-panel"><h2>대회 스탯표</h2>
      <p className="fc-desc mb-4">이 대회에 연결해 확인한 경기만 집계합니다. 경기 수가 늘면 기록도 갱신됩니다.</p>
      <FcoStatsTable games={games} />
    </RecordContentPanel>
    <RecordContentPanel className="fc-section fc-tab-panel"><h2>선수별 대회 기록</h2>
      <FcoTournamentPlayers games={games} names={names} />
    </RecordContentPanel>
    <RecordContentPanel className="fc-section fc-tab-panel"><h2>다전제</h2>
      <p className="fc-desc mb-4">세트를 한 판으로 접어 시리즈 승패를 봅니다. 3판2선승 같은 형식은 근거로 확인한 것만 표기합니다.</p>
      <FcoSeriesSummary games={games} />
    </RecordContentPanel>
    <RecordContentPanel className="fc-section fc-tab-panel"><h2>경기별 기록과 당시 스쿼드</h2><FcoMatchList games={games} /></RecordContentPanel>
    <p className="mt-6"><Link className="fc-card-link" href={tournamentsIndexHref()}>← 대회 목록</Link></p>
  </div><aside className="record-sidebar record-sidebar-empty" aria-label="추가 정보" /></div>;
}
