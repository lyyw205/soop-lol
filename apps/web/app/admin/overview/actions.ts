"use server";

import { revalidatePath } from "next/cache";

import { setMatchReviewCompleted } from "@soop-lol/core/lib/db/ck";
import { getOverviewSeriesSets, type OverviewSetDetail } from "@soop-lol/core/lib/db/match-overview";

import type { LoLReviewCollection } from "@soop-lol/core/lib/db/lol-review-scope";

import { requireAdmin } from "@/lib/admin-auth";

export async function loadOverviewSetsAction(key: string, collection?: LoLReviewCollection): Promise<OverviewSetDetail[]> {
  await requireAdmin();
  return getOverviewSeriesSets(key, collection);
}

/**
 * 검수 완료 토글. 검수큐와 같은 함수·같은 버전 검사를 쓴다.
 * 펼친 세트는 클라이언트가 들고 있으므로 바뀐 버전을 반영한 세트 목록을 돌려준다.
 */
export async function toggleOverviewReviewAction(key: string, matchId: string, completed: boolean, version: number, collection?: LoLReviewCollection): Promise<
  { ok: true; sets: OverviewSetDetail[] } | { ok: false; message: string; sets: OverviewSetDetail[] }
> {
  await requireAdmin();
  try {
    await setMatchReviewCompleted(matchId, completed, version);
    revalidatePath("/admin", "layout");
    return { ok: true, sets: await getOverviewSeriesSets(key, collection) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error), sets: await getOverviewSeriesSets(key, collection) };
  }
}
