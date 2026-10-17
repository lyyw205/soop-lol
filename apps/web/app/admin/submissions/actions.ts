"use server";

import { revalidatePath } from "next/cache";

import { MemberError } from "@soop-lol/core/lib/db/member";
import { markSubmissionDuplicate, rejectSubmission, verifySubmission } from "@soop-lol/core/lib/db/submission";
import { ReviewConflictError } from "@soop-lol/core/lib/db/review-patch";
import { cancelVodRequest, requestVodByAdmin } from "@soop-lol/core/lib/db/vod-request";

import type { ActionState } from "@/lib/action-state";
import { requireAdmin } from "@/lib/admin-auth";

/**
 * 제보 처리 — 판단(상태 전이·반영·되돌리기·충돌)은 core 의 submission.ts 가 한다.
 * ★ 액션마다 requireAdmin 을 다시 부른다 — 액션은 경로와 무관한 POST 끝점이다(admin-auth.ts).
 */
const actor = () => process.env.ADMIN_USER ?? "admin";
const text = (form: FormData, key: string) => String(form.get(key) ?? "");

async function run(work: () => Promise<unknown>, done: string): Promise<ActionState> {
  await requireAdmin();
  try {
    await work();
  } catch (error) {
    if (error instanceof MemberError || error instanceof ReviewConflictError) return { ok: false, message: error.message };
    throw error;
  }
  // 확인·반려는 공개 집계를 바꾼다(확인 전 표시가 사라지고 점수에 들어가거나 값이 되돌아간다).
  revalidatePath("/", "layout");
  return { ok: true, message: done };
}

export async function verifySubmissionAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return run(() => verifySubmission(text(form, "id"), actor(), text(form, "note")), "확인했습니다.");
}
export async function rejectSubmissionAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return run(() => rejectSubmission(text(form, "id"), actor(), text(form, "note")), "반려했습니다.");
}
export async function duplicateSubmissionAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return run(() => markSubmissionDuplicate(text(form, "id"), text(form, "of"), actor()), "중복으로 합쳤습니다.");
}

/** VOD 판독 요청(0097) — 이 PC 의 ck-auto 가 다음 시간별 조회 때 대기열 맨 앞에 넣는다. 공개 화면은 바뀌지 않는다. */
async function runRequest(work: (actor: string) => Promise<string>): Promise<ActionState> {
  const { actor: who } = await requireAdmin();
  let message: string;
  try { message = await work(who); } catch (error) {
    if (error instanceof MemberError) return { ok: false, message: error.message };
    throw error;
  }
  revalidatePath("/admin/submissions");
  return { ok: true, message };
}

export async function requestVodAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runRequest(async (who) => {
    const r = await requestVodByAdmin(text(form, "vod"), text(form, "note"), who);
    return r.created ? `vod:${r.title_no} 판독을 요청했습니다. 다음 시간별 조회 때 대기열 맨 앞에 들어갑니다.` : `vod:${r.title_no} 은 이미 열린 운영자 요청이 있습니다.`;
  });
}
export async function cancelVodRequestAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runRequest(async (who) => { await cancelVodRequest(Number(text(form, "id")), who); return "요청을 거뒀습니다."; });
}
