import { notFound } from "next/navigation";

import { getFcoReviewWorkspace, listFcoEventOptions } from "@soop-lol/core/lib/games/fconline/context";

import { FcoWorkspace } from "@/components/admin/FcoWorkspace";

export const dynamic = "force-dynamic";

/**
 * 검수 작업대 — 단위 하나. URL 은 두 가지다:
 *   /admin/fco/event-<uuid>       행사 단위 (대회 전 경기가 한 묶음)
 *   /admin/fco/<넥슨matchId>      단독 경기 단위
 * `event-` 접두사로 가른다 — 넥슨 matchId 는 hex 라 겹치지 않는다.
 */
async function loadUnit(unitId: string) {
  const units = unitId.startsWith("event-")
    ? await getFcoReviewWorkspace({ eventId: unitId.slice("event-".length) })
    : await getFcoReviewWorkspace({ providerMatchId: unitId });
  return units[0] ?? null;
}

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
  const unit = await loadUnit(unitId).catch(() => null);
  return { title: unit ? `검수 · ${unit.title}` : "FC 맥락 검수" };
}

export default async function FcoUnitPage({ params }: { params: Promise<{ unitId: string }> }) {
  const { unitId } = await params;
  // 잘못된 uuid 형식은 DB 가 던진다 — 404 로 받는다.
  const unit = await loadUnit(unitId).catch(() => null);
  if (!unit) notFound();
  // 행사 검색 선택지 — 화면에서 바로 바꿀 수 있어야 하므로 같이 내려준다.
  const [eventOptions, starts] = await Promise.all([
    listFcoEventOptions(),
    vodStarts([...new Set(unit.evidences.map((e) => e.vod_title_no).filter((v): v is number => v != null))]),
  ]);

  return (
    <div className="ck-review-page">
      <div className="ck-review-page-head">
        <p className="text-[11px] leading-relaxed text-ink-500">
          ↑↓ 큐 이동 · ←→ 고른 경기(또는 대회 공통) 안에서 프레임 이동.
          경기 사실(점수·승패)은 넥슨 API 가 정본이라 여기서 고치지 않습니다.
        </p>
      </div>
      <FcoWorkspace unit={unit} eventOptions={eventOptions} vodStarts={starts} />
    </div>
  );
}
