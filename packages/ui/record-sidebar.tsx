import Link from "next/link";
import { profileHref } from "@soop-lol/core/lib/contract";
import type { ReactNode } from "react";
import { RecordAwards, RecordChampions, type RecordAward, type RecordChampion } from "./record-profile-info";

export function RecordSidebar({ name, slug, isPro, portrait, placements, awards, champions, children }: {
  name: string; slug: string; isPro: boolean; portrait: ReactNode;
  placements: { total: number; buckets: { key: string; count: number }[] };
  awards: RecordAward[];
  champions: RecordChampion[];
  children?: ReactNode;
}) {
  return <aside className="arena-rail record-sidebar" aria-label="스트리머 정보">
    <section className="arena-panel">
      <h2>스트리머 정보</h2>
      <Link className="arena-profile-mini" href={profileHref("lol", slug)}>{portrait}<span><strong>{name}</strong><small>{isPro ? "前 프로 · " : ""}스트리머 프로필</small></span></Link>
      <div className="arena-mini-stats">
        <div><strong>{placements.buckets.find((b)=>b.key==='champion')?.count ?? 0}</strong><small>우승</small></div>
        <div><strong>{placements.buckets.find((b)=>b.key==='runnerup')?.count ?? 0}</strong><small>준우승</small></div>
        <div><strong>{placements.total}</strong><small>참가 대회</small></div>
      </div>
      <Link className="arena-panel-link" href={profileHref("lol", slug, { tab: "events" })}>통산 수상 경력 보기　→</Link>
    </section>
    <section className="arena-panel">
      <h2>최근 수상 경력</h2>
      <RecordAwards awards={awards} href={profileHref("lol", slug, { tab: "events" })} />
    </section>
    <section className="arena-panel">
      {/* 챔피언 탭의 기본 보기(협곡 · 전체 진행 방식 · 전체 기간)와 같은 수다 — 같은 세트·같은 함수(listChampions). */}
      <h2>모스트 챔피언 <small className="record-sidebar-note">협곡 · 통산</small></h2>
      <RecordChampions champions={champions} href={profileHref("lol", slug, { tab: "champions" })} />
    </section>
    {children}
  </aside>;
}
