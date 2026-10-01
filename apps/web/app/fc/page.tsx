import Link from "next/link";
import { profileHref } from "@soop-lol/core/lib/site-paths";
import { getFeaturedFcoPair, listFcoEvents, listFcoPeople, listFcoVersus } from "@soop-lol/core/lib/db/fconline";
import { fcDate, FcoMatchList } from "../../../../packages/ui/fc/fco-records";
import { Avatar } from "@/components/avatar";
import { FcRecordSearch } from "../../../../packages/ui/fc/fco-record-search";
import { FcoVersusOverview } from "../../../../packages/ui/fc/fco-overview";
import { fcTournamentHref, fcTournamentsIndexHref, fcVersusHref, fcVersusIndexHref } from "@/lib/module-links";
import { RecordContentPanel, RecordEventItem, RecordEventList, RecordSectionTabs } from "@/components/record-structure";

export const metadata = { title: { absolute: "전적 검색 · SOOP FC 온라인" } };
export const dynamic = "force-dynamic";

export default async function FcHome() {
  const [people, events, pair] = await Promise.all([listFcoPeople(), listFcoEvents(), getFeaturedFcoPair()]);
  // 추천 맞대결·최근 대회는 그 화면을 가진 모듈이 있을 때만 보인다 — 없으면 갈 곳이 없는 링크다.
  const a = people.find((person) => person.id === pair?.aId);
  const b = people.find((person) => person.id === pair?.bId);
  const pairHref = a && b ? fcVersusHref(a.slug, b.slug) : null;
  const featuredGames = a && b && pairHref ? await listFcoVersus(a.id, b.id) : [];
  const eventLinks = events.slice(0, 3).flatMap((event) => {
    const href = fcTournamentHref(event.slug);
    return href ? [{ event, href }] : [];
  });
  return <>
    <div className="arena-workspace record-workspace">
      <div className="record-main">
        <div><p className="fc-eyebrow">SOOP FC ONLINE</p><h1 className="fc-title">전적 검색</h1>
          <p className="fc-desc">개인 기록과 두 스트리머의 상대전적을 한곳에서 찾아보세요.</p></div>
        <div className="fc-section"><FcRecordSearch people={people} versusPath={fcVersusIndexHref()} /></div>
        {a && b && pairHref && <>
          <p className="fc-featured-note">많이 맞붙은 스트리머</p>
          <FcoVersusOverview a={a} b={b} games={featuredGames} swapHref={fcVersusHref(b.slug, a.slug) ?? undefined} />
          <RecordSectionTabs active="games" items={[
            { key: "games", label: "경기 기록", href: pairHref },
            { key: "metrics", label: "경기 지표", href: `${pairHref}&tab=metrics` },
            { key: "players", label: "사용 선수", href: `${pairHref}&tab=players` },
          ]} />
          <RecordContentPanel className="fc-tab-panel"><h2>최근 맞대결 <small>{featuredGames.length}경기</small></h2>
            <FcoMatchList games={featuredGames.slice(0, 5)} perspectiveStreamerId={a.id} />
            <p className="fc-featured-more"><Link href={pairHref}>전체 경기 보기 →</Link></p>
          </RecordContentPanel>
        </>}
        <section className="fc-section"><h2>스트리머 바로가기</h2>
        {people.length ? <div className="fc-table-wrap"><table className="fc-table fc-directory-table">
          <thead><tr><th>#</th><th>스트리머</th><th>FC 온라인 감독명</th><th>개인기록</th></tr></thead>
          <tbody>{people.map((person, index) => <tr key={`${person.id}:${person.nickname}`}>
            <td>{index + 1}</td>
            <td><span className="fc-person-cell"><Avatar name={person.name} src={person.image} channelId={person.channel_id} /><Link href={profileHref("fconline", person.slug)}>{person.name}</Link></span></td>
            <td>{person.nickname}</td><td><Link href={profileHref("fconline", person.slug)}>기록 보기 →</Link></td>
          </tr>)}</tbody>
        </table></div> : <div className="fc-empty">연결된 FC 온라인 스트리머가 없습니다.</div>}
        </section>
        {fcTournamentsIndexHref() && <section className="fc-section">
          <h2>최근 대회</h2>
          {eventLinks.length ? <RecordEventList>{eventLinks.map(({ event, href }) => <RecordEventItem key={event.id}><div className="record-event-item-split">
            <Link href={href}>{event.name}</Link>
            <span>{event.starts_at ? fcDate(event.starts_at) : "일정 미정"} · 확인된 경기 {event.game_count}개</span>
          </div></RecordEventItem>)}</RecordEventList> : <div className="fc-empty">등록된 FC 온라인 대회가 없습니다.</div>}
        </section>}
      </div>
      <aside className="record-sidebar record-sidebar-empty" aria-label="추가 정보" />
    </div>
  </>;
}
