"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { readSessionToken } from "@soop-lol/core/lib/auth/request";
import { createSupportTicket } from "@soop-lol/core/lib/db/support";
import { MemberError } from "@soop-lol/core/lib/db/member";
import type { ActionState } from "@/lib/action-state";
export async function submitSupport(_prev: ActionState, form: FormData): Promise<ActionState> {
  let id: string;
  try {
    id = await createSupportTicket(await readSessionToken(), {
      kind: String(form.get("kind") ?? ""), title: String(form.get("title") ?? ""), body: String(form.get("body") ?? ""),
    });
  } catch (e) { if (e instanceof MemberError) return { ok: false, message: e.message }; throw e; }
  revalidatePath("/support"); revalidatePath("/admin/support");
  redirect(`/support/${id}`);
}
