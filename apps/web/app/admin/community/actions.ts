"use server";

import { revalidatePath } from "next/cache";

import { CommunityError } from "@soop-lol/core/lib/db/community";
import { addSanction, createNotice, liftSanction, moderateContent } from "@soop-lol/core/lib/db/community-admin";
import { MemberError } from "@soop-lol/core/lib/db/member";
import { grantMemberRole, revokeMemberRole } from "@soop-lol/core/lib/db/submission";
import {
  COMMUNITY_GAMES, isUuid, MODERATION_ACTION_LABEL, parseContentId, type CommunityGame, type ModerationAction,
} from "@soop-lol/core/lib/metrics/community";

import type { ActionState } from "@/lib/action-state";
import { requireAdmin } from "@/lib/admin-auth";

/**
 * 커뮤니티 운영 — 신고 처리·제재·공지. 판단(상태 전이·잠금·신고 닫기)은 core 의 community-admin.ts 가 한다.
 * ★ 액션마다 requireAdmin 을 다시 부른다 — 액션은 경로와 무관한 POST 끝점이다(admin-auth.ts).
 * ★ 제재·숨김 기록의 작업자는 검증된 관리자 회원 ID로 남긴다.
 * ★ 권한(0096)을 주고 거두면 그 회원의 열린 제보를 core 가 다시 판정한다 — 여기는 결과 수만 알린다.
 */

const text = (form: FormData, key: string) => String(form.get(key) ?? "");

async function run(work: (actor: string) => Promise<unknown>, done: string): Promise<ActionState> {
  const { actor } = await requireAdmin();
  try {
    await work(actor);
  } catch (error) {
    // CommunityError·SubmissionError 모두 MemberError — 화면에 그대로 보여 주는 거부다.
    if (error instanceof CommunityError || error instanceof MemberError) return { ok: false, message: error.message };
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
  return run((actor) => moderateContent(kind, target, action as ModerationAction, text(form, "reason"), actor),
    `${MODERATION_ACTION_LABEL[action as ModerationAction]} 처리했습니다.`);
}

export async function sanctionAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const member = text(form, "member");
  const daysText = text(form, "days");
  if (!isUuid(member)) return { ok: false, message: "회원을 확인해 주세요." };
  const days = daysText === "permanent" ? null : Number(daysText);
  return run((actor) => addSanction(member, days, text(form, "reason"), actor),
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

export async function roleAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const member = text(form, "member"), role = text(form, "role"), op = text(form, "op");
  if (!isUuid(member)) return { ok: false, message: "회원을 확인해 주세요." };
  let changed = 0;
  const state = await run(async (actor) => {
    changed = op === "revoke" ? await revokeMemberRole(member, role, actor) : await grantMemberRole(member, role, text(form, "note"), actor);
  }, "");
  if (!state.ok) return state;
  // 판정이 바뀐 제보가 있으면 공개 화면(확인 전 표시·집계)과 제보 대기열이 바뀐다.
  if (changed) { revalidatePath("/", "layout"); revalidatePath("/admin/submissions"); }
  const verb = op === "revoke" ? "권한을 거뒀습니다" : "권한을 줬습니다";
  return { ok: true, message: changed ? `${verb}. 열린 제보 ${changed}건의 판정이 바뀌었습니다.` : `${verb}.` };
}
