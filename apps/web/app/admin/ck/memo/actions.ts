"use server";
import { requireAdmin } from "@/lib/admin-auth";
import { appendMemoFeedback } from "@/lib/ck-memo-feedback";
import type { MemoVerdict } from "@/lib/ck-memo";

export async function markMemo(input: { vod: string; at: number; label: MemoVerdict; model: string; source: string }) {
  await requireAdmin();
  try { await appendMemoFeedback(input); return { ok: true as const }; }
  catch (e) { return { ok: false as const, message: e instanceof Error ? e.message : "표시를 저장하지 못했습니다." }; }
}
