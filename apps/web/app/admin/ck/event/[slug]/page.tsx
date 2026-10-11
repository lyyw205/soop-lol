import { adminLoLCollection, LOL_ADMIN } from "@/lib/admin-lol";
import { redirect } from "next/navigation";

import { adminHref } from "@/lib/admin-navigation";

export const dynamic = "force-dynamic";

/**
 * 예전 대회 검수 주소(북마크·옛 링크)를 살려 둔다 — 그 대회만 걸러 낸 검수 목록으로 보낸다.
 *
 * ★ 예전엔 CK 대회를 시점(VOD) 칩으로 골라 그 VOD 기준으로 큐·사진·편집 대상을 꾸렸다. 방송만 바꿨는데
 *   고른 경기가 바뀌고, 같은 대회인데 VOD 마다 경기 수가 달랐다(2026-10-11). 이제 검수는 경기 화면 하나가
 *   모든 방송의 근거를 보여 주고, 대회는 목록의 묶음(필터)일 뿐이다.
 */
export default async function CkEventReviewPage({ params, searchParams }: {
  params: Promise<{ slug: string }>; searchParams: Promise<{ review?: string; focus?: string; from?: string }>;
}) {
  const query = await searchParams;
  const { slug } = await params;
  const listPath = LOL_ADMIN[adminLoLCollection(query.from) ?? "rift"].queue;
  redirect(adminHref(listPath, { event: slug, queue: "all", review: query.review ?? "all", focus: query.focus }));
}
