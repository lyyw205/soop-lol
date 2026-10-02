"use server";

import { revalidatePath } from "next/cache";

import { saveAndCompleteScreenMatch, setFcoMatchCompleted } from "@soop-lol/core/lib/games/fconline/match-units";
import {
  linkScreenByAdmin, unlinkScreenByAdmin, updateScreenSides,
  type ScreenOutcomeEdit, type ScreenPersonEdit,
} from "@soop-lol/core/lib/games/fconline/screen-review";

import type { ActionState } from "@/lib/action-state";
import { requireAdmin } from "@/lib/admin-auth";

/**
 * FC 방송 작업대의 저장(경기 값·시점 붙이기/떼기·완료). CLI 와 같은 core 함수를 admin 자격으로 부른다 — 저장 경로를 두 벌로 만들지 않는다.
 * 모든 액션은 화면이 본 `review_version` 을 같이 보낸다. 그 사이 값이 바뀌었으면 거부한다(오래된 화면에서 덮어쓰기 방지).
 */

const text = (form: FormData, key: string) => String(form.get(key) ?? "").trim();
const fail = (error: unknown): ActionState => ({ ok: false, message: error instanceof Error ? error.message : String(error) });
const refresh = () => revalidatePath("/admin/fco", "layout");

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

/** 사람 선택 칸 — 비우면(기본) 지금 사람을 그대로 둔다. */
function person(form: FormData, key: string): ScreenPersonEdit {
  const v = text(form, key);
  if (v === "" || v === "__keep") return "keep";
  if (v === "__auto") return "auto";
  if (v === "__none") return "none";
  return { slug: v };
}

function sidesFrom(form: FormData) {
  const outcome = text(form, "outcome") as ScreenOutcomeEdit;
  if (!["auto", "first_win", "second_win", "draw"].includes(outcome)) throw new Error("결과 값이 올바르지 않습니다.");
  const edits: Parameters<typeof updateScreenSides>[2] = [
    { nickname: text(form, "nickname1"), score: score(form, "score1"), person: person(form, "streamer1") },
    { nickname: text(form, "nickname2"), score: score(form, "score2"), person: person(form, "streamer2") },
  ];
  return { edits, outcome };
}

export async function saveScreenSidesAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  await requireAdmin();
  try {
    const { edits, outcome } = sidesFrom(form);
    await updateScreenSides(text(form, "match_id"), version(form), edits, outcome);
    refresh();
    return { ok: true, message: "값을 저장했습니다. 값이 바뀌어 검수 완료는 풀렸습니다." };
  } catch (error) { return fail(error); }
}

/** 주 동작 — 고친 값 저장과 완료를 한 트랜잭션으로. */
export async function saveAndCompleteAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  await requireAdmin();
  try {
    const { edits, outcome } = sidesFrom(form);
    await saveAndCompleteScreenMatch(text(form, "match_id"), version(form), edits, outcome);
    refresh();
    return { ok: true, message: "저장하고 검수를 완료했습니다." };
  } catch (error) { return fail(error); }
}

export async function linkScreenAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  await requireAdmin();
  try {
    await linkScreenByAdmin(text(form, "match_id"), version(form), text(form, "target_id"));
    refresh();
    return { ok: true, message: "같은 경기로 붙였습니다 — 이제 그 경기의 시점입니다." };
  } catch (error) { return fail(error); }
}

export async function unlinkScreenAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  await requireAdmin();
  try {
    await unlinkScreenByAdmin(text(form, "match_id"), version(form));
    refresh();
    return { ok: true, message: "시점을 뗐습니다 — 다시 따로 된 경기입니다." };
  } catch (error) { return fail(error); }
}

/** 완료 — 넥슨 기록이 정본이든 화면 기록이 정본이든 같은 도장. */
export async function setMatchCompletedAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  await requireAdmin();
  try {
    const completed = text(form, "completed");
    if (!["0", "1"].includes(completed)) throw new Error("검수 상태가 올바르지 않습니다.");
    await setFcoMatchCompleted(text(form, "match_id"), completed === "1", version(form));
    refresh();
    return { ok: true, message: completed === "1" ? "검수를 완료했습니다." : "완료를 취소했습니다." };
  } catch (error) { return fail(error); }
}
