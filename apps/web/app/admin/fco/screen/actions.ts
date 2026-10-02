"use server";

import { revalidatePath } from "next/cache";

import {
  linkScreenByAdmin, setScreenReviewCompleted, unlinkScreenByAdmin, updateScreenSides,
  type ScreenOutcomeEdit,
} from "@soop-lol/core/lib/games/fconline/screen-review";

import type { ActionState } from "@/lib/action-state";
import { requireAdmin } from "@/lib/admin-auth";

/**
 * FC 화면 경기 검수 저장. CLI 와 같은 core 함수를 admin 자격으로 부른다 — 저장 경로를 두 벌로 만들지 않는다.
 * 모든 액션은 화면이 본 `review_version` 을 같이 보낸다. 그 사이 값이 바뀌었으면 거부한다(오래된 화면에서 덮어쓰기 방지).
 */

const text = (form: FormData, key: string) => String(form.get(key) ?? "").trim();
const fail = (error: unknown): ActionState => ({ ok: false, message: error instanceof Error ? error.message : String(error) });
const refresh = () => revalidatePath("/admin/fco/screen", "layout");

function version(form: FormData): number {
  const raw = text(form, "version");
  if (!/^\d+$/.test(raw)) throw new Error("검수 기준값이 없습니다. 새로고침해 주세요.");
  return Number(raw);
}

function score(form: FormData, key: string): number | null {
  const raw = text(form, key);
  if (raw === "") return null;
  if (!/^\d{1,2}$/.test(raw)) throw new Error("점수는 0~99 의 정수여야 합니다.");
  return Number(raw);
}

export async function saveScreenSidesAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  await requireAdmin();
  try {
    const outcome = text(form, "outcome") as ScreenOutcomeEdit;
    if (!["auto", "first_win", "second_win", "draw"].includes(outcome)) throw new Error("결과 값이 올바르지 않습니다.");
    await updateScreenSides(text(form, "match_id"), version(form), [
      { nickname: text(form, "nickname1"), score: score(form, "score1"), streamerSlug: text(form, "streamer1") || null },
      { nickname: text(form, "nickname2"), score: score(form, "score2"), streamerSlug: text(form, "streamer2") || null },
    ], outcome);
    refresh();
    return { ok: true, message: "저장했습니다. 값이 바뀌어 검수 완료는 풀렸습니다." };
  } catch (error) { return fail(error); }
}

export async function linkScreenAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  await requireAdmin();
  try {
    await linkScreenByAdmin(text(form, "match_id"), version(form), text(form, "target_id"));
    refresh();
    return { ok: true, message: "같은 경기로 연결했습니다. 근거 프레임을 그 경기로 복사했습니다." };
  } catch (error) { return fail(error); }
}

export async function unlinkScreenAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  await requireAdmin();
  try {
    await unlinkScreenByAdmin(text(form, "match_id"), version(form));
    refresh();
    return { ok: true, message: "연결을 풀었습니다." };
  } catch (error) { return fail(error); }
}

export async function setScreenCompletedAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  await requireAdmin();
  try {
    const completed = text(form, "completed");
    if (!["0", "1"].includes(completed)) throw new Error("검수 상태가 올바르지 않습니다.");
    await setScreenReviewCompleted(text(form, "match_id"), completed === "1", version(form));
    refresh();
    return { ok: true, message: completed === "1" ? "검수를 완료했습니다." : "완료를 취소했습니다." };
  } catch (error) { return fail(error); }
}
