"use server";

import { revalidatePath } from "next/cache";

import { CommunityError } from "@soop-lol/core/lib/db/community";
import { addSanction, createNotice, liftSanction, moderateContent } from "@soop-lol/core/lib/db/community-admin";
import {
  COMMUNITY_GAMES, isUuid, MODERATION_ACTION_LABEL, parseContentId, type CommunityGame, type ModerationAction,
} from "@soop-lol/core/lib/metrics/community";

import type { ActionState } from "@/lib/action-state";
import { requireAdmin } from "@/lib/admin-auth";

/**
 * 커뮤니티 운영 — 신고 처리·제재·공지. 판단(상태 전이·잠금·신고 닫기)은 core 의 community-admin.ts 가 한다.
 * ★ 액션마다 requireAdmin 을 다시 부른다 — 액션은 경로와 무관한 POST 끝점이다(admin-auth.ts).
 * ★ 실제 작업자는 지금 Basic 인증 하나(ADMIN_USER)다. 운영자가 여럿이 되기 전에 기록 방식을 바꾼다(docs/COMMUNITY-PLAN.md §단순함의 기준).
 */

const actor = () => process.env.ADMIN_USER ?? "admin";
const text = (form: FormData, key: string) => String(form.get(key) ?? "");

async function run(work: () => Promise<unknown>, done: string): Promise<ActionState> {
  await requireAdmin();
  try {
    await work();
  } catch (error) {
    if (error instanceof CommunityError) return { ok: false, message: error.message };
    throw error;
  }
  revalidatePath("/admin/community");
  return { ok: true, message: done };
}

export async function moderateAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const kind = text(form, "kind");
  const target = parseContentId(text(form, "target"));
  const action = text(form, "action");
  if ((kind !== "post" && kind !== "comment") || target === null || !Object.hasOwn(MODERATION_ACTION_LABEL, action)) {
    return { ok: false, message: "처리할 대상을 확인해 주세요." };
  }
  return run(() => moderateContent(kind, target, action as ModerationAction, text(form, "reason"), actor()),
    `${MODERATION_ACTION_LABEL[action as ModerationAction]} 처리했습니다.`);
}

export async function sanctionAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const member = text(form, "member");
  const daysText = text(form, "days");
  if (!isUuid(member)) return { ok: false, message: "회원을 확인해 주세요." };
  const days = daysText === "permanent" ? null : Number(daysText);
  return run(() => addSanction(member, days, text(form, "reason"), actor()),
    days === null ? "영구 제한을 걸었습니다." : `${days}일 제한을 걸었습니다.`);
}

export async function liftSanctionAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = parseContentId(text(form, "sanction"));
  if (id === null) return { ok: false, message: "제재를 확인해 주세요." };
  return run(() => liftSanction(id), "제재를 풀었습니다.");
}

export async function noticeAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const game = text(form, "game");
  const game_code = (COMMUNITY_GAMES as readonly string[]).includes(game) ? (game as CommunityGame) : null;
  return run(() => createNotice({ game_code, title: text(form, "title"), body: text(form, "body") }), "공지를 올렸습니다.");
}
