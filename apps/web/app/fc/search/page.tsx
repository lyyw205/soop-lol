import Link from "next/link";
import { profileHref } from "@soop-lol/core/lib/site-paths";
import { listFcoPeople } from "@soop-lol/core/lib/db/fconline";
import { Avatar } from "@/components/avatar";
import { SiteLogo } from "@/components/site-logo";
import { FcRecordSearch } from "../../../../../packages/ui/fc/fco-record-search";
import { fcVersusIndexHref } from "@/lib/module-links";

export const metadata = { title: { absolute: "FC 온라인 전적 검색 · SOOP SEEK" } };
export const dynamic = "force-dynamic";

export default async function FcSearch() {
  const people = await listFcoPeople();
  return <>
    <div className="arena-workspace record-workspace">
      <div className="record-main">
        <div><SiteLogo className="fc-search-brand" /><h1 className="fc-title">전적 검색</h1>
          <p className="fc-desc">개인 기록과 두 스트리머의 상대전적을 한곳에서 찾아보세요.</p></div>
        <div className="fc-section"><FcRecordSearch people={people} versusPath={fcVersusIndexHref()} /></div>
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
      </div>
      <aside className="record-sidebar record-sidebar-empty" aria-label="추가 정보" />
    </div>
  </>;
}
