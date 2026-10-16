"use server";

import { revalidatePath } from "next/cache";

import { MemberError } from "@soop-lol/core/lib/db/member";
import { markSubmissionDuplicate, rejectSubmission, verifySubmission } from "@soop-lol/core/lib/db/submission";
import { ReviewConflictError } from "@soop-lol/core/lib/db/review-patch";

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
