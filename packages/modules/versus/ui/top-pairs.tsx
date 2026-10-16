import { listPublicStreamers, type PublicStreamer } from "@soop-lol/core/lib/contract";
import { topLaneOpponents } from "../server/index.ts";
import Link from "next/link";
import { Portrait } from "./fixture.tsx";
import { versusHref } from "./paths.ts";
import { RecordPair } from "../../../ui/record-pair.tsx";

/**
 * 자주 만난 매치업 — 맞라인 세트가 많은 상대 순. 숫자는 **세트·시리즈 둘 다**(RecordPair).
 * ★ 링크가 여는 상대전적 상세의 맞라인 보기(협곡 · 전체 · 전체 기간)와 같은 고르기·같은 세기다.
 *   예전엔 여기만 맞라인 세트 승수를 따로 세서(18:27) 상세(11–16)와 달랐다.
 */
export async function TopPairs({ person, exclude }: { person: PublicStreamer; exclude?: [string, string] }) {
  const people = await listPublicStreamers();
  const bySlug = new Map(people.map((p) => [p.slug, p]));
  const excludeIds = exclude ? exclude.filter((slug) => slug !== person.slug).map((slug) => bySlug.get(slug)?.streamer_id).filter((id): id is string => !!id) : [];
  const rows = await topLaneOpponents(person.streamer_id, 3, excludeIds);
  const byId = new Map(people.map((p) => [p.streamer_id, p]));
  const items = rows.map((r) => {
    const y = byId.get(r.other_id);
    if (!y) return null;
    return <li key={`${person.slug}-${y.slug}`}><Link className="arena-pair-row"
      href={versusHref({ a: person.slug, b: y.slug, relation: "lane" })}
      aria-label={`${person.display_name} 대 ${y.display_name} · 맞라인 전적`}>
      <span className="arena-pair-person"><Portrait person={person} /><span title={person.display_name}>{person.display_name}</span></span>
      {/* 가운데 큰 숫자 = 시리즈 승:패. 세트와 무·미상은 아래 줄 RecordPair 가 함께 보인다. */}
      <span className="arena-pair-score" aria-hidden="true">
        <strong data-leading={r.record.series.win > r.record.series.loss}>{r.record.series.win}</strong><span>:</span><strong data-leading={r.record.series.loss > r.record.series.win}>{r.record.series.loss}</strong>
      </span>
      <span className="arena-pair-person"><Portrait person={y} /><span title={y.display_name}>{y.display_name}</span></span>
      <RecordPair tally={r.record} subject={person.display_name} compact className="arena-pair-record" />
    </Link></li>;
  });
  return <section className="arena-panel arena-pairs-sidebar" id="related-records" aria-label={`${person.display_name}의 자주 만난 맞라인 상대`}>
    <h2>자주 만난 매치업 <small className="record-sidebar-note">협곡 · 맞라인 · {person.display_name} 기준</small></h2>
    {items.some(Boolean) ? <ul className="arena-pair-list">{items}</ul> : <p className="text-xs text-ink-400">아직 다른 맞라인 기록이 없습니다.</p>}
  </section>;
}
