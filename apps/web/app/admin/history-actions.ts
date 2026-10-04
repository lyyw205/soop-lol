"use server";
import { requireAdmin } from "@/lib/admin-auth";
import { listAdminHistory } from "@soop-lol/core/lib/db/admin-history";
export async function loadAdminHistory(scope: "match" | "streamer" | "schedule" | "candidate" | "event", key: string) {
  await requireAdmin();
  if (!["match", "streamer", "schedule", "candidate", "event"].includes(scope) || typeof key !== "string" || key.length > 300) throw new Error("잘못된 이력 요청입니다.");
  return listAdminHistory(scope, key);
}
