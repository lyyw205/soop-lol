/**
 * FC 리더보드 모듈 화면. host 가 /fc/leaderboard 에 띄운다.
 * core 는 스트리머별 집계만 준다 — **줄 세우는 규칙은 이 모듈의 것이다.**
 */
import Link from "next/link";
import { listFcoLeaderboard, type FcoRankRow } from "@soop-lol/core/lib/contract";

/** 승이 많은 순 → 골 → 경기 수 → 이름. */
const byStanding = (a: FcoRankRow, b: FcoRankRow) =>
  b.wins - a.wins || b.goals - a.goals || b.games - a.games || a.name.localeCompare(b.name, "ko");

export function generateMetadata() {
  return { title: "리더보드" };
}

export default async function FcLeaderboard() {
  const rows = (await listFcoLeaderboard()).sort(byStanding);
  return <>
    <p className="fc-eyebrow">STREAMER BOARD</p><h1 className="fc-title">리더보드</h1>
    <p className="fc-desc">등록된 스트리머의 수집 경기 기준입니다. 전체 FC 온라인 이용자 순위가 아닙니다.</p>
    <section className="fc-section">
      {rows.length ? <div className="fc-table-wrap"><table className="fc-table">
        <thead><tr><th>스트리머</th><th>경기</th><th>승</th><th>무</th><th>패</th><th>승률</th><th>골</th></tr></thead>
        <tbody>{rows.map((row, i) => <tr key={row.id}>
          <td>{i + 1}. <Link href={`/fc/s/${row.slug}`}>{row.name}</Link></td>
          <td>{row.games}</td><td>{row.wins}</td><td>{row.draws}</td><td>{row.losses}</td>
          <td>{row.games ? `${Math.round(row.wins / row.games * 100)}%` : "—"}</td><td>{row.goals}</td>
        </tr>)}</tbody>
      </table></div> : <div className="fc-empty">경기 데이터가 쌓이면 리더보드가 표시됩니다.</div>}
    </section>
  </>;
}
