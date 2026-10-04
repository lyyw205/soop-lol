import { cache } from "react";
import { fcoReviewQueueIds } from "@soop-lol/core/lib/db/review-priority";
import { AdminBackLink } from "@/components/admin/AdminBackLink";
import { notFound } from "next/navigation";

import { getFcoReviewWorkspace, listFcoEventOptions } from "@soop-lol/core/lib/games/fconline/context";

import { buildMatchUnits, eventScreenMatchIds, listPickableStreamers } from "@soop-lol/core/lib/games/fconline/match-units";

import { FcoMatchWorkbench } from "@/components/admin/FcoMatchWorkbench";
import { loadViewerVods } from "@/lib/vod-frames";

export const dynamic = "force-dynamic";

/**
 * 검수 작업대 — 단위 하나. URL 은 두 가지다:
 *   /admin/fco/event-<uuid>       행사 단위 (대회 전 경기가 한 묶음)
 *   /admin/fco/<넥슨matchId>      단독 경기 단위
 * `event-` 접두사로 가른다 — 넥슨 matchId 는 hex 라 겹치지 않는다.
 */
const loadUnit = cache(async (unitId: string) => {
  const units = unitId.startsWith("event-")
    ? await getFcoReviewWorkspace({ eventId: unitId.slice("event-".length) })
    : await getFcoReviewWorkspace({ providerMatchId: unitId });
  return units[0] ?? null;
});

/**
 * VOD 방송 시작 시각(broad_start) — 프레임의 실제 시각을 세워 경기별로 묶는 데 쓴다.
 * DB 에 두지 않는다. 못 받으면 비워 두고, 화면은 저장된 연결로 묶는다(틀려도 깨지진 않는다).
 */
async function vodStarts(vods: number[]): Promise<Record<number, number>> {
  const out: Record<number, number> = {};
  await Promise.all(vods.map(async (vod) => {
    try {
      const r = await fetch("https://api.m.sooplive.co.kr/station/video/a/view", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "Mozilla/5.0", Referer: "https://vod.sooplive.com/" },
        body: `nTitleNo=${vod}&nApiLevel=10&nPlaylistIdx=0`,
        signal: AbortSignal.timeout(5000),
      });
      const j = await r.json() as { result?: number; data?: { broad_start?: string } };
      const start = j?.result === 1 ? j.data?.broad_start : undefined;
      if (start) out[vod] = Date.parse(`${start.replace(" ", "T")}+09:00`);
    } catch { /* 시각을 모르면 저장된 연결로 묶는다 */ }
  }));
  return out;
}

export async function generateMetadata({ params }: { params: Promise<{ unitId: string }> }) {
  const { unitId } = await params;
  const unit = await loadUnit(unitId);
  return { title: unit ? `검수 · ${unit.title}` : "FC 맥락 검수" };
}

export default async function FcoUnitPage({ params, searchParams }: { params: Promise<{ unitId: string }>; searchParams: Promise<{ match?: string; from?: string }> }) {
  const { unitId } = await params;
  const { match, from } = await searchParams;
  // 잘못된 uuid 형식은 DB 가 던진다 — 404 로 받는다.
  const unit = await loadUnit(unitId);
  if (!unit) notFound();
  // 행사 검색 선택지 — 화면에서 바로 바꿀 수 있어야 하므로 같이 내려준다.
  // 같은 작업대(FcoMatchWorkbench) — 경기는 정본 경기 하나 = 키 하나, 시점 칩으로 넥슨 기록·VOD 들을 바꿔 본다.
  // 대회면 넥슨 기록 후보(결정·브래킷 순서)에 더해 대회에 붙은 화면 기록 정본도 넣는다(넥슨 기록만 보면 어디에도 안 나온다).
  const extra = unit.kind === "event" && unit.event ? await eventScreenMatchIds(unit.event.id) : [];
  const order = [...unit.matches.map((m) => m.match_id), ...extra.filter((id) => !unit.matches.some((m) => m.match_id === id))];
  const built = await buildMatchUnits(order);
  const reviewQueueIds = await fcoReviewQueueIds(order, from);
  const matches = order.map((id) => built.find((m) => m.match_id === id)).filter((m): m is NonNullable<typeof m> => !!m);
  const vodIds = [...new Set(matches.flatMap((m) => m.views.map((v) => v.vod)).filter((v): v is string => !!v))];
  const [eventOptions, starts, vods, streamers] = await Promise.all([
    listFcoEventOptions(), vodStarts(vodIds.map(Number)), loadViewerVods(vodIds), listPickableStreamers(),
  ]);

  return (
    <div className="ck-review-page">
      <div className="ck-review-page-head">
        <div className="min-w-0">
          <AdminBackLink fallback="/admin/fco">← FC 경기 목록</AdminBackLink>
          <h1 className="mt-1 truncate text-lg font-semibold text-ink-200">{unit.title}</h1>
          <p className="mt-0.5 text-[11px] leading-relaxed text-ink-500">
            ↑↓ 경기 · ← → 프레임 · 칩으로 시점 전환. 넥슨 기록이 정본인 경기는 점수·승패를 여기서 고치지 않습니다.
          </p>
        </div>
      </div>
      <FcoMatchWorkbench reviewQueueIds={reviewQueueIds} key={unit.id} matches={matches} streamers={streamers} vods={vods} eventOptions={eventOptions} initialMatchId={match}
        event={unit.kind === "event" ? { unit, vodStarts: starts } : undefined}
        queueTitle={unit.kind === "event" ? "대회 경기" : "경기"} />
    </div>
  );
}
