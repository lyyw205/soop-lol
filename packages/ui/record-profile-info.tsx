import Link from "next/link";
import { Trophy } from "lucide-react";

export type RecordChampion = { id: number; name: string; image?: string; games: number };
export type RecordAward = { id: string; title: string; placement: string | null; year: number; team: string | null };

/** Same career data in a sidebar or an integrated profile card. */
export function RecordChampions({ champions, href, layout = "rail" }: {
  champions: RecordChampion[]; href: string; layout?: "rail" | "profile";
}) {
  if (!champions.length) return <p className="profile-info-empty">챔피언 기록이 아직 없습니다.</p>;
  return <div className={layout === "rail" ? "arena-champions" : "profile-champions"}>
    {champions.map((c, index) => <Link key={c.id} href={href} title={c.name}>
      {layout === "profile" ? <>
        <span className="profile-champion-image">{c.image && <img src={c.image} alt="" />}<b>{index + 1}</b></span>
        <span><strong>{c.name}</strong><small>{c.games}판</small></span>
      </> : <>{c.image && <img src={c.image} alt={c.name} />}<small>{c.games}판</small></>}
    </Link>)}
  </div>;
}

export function RecordAwards({ awards, href, layout = "rail" }: {
  awards: RecordAward[]; href: string; layout?: "rail" | "profile";
}) {
  if (!awards.length) return <p className="profile-info-empty">등록된 우승·준우승 기록이 없습니다.</p>;
  return <div className={layout === "profile" ? "profile-awards" : undefined}>
    {awards.map((a) => <Link className={layout === "rail" ? "arena-award" : "profile-award"} key={a.id} href={href}>
      {layout === "rail" ? <span className="arena-award-icon"><Trophy size={17} /></span>
        : <span className="profile-award-rank" data-place={a.placement}>{a.placement ?? "수상"}</span>}
      <span><strong>{layout === "rail" && a.placement ? `${a.placement} · ` : ""}{a.title}</strong><small>{a.year} · {a.team ?? "대회 기록"}</small></span>
    </Link>)}
  </div>;
}
