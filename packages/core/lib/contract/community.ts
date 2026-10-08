/**
 * 커뮤니티 계약 — 커뮤니티 모듈이 core 에서 쓸 수 있는 전부. docs/COMMUNITY-PLAN.md §1 "계약"
 *
 * ★ 서버 전용이다 — 쿠키를 읽는다(auth/request.ts). 워커는 import 하지 않는다(모듈 잡이 없다).
 * ★ 세 갈래로 연다.
 *   - 공개 읽기: core_public 만 읽는다(누구나 읽어도 되는 것만)
 *   - 화면용 회원: 지금 로그인한 회원, 내 추천 여부
 *   - 회원 쓰기: **토큰은 여기서 읽고 판단은 core 접근자(db/community.ts)가 한다** — 모듈이 회원 id 를 넘기지 않는다
 * ★ 관리자 쓰기·정기 작업은 열지 않는다(관리자 화면이 requireAdmin 뒤에 직접 부른다).
 * ★ 계약에 쓰기 함수가 생긴 건 이번이 처음이다 — 모듈은 core 표에 직접 쓰지 않고, core 가 계약으로 연 쓰기 함수만 부른다.
 */

import { readSessionToken } from "../auth/request.ts";
import * as writes from "../db/community.ts";
import type { PostInput, ReportReason } from "../metrics/community.ts";

export * from "./community-client.ts";

// ── 공개 읽기 ────────────────────────────────────────────────────────
export {
  COMMUNITY_PAGE_SIZE, NOTICE_BAND_SIZE,
  getPublicCommunityPost, listPublicCommunityComments, listPublicCommunityPosts, listPublicNotices,
} from "../db/community-public.ts";
export type { CommunityListQuery } from "../db/community-public.ts";

// ── 화면용 회원 ──────────────────────────────────────────────────────
export { currentMember } from "../auth/request.ts";
export type { SessionMember } from "../db/member.ts";
export const myVotedPostIds = async (postIds: number[]) => writes.votedPostIds(await readSessionToken(), postIds);

// ── 회원 쓰기 ────────────────────────────────────────────────────────
/** 화면에 그대로 보여줄 거부(로그인 필요·검증·한도·제재·동시 수정). 그 밖의 오류는 화면이 삼키지 않는다. */
export { CommunityError, STALE_VERSION_MESSAGE } from "../db/community.ts";
export { MemberError } from "../db/member.ts";

export const createCommunityPost = async (input: PostInput) => writes.createPost(await readSessionToken(), input);
export const editCommunityPost = async (postId: number, input: PostInput, version: string) =>
  writes.editPost(await readSessionToken(), postId, input, version);
export const deleteCommunityPost = async (postId: number) => writes.deletePost(await readSessionToken(), postId);
export const createCommunityComment = async (postId: number, body: string, parentId: number | null) =>
  writes.createComment(await readSessionToken(), postId, body, parentId);
export const editCommunityComment = async (commentId: number, body: string, version: string) =>
  writes.editComment(await readSessionToken(), commentId, body, version);
export const deleteCommunityComment = async (commentId: number) => writes.deleteComment(await readSessionToken(), commentId);
export const voteCommunityPost = async (postId: number) => writes.votePost(await readSessionToken(), postId);
export const reportCommunityContent = async (kind: "post" | "comment", targetId: number, reason: ReportReason, detail: string | null) =>
  writes.reportContent(await readSessionToken(), kind, targetId, reason, detail);
