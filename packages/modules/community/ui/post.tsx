import Link from "next/link";
import { notFound } from "next/navigation";

import {
  COMMUNITY_GAME_LABEL, COMMUNITY_TOPIC_LABEL,
  currentMember, listPublicCommunityComments, loginHref, meHref, myVotedPostIds, profileHref,
  type PublicCommunityComment, type PublicCommunityPost,
} from "@soop-lol/core/lib/contract/community";

import { CommentActions, CommentForm, DeletePostForm, ReportForm, VoteButton } from "./interactions.tsx";
import { communityHref, communityPostHref } from "./paths.ts";
import { authorLabel, fullWhen, PlainText, shortWhen } from "./text.tsx";

/**
 * 글 하나 — 본문·태그·추천·신고, 그 아래 댓글(대댓글은 한 단계). 숨긴 글·없는 글은 404(공개 뷰가 거른다).
 * ★ 지운 댓글은 공개 대댓글이 있을 때만 자리로 남는다("삭제된 댓글입니다").
 */
export async function PostDetail({ post }: { post: PublicCommunityPost | null }) {
  if (!post) notFound();
  const comments = await listPublicCommunityComments(post.post_id);
  const me = await currentMember();
  const voted = me ? (await myVotedPostIds([post.post_id])).has(post.post_id) : false;
  const here = communityPostHref(post.post_id);
  const isAuthor = !!me && post.author_id === me.member_id;
  const canWrite = !!me?.nickname;
  const signIn = !me ? loginHref(here) : meHref({ setup: 1, next: here });
  const site = post.game_code === "fconline" ? "fconline" : "lol";
  const top = comments.filter((c) => c.parent_id === null);
  const replies = (id: number) => comments.filter((c) => c.parent_id === id);
  const visibleCount = comments.filter((c) => c.visible).length;

  const Comment = ({ c, reply }: { c: PublicCommunityComment; reply?: boolean }) => <li className={reply ? "cm-comment cm-reply" : "cm-comment"}>
    {!c.visible
      ? <p className="cm-muted">삭제된 댓글입니다.</p>
      : <>
        <p className="cm-comment-meta"><b>{authorLabel(c.author_id, c.author_nickname)}</b> <span className="tabular">{shortWhen(c.created_at)}</span>{c.edited_at && <span> · 수정됨</span>}</p>
        <p className="cm-text"><PlainText text={c.body ?? ""} /></p>
        {me && <CommentActions postId={post.post_id} comment={{ id: c.comment_id, version: c.version, body: c.body ?? "" }}
          canReply={!reply && canWrite} isAuthor={c.author_id === me.member_id} canReport={canWrite && c.author_id !== me.member_id} />}
      </>}
    {!reply && replies(c.comment_id).length > 0 && <ol className="cm-replies">{replies(c.comment_id).map((r) => <Comment key={r.comment_id} c={r} reply />)}</ol>}
  </li>;

  return <div className="cm cm-detail">
    <p className="cm-back"><Link href={communityHref(post.game_code ? { game: post.game_code } : undefined)}>← 커뮤니티{post.game_code ? ` · ${COMMUNITY_GAME_LABEL[post.game_code]}` : ""}</Link></p>
    <article className="cm-article">
      <header>
        <p className="cm-article-tags">
          <span className={post.topic === "notice" ? "cm-topic cm-topic-notice" : "cm-topic"}>{COMMUNITY_TOPIC_LABEL[post.topic]}</span>
          {post.game_code && <span className="cm-game">{COMMUNITY_GAME_LABEL[post.game_code]}</span>}
        </p>
        <h1>{post.title}</h1>
        <p className="cm-article-meta">
          <b>{authorLabel(post.author_id, post.author_nickname)}</b>
          <span className="tabular">{fullWhen(post.created_at)}</span>
          {post.edited_at && <span>수정됨</span>}
        </p>
      </header>
      {post.streamers.length > 0 && <ul className="cm-streamers" aria-label="태그한 스트리머">
        {post.streamers.map((s) => <li key={s.streamer_id}>
          <Link href={profileHref(site, s.slug)}>{s.display_name}</Link>
          <Link href={communityHref({ s: s.slug, game: post.game_code ?? undefined })} className="cm-muted">이야기</Link>
        </li>)}
      </ul>}
      <div className="cm-text cm-body"><PlainText text={post.body} /></div>
      <div className="cm-article-actions">
        {post.topic !== "notice" && <VoteButton postId={post.post_id} likeCount={post.like_count} voted={voted} loginHref={signIn}
          mode={!me ? "login" : !me.nickname ? "nickname" : isAuthor ? "own" : "can"} />}
        {isAuthor && <>
          <Link href={communityPostHref(post.post_id, { edit: 1 })} className="cm-link-button">고치기</Link>
          <DeletePostForm postId={post.post_id} />
        </>}
        {canWrite && !isAuthor && post.author_id !== null && <ReportForm kind="post" targetId={post.post_id} />}
      </div>
    </article>

    <section className="cm-comments" aria-label="댓글 목록">
      <h2>댓글 {visibleCount}</h2>
      {top.length > 0 && <ol>{top.map((c) => <Comment key={c.comment_id} c={c} />)}</ol>}
      {canWrite ? <CommentForm postId={post.post_id} />
        : <p className="cm-muted"><Link href={signIn}>{me ? "닉네임을 정하고" : "로그인하고"}</Link> 댓글을 남길 수 있습니다.</p>}
    </section>
  </div>;
}
