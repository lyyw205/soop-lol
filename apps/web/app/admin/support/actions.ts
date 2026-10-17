"use server";
import { revalidatePath } from "next/cache";
import { readSessionToken } from "@soop-lol/core/lib/auth/request";
import { replySupportTicket } from "@soop-lol/core/lib/db/support";
import { MemberError } from "@soop-lol/core/lib/db/member";
import { requireAdmin } from "@/lib/admin-auth";
import type { ActionState } from "@/lib/action-state";
export async function answerSupport(_prev: ActionState, form: FormData): Promise<ActionState> {
  await requireAdmin();
  const id = String(form.get("id") ?? "");
  try { await replySupportTicket(await readSessionToken(), id, String(form.get("reply") ?? "")); }
  catch (e) { if (e instanceof MemberError) return { ok: false, message: e.message }; throw e; }
  revalidatePath("/admin/support"); revalidatePath(`/admin/support/${id}`);
  revalidatePath("/support"); revalidatePath(`/support/${id}`);
  return { ok: true, message: "답변을 등록했습니다." };
}
