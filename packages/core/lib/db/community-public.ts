/**
 * 커뮤니티 — 공개 읽기. **core_public 뷰만 읽는다** — 숨김·삭제 글, 숨긴 스트리머의 태그, 탈퇴 회원 이름은 뷰가 거른다.
 * docs/COMMUNITY-PLAN.md §3 "분류"·"공개 경계"
 *
 * ★ 필터는 전부 주소에서 온다(편성표와 같다). 게임 필터 'etc' 는 기타 글(게임 없음)만이다.
 *   ?game=lol 목록에 기타 글을 섞지 않는다 — 편성표의 ?game= 과 같은 뜻(좁히는 필터).
 * ★ 공지는 목록과 섞지 않고 위 띠에 최근 2개만 따로 낸다(listPublicNotices).
 * ★ 페이지는 커서(created_at, id) — OFFSET 이 아니다.
 * ★ 질의는 순서대로 보낸다 — 화면 하나의 동시 질의를 늘리지 않는다(PLAN §M4-1).
 */

import { isUuid, type CommunityGame, type CommunityTopic, type GameFilter } from "../metrics/community.ts";
import { db } from "./client.ts";

export const COMMUNITY_PAGE_SIZE = 30;
export const NOTICE_BAND_SIZE = 2;

export interface PublicCommunityPostRow {
  post_id: number;
  game_code: CommunityGame | null;
  topic: CommunityTopic;
  title: string;
  /** NULL 이면 운영자(공지). */
  author_id: string | null;
  /** NULL 이고 author_id 가 있으면 탈퇴한 회원. */
  author_nickname: string | null;
  like_count: number;
  comment_count: number;
  created_at: Date;
  edited_at: Date | null;
}

export interface PublicCommunityPost extends PublicCommunityPostRow {
  body: string;
  /** 수정 폼이 그대로 돌려보내는 version(updated_at 의 텍스트). */
  version: string;
  streamers: { streamer_id: string; slug: string; display_name: string }[];
}

export interface PublicCommunityComment {
  comment_id: number;
  post_id: number;
  parent_id: number | null;
  /** false 면 공개 대댓글 때문에 남은 자리 — 본문·작성자가 없다("삭제된 댓글입니다"). */
  visible: boolean;
  body: string | null;
  author_id: string | null;
  author_nickname: string | null;
  created_at: Date;
  edited_at: Date | null;
  version: string;
}

export interface CommunityListQuery {
  game: GameFilter;
  topic: CommunityTopic | null;
  /** 이 스트리머가 태그된 글(slug) */
  streamer: string | null;
  /** 두 사람이 모두 태그된 글(slug 둘) */
  pair: [string, string] | null;
  /** 이 회원의 글(member.id) */
  author: string | null;
  /** 이 글 다음부터(encodeCursor 값) */
  cursor: string | null;
  limit?: number;
}

export const encodeCursor = (row: { created_at: Date; post_id: number }): string => `${row.created_at.getTime()}.${row.post_id}`;

export function decodeCursor(value: string | null | undefined): { at: Date; id: number } | null {
  const m = /^(\d{1,15})\.(\d{1,15})$/.exec(value ?? "");
  if (!m) return null;
  const at = new Date(Number(m[1]));
  return Number.isNaN(at.getTime()) ? null : { at, id: Number(m[2]) };
}

/** 목록. 필터에 맞는 글을 최신순으로 limit 개, 다음 쪽 커서와 함께. */
export async function listPublicCommunityPosts(q: CommunityListQuery): Promise<{ posts: PublicCommunityPostRow[]; next: string | null }> {
  const limit = Math.min(Math.max(q.limit ?? COMMUNITY_PAGE_SIZE, 1), 100);
  const cursor = decodeCursor(q.cursor);
  const author = isUuid(q.author) ? q.author : null;
  if (q.author && !author) return { posts: [], next: null };
  const [pairA, pairB] = q.pair ?? [null, null];
  const rows = await db()<PublicCommunityPostRow[]>`
    SELECT p.post_id::int AS post_id, p.game_code, p.topic, p.title, p.author_id, p.author_nickname,
           p.like_count, p.comment_count, p.created_at, p.edited_at
      FROM core_public.community_post p
     WHERE (${q.topic}::text IS NULL AND p.topic <> 'notice' OR p.topic = ${q.topic})
       AND (${q.game}::text IS NULL OR (${q.game} = 'etc' AND p.game_code IS NULL) OR p.game_code = ${q.game})
       AND (${author}::uuid IS NULL OR p.author_id = ${author}::uuid)
       AND (${q.streamer}::text IS NULL OR EXISTS (
             SELECT 1 FROM core_public.community_post_streamer ps JOIN core_public.streamer s ON s.streamer_id = ps.streamer_id
              WHERE ps.post_id = p.post_id AND s.slug = ${q.streamer}))
       AND (${pairA}::text IS NULL OR (
             EXISTS (SELECT 1 FROM core_public.community_post_streamer ps JOIN core_public.streamer s ON s.streamer_id = ps.streamer_id
                      WHERE ps.post_id = p.post_id AND s.slug = ${pairA})
         AND EXISTS (SELECT 1 FROM core_public.community_post_streamer ps JOIN core_public.streamer s ON s.streamer_id = ps.streamer_id
                      WHERE ps.post_id = p.post_id AND s.slug = ${pairB})))
       AND (${cursor?.at ?? null}::timestamptz IS NULL OR (p.created_at, p.post_id) < (${cursor?.at ?? null}::timestamptz, ${cursor?.id ?? null}::bigint))
     ORDER BY p.created_at DESC, p.post_id DESC
     LIMIT ${limit + 1}`;
  const posts = rows.slice(0, limit);
  return { posts, next: rows.length > limit ? encodeCursor(posts[posts.length - 1]) : null };
}

/**
 * 목록 위 공지 띠. 게임을 고르지 않은 공지(모든 게임)는 모든 게임 필터에서, 게임 공지는 그 게임에서(전체 보기에서는 둘 다).
 * 'etc'(기타) 필터에서는 모든 게임 공지만.
 */
export async function listPublicNotices(game: GameFilter, limit = NOTICE_BAND_SIZE): Promise<PublicCommunityPostRow[]> {
  return db()<PublicCommunityPostRow[]>`
    SELECT p.post_id::int AS post_id, p.game_code, p.topic, p.title, p.author_id, p.author_nickname,
           p.like_count, p.comment_count, p.created_at, p.edited_at
      FROM core_public.community_post p
     WHERE p.topic = 'notice' AND (p.game_code IS NULL OR ${game}::text IS NULL OR p.game_code = ${game})
     ORDER BY p.created_at DESC, p.post_id DESC
     LIMIT ${limit}`;
}

/** 글 하나 + 태그된 스트리머. 숨김·삭제·없는 글은 null(화면이 404). */
export async function getPublicCommunityPost(postId: number): Promise<PublicCommunityPost | null> {
  const [post] = await db()<Omit<PublicCommunityPost, "streamers">[]>`
    SELECT p.post_id::int AS post_id, p.game_code, p.topic, p.title, p.body, p.author_id, p.author_nickname,
           p.like_count, p.comment_count, p.created_at, p.edited_at, p.version
      FROM core_public.community_post p WHERE p.post_id = ${postId}`;
  if (!post) return null;
  const streamers = await db()<PublicCommunityPost["streamers"]>`
    SELECT s.streamer_id, s.slug, s.display_name
      FROM core_public.community_post_streamer ps JOIN core_public.streamer s ON s.streamer_id = ps.streamer_id
     WHERE ps.post_id = ${postId} ORDER BY s.display_name`;
  return { ...post, streamers };
}

/** 글의 댓글 — 최상위 댓글 순서대로, 대댓글은 부모 바로 아래. */
export async function listPublicCommunityComments(postId: number): Promise<PublicCommunityComment[]> {
  return db()<PublicCommunityComment[]>`
    SELECT c.comment_id::int AS comment_id, c.post_id::int AS post_id, c.parent_id::int AS parent_id, c.visible,
           c.body, c.author_id, c.author_nickname, c.created_at, c.edited_at, c.version
      FROM core_public.community_comment c
     WHERE c.post_id = ${postId}
     ORDER BY COALESCE(c.parent_id, c.comment_id), c.parent_id NULLS FIRST, c.comment_id`;
}
