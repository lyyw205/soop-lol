/**
 * 커뮤니티 — 회원 쓰기(글·댓글·추천·신고). docs/COMMUNITY-PLAN.md §3
 * 관리자 쓰기·정기 작업은 community-admin.ts, 공개 읽기는 community-public.ts(core_public 만 읽는다).
 *
 * ★ 정책(권한·제재·검증·한도)을 적용하는 쓰기 경로는 하나다 — 모듈 화면은 계약(contract/community.ts)을 거쳐 여기를 부른다.
 * ★ 함수마다 **세션 토큰**을 받는다. 작성자는 언제나 토큰에서 정한다(모듈이 보낸 회원 id 를 쓰지 않는다). Next 를 모른다.
 * ★ 잠금 순서는 언제나 회원 → 글 → 댓글. 회원 행을 먼저 잠그고 잠근 뒤 세션·상태·제재를 다시 본다(member.ts lockSessionMember).
 *   글을 바꾸거나 글로 판단하는 경로(수정·삭제·신고 접수)는 글 행을 FOR UPDATE, 글이 공개인지만 보는 경로(댓글·추천)는 FOR SHARE —
 *   인기 글에 댓글이 몰려도 서로 막지 않고, 숨김·파기와는 줄을 선다.
 * ★ version 은 updated_at 의 텍스트다(편성표와 같다). 편집 폼이 저장하는 내용·공개 상태가 바뀔 때만 바뀐다 — 추천·댓글은 제외.
 */

import type postgres from "postgres";

import {
  normalizeCommentBody, normalizePostInput, validateCommentBody, validatePostInput, validateReport, writeLimitMessage,
  isUuid, daysAgo, type ContentStatus, type PostInput, type ReportReason, type WriteKind,
} from "../metrics/community.ts";
import { db } from "./client.ts";
import { lockSessionMember, memberFromSession, MemberError } from "./member.ts";

type Tx = postgres.TransactionSql;
type Sql = postgres.Sql | Tx;

/** 커뮤니티 쓰기 거부. message 를 그대로 화면에 보여준다. MemberError 를 이어받아 화면이 한 번에 잡는다. */
export class CommunityError extends MemberError {
  constructor(message: string) {
    super(message);
    this.name = "CommunityError";
  }
}

export const STALE_VERSION_MESSAGE = "다른 곳에서 먼저 고쳤습니다. 새로 불러온 뒤 다시 저장하세요.";

export interface PostRow {
  id: number;
  author_id: string | null;
  status: ContentStatus;
  version: string;
  title: string | null;
  body: string | null;
}

export interface CommentRow {
  id: number;
  post_id: number;
  parent_id: number | null;
  author_id: string;
  status: ContentStatus;
  version: string;
  body: string | null;
}

export async function lockPost(tx: Tx, id: number, mode: "update" | "share"): Promise<PostRow | null> {
  const [row] = mode === "update"
    ? await tx<PostRow[]>`SELECT id::int AS id, author_id, status, updated_at::text AS version, title, body
                          FROM community_post WHERE id = ${id} FOR UPDATE`
    : await tx<PostRow[]>`SELECT id::int AS id, author_id, status, updated_at::text AS version, title, body
                          FROM community_post WHERE id = ${id} FOR SHARE`;
  return row ?? null;
}

export async function lockComment(tx: Tx, id: number, mode: "update" | "share"): Promise<CommentRow | null> {
  const [row] = mode === "update"
    ? await tx<CommentRow[]>`SELECT id::int AS id, post_id::int AS post_id, parent_id::int AS parent_id, author_id, status,
                                    updated_at::text AS version, body FROM community_comment WHERE id = ${id} FOR UPDATE`
    : await tx<CommentRow[]>`SELECT id::int AS id, post_id::int AS post_id, parent_id::int AS parent_id, author_id, status,
                                    updated_at::text AS version, body FROM community_comment WHERE id = ${id} FOR SHARE`;
  return row ?? null;
}

/** 잠금 순서(글 → 댓글)를 지키려고 댓글의 글 번호를 먼저 잠그지 않고 읽는다. 잠근 뒤 다시 대조한다. */
export async function postIdOfComment(sql: Sql, commentId: number): Promise<number | null> {
  const [row] = await sql<{ post_id: number }[]>`SELECT post_id::int AS post_id FROM community_comment WHERE id = ${commentId}`;
  return row?.post_id ?? null;
}

async function assertPublicStreamers(tx: Tx, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  if (!ids.every(isUuid)) throw new CommunityError("태그할 스트리머를 확인해 주세요.");
  const rows = await tx`SELECT streamer_id FROM core_public.streamer WHERE streamer_id = ANY(${ids}::uuid[])`;
  if (rows.length !== ids.length) throw new CommunityError("태그할 수 없는 스트리머가 있습니다.");
}

/** 쓰기 한도. 회원 행을 잠근 뒤에 부른다 — 같은 회원의 동시 요청은 줄을 서므로 뒤 요청이 앞 요청의 저장까지 센다. */
async function enforceLimit(tx: Tx, kind: WriteKind, memberId: string, now: Date): Promise<void> {
  const since = daysAgo(now, 1);
  const rows = kind === "post"
    ? await tx<{ at: Date }[]>`SELECT created_at AS at FROM community_post WHERE author_id = ${memberId}::uuid AND created_at > ${since}`
    : kind === "comment"
      ? await tx<{ at: Date }[]>`SELECT created_at AS at FROM community_comment WHERE author_id = ${memberId}::uuid AND created_at > ${since}`
      : await tx<{ at: Date }[]>`SELECT created_at AS at FROM community_report WHERE reporter_id = ${memberId}::uuid AND created_at > ${since}`;
  const message = writeLimitMessage(kind, rows.map((r) => r.at), now);
  if (message) throw new CommunityError(message);
}

function ensure(errors: string[]): void {
  if (errors.length) throw new CommunityError(errors.join(" "));
}

async function replaceTags(tx: Tx, postId: number, streamerIds: string[]): Promise<void> {
  await tx`DELETE FROM community_post_streamer WHERE post_id = ${postId}`;
  for (const id of streamerIds) await tx`INSERT INTO community_post_streamer (post_id, streamer_id) VALUES (${postId}, ${id}::uuid)`;
}

// ── 글 ───────────────────────────────────────────────────────────────

export async function createPost(token: string | null | undefined, raw: PostInput, now = new Date()): Promise<{ id: number }> {
  const input = normalizePostInput(raw);
  ensure(validatePostInput(input));
  return db().begin(async (tx) => {
    const m = await lockSessionMember(tx, token, now, { needNickname: true, checkSanction: true });
    await enforceLimit(tx, "post", m.id, now);
    await assertPublicStreamers(tx, input.streamer_ids);
    const [row] = await tx<{ id: number }[]>`
      INSERT INTO community_post (author_id, game_code, topic, title, body, created_at, updated_at)
      VALUES (${m.id}::uuid, ${input.game_code}, ${input.topic}, ${input.title}, ${input.body}, ${now}, ${now})
      RETURNING id::int AS id`;
    await replaceTags(tx, row.id, input.streamer_ids);
    return { id: row.id };
  });
}

/**
 * 글 고치기 — 작성자만, **공개 상태에서만**. 상태는 바꾸지 않는다 — 운영자가 숨긴 글은 고쳐도 다시 공개되지 않는다.
 * 태그만 바꿔도 version 이 바뀐다(다른 창의 오래된 폼이 태그를 덮어쓰지 못하게).
 */
export async function editPost(token: string | null | undefined, postId: number, raw: PostInput, version: string, now = new Date()): Promise<{ version: string }> {
  const input = normalizePostInput(raw);
  ensure(validatePostInput(input));
  return db().begin(async (tx) => {
    const m = await lockSessionMember(tx, token, now, { needNickname: true, checkSanction: true });
    const post = await lockPost(tx, postId, "update");
    if (!post || post.author_id !== m.id) throw new CommunityError("고칠 수 없는 글입니다.");
    if (post.status !== "published") throw new CommunityError("운영 조치 중이거나 지운 글은 고칠 수 없습니다.");
    if (post.version !== version) throw new CommunityError(STALE_VERSION_MESSAGE);
    await assertPublicStreamers(tx, input.streamer_ids);
    const [row] = await tx<{ version: string }[]>`
      UPDATE community_post SET game_code = ${input.game_code}, topic = ${input.topic}, title = ${input.title}, body = ${input.body},
             edited_at = ${now}, updated_at = ${now}
       WHERE id = ${postId} RETURNING updated_at::text AS version`;
    await replaceTags(tx, postId, input.streamer_ids);
    return row;
  });
}

/** 글 지우기 — 작성자만. 숨김 상태에서도 된다(운영 기록은 그대로 남는다). 제재 중이어도 지울 수는 있다. */
export async function deletePost(token: string | null | undefined, postId: number, now = new Date()): Promise<void> {
  await db().begin(async (tx) => {
    const m = await lockSessionMember(tx, token, now);
    const post = await lockPost(tx, postId, "update");
    if (!post || post.author_id !== m.id) throw new CommunityError("지울 수 없는 글입니다.");
    if (post.status === "deleted") return;
    await tx`UPDATE community_post SET status = 'deleted', deleted_at = ${now}, updated_at = ${now} WHERE id = ${postId}`;
  });
}

// ── 댓글 ─────────────────────────────────────────────────────────────

/** 댓글. 대댓글은 같은 글의 **공개된 최상위 댓글**에만(같은 글은 복합 FK 도 막는다). */
export async function createComment(
  token: string | null | undefined, postId: number, rawBody: string, parentId: number | null, now = new Date(),
): Promise<{ id: number }> {
  const body = normalizeCommentBody(rawBody);
  ensure(validateCommentBody(body));
  return db().begin(async (tx) => {
    const m = await lockSessionMember(tx, token, now, { needNickname: true, checkSanction: true });
    const post = await lockPost(tx, postId, "share");
    if (!post || post.status !== "published") throw new CommunityError("댓글을 달 수 없는 글입니다.");
    if (parentId !== null) {
      const parent = await lockComment(tx, parentId, "share");
      if (!parent || parent.post_id !== postId) throw new CommunityError("같은 글의 댓글에만 답글을 달 수 있습니다.");
      if (parent.parent_id !== null) throw new CommunityError("답글에는 다시 답글을 달 수 없습니다.");
      if (parent.status !== "published") throw new CommunityError("지운 댓글에는 답글을 달 수 없습니다.");
    }
    await enforceLimit(tx, "comment", m.id, now);
    const [row] = await tx<{ id: number }[]>`
      INSERT INTO community_comment (post_id, parent_id, author_id, body, created_at, updated_at)
      VALUES (${postId}, ${parentId}, ${m.id}::uuid, ${body}, ${now}, ${now}) RETURNING id::int AS id`;
    return row;
  });
}

export async function editComment(
  token: string | null | undefined, commentId: number, rawBody: string, version: string, now = new Date(),
): Promise<{ version: string }> {
  const body = normalizeCommentBody(rawBody);
  ensure(validateCommentBody(body));
  const postId = await postIdOfComment(db(), commentId);
  if (postId === null) throw new CommunityError("고칠 수 없는 댓글입니다.");
  return db().begin(async (tx) => {
    const m = await lockSessionMember(tx, token, now, { needNickname: true, checkSanction: true });
    const post = await lockPost(tx, postId, "share");
    const comment = await lockComment(tx, commentId, "update");
    if (!post || !comment || comment.post_id !== postId || comment.author_id !== m.id) throw new CommunityError("고칠 수 없는 댓글입니다.");
    if (comment.status !== "published" || post.status !== "published") throw new CommunityError("운영 조치 중이거나 지운 댓글은 고칠 수 없습니다.");
    if (comment.version !== version) throw new CommunityError(STALE_VERSION_MESSAGE);
    const [row] = await tx<{ version: string }[]>`
      UPDATE community_comment SET body = ${body}, edited_at = ${now}, updated_at = ${now}
       WHERE id = ${commentId} RETURNING updated_at::text AS version`;
    return row;
  });
}

export async function deleteComment(token: string | null | undefined, commentId: number, now = new Date()): Promise<void> {
  const postId = await postIdOfComment(db(), commentId);
  if (postId === null) throw new CommunityError("지울 수 없는 댓글입니다.");
  await db().begin(async (tx) => {
    const m = await lockSessionMember(tx, token, now);
    await lockPost(tx, postId, "share");
    const comment = await lockComment(tx, commentId, "update");
    if (!comment || comment.author_id !== m.id) throw new CommunityError("지울 수 없는 댓글입니다.");
    if (comment.status === "deleted") return;
    await tx`UPDATE community_comment SET status = 'deleted', deleted_at = ${now}, updated_at = ${now} WHERE id = ${commentId}`;
  });
}

// ── 추천 ─────────────────────────────────────────────────────────────

/** 추천 — 회원당 글 하나에 한 번(다시 눌러도 그대로). 비추천은 없다. 내 글은 추천하지 않는다. */
export async function votePost(token: string | null | undefined, postId: number, now = new Date()): Promise<{ added: boolean }> {
  return db().begin(async (tx) => {
    const m = await lockSessionMember(tx, token, now, { needNickname: true, checkSanction: true });
    const post = await lockPost(tx, postId, "share");
    if (!post || post.status !== "published") throw new CommunityError("추천할 수 없는 글입니다.");
    if (post.author_id === m.id) throw new CommunityError("내 글은 추천할 수 없습니다.");
    const added = await tx`INSERT INTO community_post_vote (post_id, member_id, created_at) VALUES (${postId}, ${m.id}::uuid, ${now})
                           ON CONFLICT DO NOTHING RETURNING 1`;
    return { added: added.length === 1 };
  });
}

// ── 신고 ─────────────────────────────────────────────────────────────

/**
 * 신고 — **공개 대상에만** 받고, 신고 당시 제목·본문을 신고 행에 남긴다(관리자만 본다).
 * ★ 신고만으로 수정을 막지 않는다 — 신고자 한 명이 남의 편집을 막을 수 있게 되기 때문이다. 원문은 여기 남은 것으로 본다.
 * ★ 대상 행을 잠근다(글 FOR UPDATE · 댓글은 글 → 댓글) — 파기와 겹치면 둘 중 하나가 기다린 뒤 바뀐 상태로 판단한다.
 * 제재 중이어도 신고는 받는다(피해 신고를 막지 않는다). 대신 하루 한도가 있다.
 */
export async function reportContent(
  token: string | null | undefined, kind: "post" | "comment", targetId: number, reason: ReportReason, rawDetail: string | null, now = new Date(),
): Promise<void> {
  const detail = rawDetail?.trim() ? rawDetail.trim() : null;
  ensure(validateReport(reason, detail));
  const postId = kind === "post" ? targetId : await postIdOfComment(db(), targetId);
  if (postId === null) throw new CommunityError("신고할 수 없는 댓글입니다.");
  try {
    await db().begin(async (tx) => {
      const m = await lockSessionMember(tx, token, now, { needNickname: true });
      await enforceLimit(tx, "report", m.id, now);
      let snapshot: { title: string | null; body: string | null };
      if (kind === "post") {
        const post = await lockPost(tx, targetId, "update");
        if (!post || post.status !== "published") throw new CommunityError("신고할 수 없는 글입니다.");
        if (post.author_id === m.id) throw new CommunityError("내 글은 신고할 수 없습니다.");
        snapshot = { title: post.title, body: post.body };
      } else {
        const post = await lockPost(tx, postId, "share");
        const comment = await lockComment(tx, targetId, "update");
        if (!post || post.status !== "published" || !comment || comment.status !== "published") throw new CommunityError("신고할 수 없는 댓글입니다.");
        if (comment.author_id === m.id) throw new CommunityError("내 댓글은 신고할 수 없습니다.");
        snapshot = { title: null, body: comment.body };
      }
      await tx`INSERT INTO community_report (kind, target_id, reporter_id, reason, detail, snapshot_title, snapshot_body, created_at)
               VALUES (${kind}, ${targetId}, ${m.id}::uuid, ${reason}, ${detail}, ${snapshot.title}, ${snapshot.body}, ${now})`;
    });
  } catch (error) {
    if ((error as { code?: string }).code === "23505") throw new CommunityError("이미 신고했습니다.");
    throw error;
  }
}

// ── 회원 읽기 ────────────────────────────────────────────────────────

/** 이 회원이 추천한 글(화면의 추천 표시용). 로그인 안 했으면 빈 집합. */
export async function votedPostIds(token: string | null | undefined, postIds: number[]): Promise<Set<number>> {
  if (postIds.length === 0) return new Set();
  const me = await memberFromSession(token);
  if (!me) return new Set();
  const rows = await db()<{ post_id: number }[]>`
    SELECT post_id::int AS post_id FROM community_post_vote WHERE member_id = ${me.member_id}::uuid AND post_id = ANY(${postIds}::bigint[])`;
  return new Set(rows.map((r) => r.post_id));
}
