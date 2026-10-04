import { listPublicStreamers, listEncountersBetween, type PublicStreamer } from "@soop-lol/core/lib/contract";
import { topPairs } from "../server/index.ts";
import Link from "next/link";
import { Portrait } from "./fixture.tsx";
import { versusHref } from "./paths.ts";

/** 순위와 승수 모두 맞라인으로 상대한 세트만 센다. */
export async function TopPairs({ person, exclude }: { person: PublicStreamer; exclude?: [string, string] }) {
  const [pairs, people] = await Promise.all([topPairs(4, true, person.slug), listPublicStreamers()]);
  const shown = pairs.filter((p) => !exclude || ![p.a_slug, p.b_slug].every((slug) => exclude.includes(slug))).slice(0, 3);
  const items = await Promise.all(shown.map(async (p) => {
    const x = person;
    const y = people.find((s) => s.slug === (p.a_slug === person.slug ? p.b_slug : p.a_slug));
    if (!y) return null;
    const rows = (await listEncountersBetween(x.streamer_id, y.streamer_id)).filter((g) => g.relation === "opponent" && g.is_lane_matchup);
    const xFirst = [x.streamer_id, y.streamer_id].sort()[0] === x.streamer_id;
    const wins = rows.filter((g) => (xFirst ? g.a_outcome : g.b_outcome) === "win").length;
    const losses = rows.length - wins;
    return <li key={`${x.slug}-${y.slug}`}><Link className="arena-pair-row"
      href={versusHref({ a: x.slug, b: y.slug, relation: "lane" })}
      aria-label={`${x.display_name} 대 ${y.display_name} · 맞라인 세트 ${wins} 대 ${losses}`}>
      <span className="arena-pair-person"><Portrait person={x} /><span title={x.display_name}>{x.display_name}</span></span>
      <span className="arena-pair-score">
        <strong data-leading={wins > losses}>{wins}</strong><span>:</span><strong data-leading={losses > wins}>{losses}</strong>
      </span>
      <span className="arena-pair-person"><Portrait person={y} /><span title={y.display_name}>{y.display_name}</span></span>
    </Link></li>;
  }));
  return <section className="arena-panel arena-pairs-sidebar" id="related-records" aria-label={`${person.display_name}의 자주 만난 맞라인 상대`}>
    <h2>자주 만난 매치업 <small className="record-sidebar-note">맞라인 세트 기준</small></h2>
    {items.some(Boolean) ? <ul className="arena-pair-list">{items}</ul> : <p className="text-xs text-ink-400">아직 다른 맞라인 기록이 없습니다.</p>}
  </section>;
}
