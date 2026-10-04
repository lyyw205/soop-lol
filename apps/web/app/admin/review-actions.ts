"use server";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/admin-auth";
import { completeReviewBatch } from "@soop-lol/core/lib/db/review-batch";
import type { ActionState } from "@/lib/action-state";
export async function completeBatchAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  await requireAdmin();
  try {
    const game = String(form.get('game'));
    if (game !== 'lol' && game !== 'fconline') throw new Error('게임이 올바르지 않습니다.');
    const count = await completeReviewBatch(game, JSON.parse(String(form.get('targets'))));
    revalidatePath('/admin', 'layout');
    return { ok: true, message: `확인한 ${count}경기를 완료했습니다.` };
  } catch (e) { return { ok: false, message: e instanceof Error ? e.message : '완료 처리에 실패했습니다.' }; }
}
