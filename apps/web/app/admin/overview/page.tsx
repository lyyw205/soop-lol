import Link from "next/link";

import type { LeadEventKind } from "@soop-lol/core/lib/db/ck";
import { listOverviewSeries } from "@soop-lol/core/lib/db/match-overview";

import { MatchOverview } from "@/components/admin/MatchOverview";
import { Card, EmptyState } from "@/components/ui";
import { EVENT_KIND_LABEL } from "@/lib/admin-labels";

export const metadata = { title: "경기 확인" };
export const dynamic = "force-dynamic";
const KINDS = ["tournament", "ck", "showmatch", "scrim", "other"] as const;

export default async function MatchOverviewPage({ searchParams }: {
  searchParams: Promise<{ kind?: string; review?: string }>;
}) {
  const query = await searchParams;
  const kind = KINDS.includes(query.kind as LeadEventKind) ? query.kind as LeadEventKind : undefined;
  const pending = query.review === "pending";
  const series = await listOverviewSeries({ kind, unreviewed: pending });
  const href = (nextKind: string | undefined, nextPending: boolean) => {
    const q = new URLSearchParams();
    if (nextKind) q.set("kind", nextKind);
    if (nextPending) q.set("review", "pending");
    return `/admin/overview${q.size ? `?${q}` : ""}`;
  };
  const chip = (active: boolean) => `rounded-md border px-3 py-1.5 text-xs ${active
    ? "border-accent-600/40 bg-accent-600/10 text-accent-400"
    : "border-ink-700 text-ink-400 hover:text-ink-200"}`;

  return <Card title="경기 확인" description="입력된 경기의 라인·스트리머·챔피언·KDA 를 시리즈 단위로 펼쳐 확인합니다. 값 수정은 경기 검수에서 합니다.">
    <nav className="mb-4 flex flex-wrap items-center gap-2" aria-label="경기 분류">
      <Link href={href(undefined, pending)} className={chip(!kind)}>전체 분류</Link>
      {KINDS.map(k => <Link key={k} href={href(k, pending)} className={chip(kind === k)}>{EVENT_KIND_LABEL[k]}</Link>)}
    </nav>
    <nav className="mb-3 flex items-center gap-2" aria-label="검수 상태">
      <Link href={href(kind, false)} className={chip(!pending)}>전체</Link>
      <Link href={href(kind, true)} className={chip(pending)}>미검수만</Link>
      <span className="ml-auto flex items-center gap-2 text-[11px]" aria-label="경고 색 안내">
        <span className="overview-flag is-unlinked">미연결</span><span className="overview-flag is-sub">교체</span>
      </span>
      <span className="text-xs text-ink-500">시리즈 {series.length}개 · 세트 {series.reduce((n, s) => n + s.sets.length, 0)}개</span>
    </nav>
    {series.length === 0
      ? <EmptyState>{pending ? "미검수 세트가 있는 경기가 없습니다." : "등록된 경기가 없습니다."}</EmptyState>
      : <MatchOverview series={series} />}
  </Card>;
}
