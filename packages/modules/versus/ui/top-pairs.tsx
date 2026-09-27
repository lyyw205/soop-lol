import { listPublicStreamers, listEncountersBetween } from "@soop-lol/core/lib/contract";
import { topPairs } from "../server/index.ts";
import Link from "next/link";
import { Portrait } from "./fixture.tsx";

/** 목록 숫자는 맞대결 세트 승수. 같은 팀 기록은 포함하지 않는다. */
export async function TopPairs({ exclude }: { exclude?: [string, string] }) {
  const [pairs, people] = await Promise.all([topPairs(8), listPublicStreamers()]);
  const shown = pairs.filter((p) => !exclude || ![p.a_slug, p.b_slug].every((slug) => exclude.includes(slug))).slice(0, 3);
  const items = await Promise.all(shown.map(async (p) => {
    const x = people.find((s) => s.slug === p.a_slug);
    const y = people.find((s) => s.slug === p.b_slug);
    if (!x || !y) return null;
    const rows = (await listEncountersBetween(x.streamer_id, y.streamer_id)).filter((g) => g.relation === "opponent");
    const xFirst = [x.streamer_id, y.streamer_id].sort()[0] === x.streamer_id;
    const wins = rows.filter((g) => (xFirst ? g.a_outcome : g.b_outcome) === "win").length;
    const losses = rows.length - wins;
    return <li key={`${x.slug}-${y.slug}`}><Link className="arena-pair-row"
      href={`/m/versus?a=${encodeURIComponent(x.slug)}&b=${encodeURIComponent(y.slug)}`}
      aria-label={`${x.display_name} 대 ${y.display_name} · 세트 ${wins} 대 ${losses}`}>
      <span className="arena-pair-person"><Portrait person={x} /><span title={x.display_name}>{x.display_name}</span></span>
      <span className="arena-pair-score">
        <strong data-leading={wins > losses}>{wins}</strong><span>:</span><strong data-leading={losses > wins}>{losses}</strong>
      </span>
      <span className="arena-pair-person"><Portrait person={y} /><span title={y.display_name}>{y.display_name}</span></span>
    </Link></li>;
  }));
  return <section className="arena-panel arena-pairs-sidebar" id="related-records">
    <h2>자주 만난 매치업 <small className="record-sidebar-note">세트 기준</small></h2>
    {items.some(Boolean) ? <ul className="arena-pair-list">{items}</ul> : <p className="text-xs text-ink-400">아직 다른 맞대결 기록이 없습니다.</p>}
  </section>;
}
