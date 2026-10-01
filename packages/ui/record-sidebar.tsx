import Link from "next/link";
import type { ReactNode } from "react";
import { RecordAwards, RecordChampions, type RecordAward, type RecordChampion } from "./record-profile-info";

export function RecordSidebar({ name, slug, isPro, portrait, placements, awards, champions, children }: {
  name: string; slug: string; isPro: boolean; portrait: ReactNode;
  placements: { total: number; buckets: { key: string; count: number }[]; exhibition: { champion: number; runnerup: number } };
  awards: RecordAward[];
  champions: RecordChampion[];
  children?: ReactNode;
}) {
  return <aside className="arena-rail record-sidebar" aria-label="스트리머 정보">
    <section className="arena-panel">
      <h2>스트리머 정보</h2>
      <Link className="arena-profile-mini" href={`/s/${slug}`}>{portrait}<span><strong>{name}</strong><small>{isPro ? "前 프로 · " : ""}스트리머 프로필</small></span></Link>
      <div className="arena-mini-stats">
        <div><strong>{placements.buckets.find((b)=>b.key==='champion')?.count ?? 0}</strong><small>우승</small></div>
        <div><strong>{placements.buckets.find((b)=>b.key==='runnerup')?.count ?? 0}</strong><small>준우승</small></div>
        <div><strong>{placements.total}</strong><small>참가 대회</small></div>
      </div>
      {/* 올스타전·이벤트 매치 우승은 위 숫자에 안 넣는다(0052). 있으면 한 줄로 따로 알린다. */}
      {placements.exhibition.champion + placements.exhibition.runnerup > 0 && <small className="record-sidebar-note">
        올스타·이벤트전 {[placements.exhibition.champion ? `우승 ${placements.exhibition.champion}` : "", placements.exhibition.runnerup ? `준우승 ${placements.exhibition.runnerup}` : ""].filter(Boolean).join(" · ")} 별도
      </small>}
      <Link className="arena-panel-link" href={`/s/${slug}?tab=events`}>통산 수상 경력 보기　→</Link>
    </section>
    <section className="arena-panel">
      <h2>최근 수상 경력</h2>
      <RecordAwards awards={awards} href={`/s/${slug}?tab=events`} />
    </section>
    <section className="arena-panel">
      <h2>모스트 챔피언 <small className="record-sidebar-note">통산</small></h2>
      <RecordChampions champions={champions} href={`/s/${slug}?tab=champions`} />
    </section>
    {children}
  </aside>;
}
