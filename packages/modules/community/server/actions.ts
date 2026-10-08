"use server";

/**
 * 커뮤니티 화면의 서버 액션 — 폼 값을 계약의 쓰기 함수에 넘기기만 한다. 판단(로그인·소유·상태·한도·제재·version)은
 * core 접근자 하나가 한다(편성표 모듈의 server/load-window.ts 와 같은 자리). 회원 id 를 넘기지 않는다 — 계약이 쿠키에서 정한다.
 * ★ redirect() 는 try 밖에서 부른다 — 안에서 부르면 그 신호를 잡아 버린다.
 */

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { getPublicStreamer } from "@soop-lol/core/lib/contract";
import {
  COMMUNITY_GAMES, MemberError, parseContentId, REPORT_REASONS, TAG_MAX,
  createCommunityComment, createCommunityPost, deleteCommunityComment, deleteCommunityPost, editCommunityComment, editCommunityPost,
  reportCommunityContent, voteCommunityPost,
  type CommunityGame, type CommunityTopic, type PostInput, type ReportReason,
} from "@soop-lol/core/lib/contract/community";

import type { FormResult } from "../ui/form-state.ts";
import { communityHref, communityPostHref } from "../ui/paths.ts";

const text = (form: FormData, key: string) => String(form.get(key) ?? "");

/** 화면에 보여줄 거부(MemberError·CommunityError)만 결과로 바꾼다. 그 밖의 오류는 삼키지 않는다. */
async function guarded<T>(work: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    if (error instanceof MemberError) return { ok: false, message: error.message };
    throw error;
  }
}

/** 폼 → 글 입력. 태그는 slug 로 받아 공개 명부에서 id 를 찾는다(숨긴 스트리머는 찾지 못한다). */
async function readPostInput(form: FormData): Promise<PostInput | string> {
  const game = text(form, "game");
  const slugs = [...new Set(text(form, "tags").split(",").map((s) => s.trim()).filter(Boolean))];
  if (slugs.length > TAG_MAX) return `스트리머는 ${TAG_MAX}명까지 태그할 수 있습니다.`;
  const streamerIds: string[] = [];
  for (const slug of slugs) {
    const streamer = await getPublicStreamer(slug);
    if (!streamer) return `태그할 수 없는 스트리머입니다: ${slug}`;
    streamerIds.push(streamer.streamer_id);
  }
  return {
    game_code: (COMMUNITY_GAMES as readonly string[]).includes(game) ? (game as CommunityGame) : null,
    topic: text(form, "topic") as CommunityTopic,
    title: text(form, "title"),
    body: text(form, "body"),
    streamer_ids: streamerIds,
  };
}

export async function savePostAction(_prev: FormResult, form: FormData): Promise<FormResult> {
  const input = await readPostInput(form);
  if (typeof input === "string") return { ok: false, message: input };
  const id = parseContentId(text(form, "id"));
  const r = await guarded(async () => id === null
    ? (await createCommunityPost(input)).id
    : (await editCommunityPost(id, input, text(form, "version")), id));
  if (!r.ok) return r;
  redirect(communityPostHref(r.value));
}

export async function deletePostAction(_prev: FormResult, form: FormData): Promise<FormResult> {
  const id = parseContentId(text(form, "id"));
  if (id === null) return { ok: false, message: "지울 글을 확인해 주세요." };
  const r = await guarded(() => deleteCommunityPost(id));
  if (!r.ok) return r;
  redirect(communityHref());
}

export async function commentAction(_prev: FormResult, form: FormData): Promise<FormResult> {
  const postId = parseContentId(text(form, "post"));
  if (postId === null) return { ok: false, message: "댓글을 달 글을 확인해 주세요." };
  const parentId = parseContentId(text(form, "parent"));
  const r = await guarded(() => createCommunityComment(postId, text(form, "body"), parentId));
  if (!r.ok) return r;
  revalidatePath(communityPostHref(postId));
  return { ok: true, message: "" };
}

export async function editCommentAction(_prev: FormResult, form: FormData): Promise<FormResult> {
  const postId = parseContentId(text(form, "post"));
  const commentId = parseContentId(text(form, "comment"));
  if (postId === null || commentId === null) return { ok: false, message: "고칠 댓글을 확인해 주세요." };
  const r = await guarded(() => editCommunityComment(commentId, text(form, "body"), text(form, "version")));
  if (!r.ok) return r;
  revalidatePath(communityPostHref(postId));
  return { ok: true, message: "고쳤습니다." };
}

export async function deleteCommentAction(_prev: FormResult, form: FormData): Promise<FormResult> {
  const postId = parseContentId(text(form, "post"));
  const commentId = parseContentId(text(form, "comment"));
  if (postId === null || commentId === null) return { ok: false, message: "지울 댓글을 확인해 주세요." };
  const r = await guarded(() => deleteCommunityComment(commentId));
  if (!r.ok) return r;
  revalidatePath(communityPostHref(postId));
  return { ok: true, message: "" };
}

export async function voteAction(_prev: FormResult, form: FormData): Promise<FormResult> {
  const postId = parseContentId(text(form, "post"));
  if (postId === null) return { ok: false, message: "추천할 글을 확인해 주세요." };
  const r = await guarded(() => voteCommunityPost(postId));
  if (!r.ok) return r;
  revalidatePath(communityPostHref(postId));
  return { ok: true, message: r.value.added ? "추천했습니다." : "이미 추천했습니다." };
}

export async function reportAction(_prev: FormResult, form: FormData): Promise<FormResult> {
  const kind = text(form, "kind");
  const targetId = parseContentId(text(form, "target"));
  const reason = text(form, "reason");
  if ((kind !== "post" && kind !== "comment") || targetId === null) return { ok: false, message: "신고할 대상을 확인해 주세요." };
  if (!(REPORT_REASONS as readonly string[]).includes(reason)) return { ok: false, message: "신고 사유를 골라 주세요." };
  const r = await guarded(() => reportCommunityContent(kind, targetId, reason as ReportReason, text(form, "detail") || null));
  if (!r.ok) return r;
  return { ok: true, message: "신고했습니다. 운영자가 확인합니다." };
}
