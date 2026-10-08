"use server";

import { redirect } from "next/navigation";

import { safeNextPath } from "@soop-lol/core/lib/auth/oauth";
import { clearSessionCookie, readSessionToken } from "@soop-lol/core/lib/auth/request";
import { deleteSession, MemberError, setNickname, withdrawMember } from "@soop-lol/core/lib/db/member";
import { lobbyHref } from "@soop-lol/core/lib/site-paths";

import type { ActionState } from "@/lib/action-state";

/**
 * 내 정보 화면의 서버 액션. 판단(세션·동의·닉네임 규칙·잠금)은 core 의 member.ts 가 한다 — 여기선 폼 값을 넘기기만 한다.
 * ★ redirect() 는 try 밖에서 부른다 — 안에서 부르면 catch 가 그 신호를 삼킨다.
 */

const text = (form: FormData, key: string) => String(form.get(key) ?? "");

async function member<T>(work: (token: string | null) => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  try {
    return { ok: true, value: await work(await readSessionToken()) };
  } catch (error) {
    if (error instanceof MemberError) return { ok: false, message: error.message };
    throw error;
  }
}

/** 처음 가입 마무리 — 닉네임 + 약관·처리방침 동의(만 14세 이상 확인 포함). */
export async function completeSignupAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const r = await member((token) => setNickname(token, text(form, "nickname"), { agreed: form.get("agree") === "on" }));
  if (!r.ok) return r;
  redirect(safeNextPath(text(form, "next")));
}

export async function changeNicknameAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const r = await member((token) => setNickname(token, text(form, "nickname")));
  return r.ok ? { ok: true, message: `닉네임을 '${r.value.nickname}'(으)로 바꿨습니다.` } : r;
}

export async function logoutAction(): Promise<void> {
  await deleteSession(await readSessionToken());
  await clearSessionCookie();
  redirect(lobbyHref());
}

export async function withdrawAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  if (text(form, "confirm").trim() !== "탈퇴") return { ok: false, message: "확인 칸에 '탈퇴' 를 적어 주세요." };
  const r = await member((token) => withdrawMember(token, { deleteContent: form.get("deleteContent") === "on" }));
  if (!r.ok) return r;
  await clearSessionCookie();
  redirect(lobbyHref());
}
