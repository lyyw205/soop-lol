import Link from "next/link";
import { ArrowLeft, ChevronUp, ChevronDown, UserRound, MessagesSquare } from "lucide-react";
import { notFound } from "next/navigation";

import {
  COMMUNITY_GAME_LABEL,
  publicProfileLinks, currentMember, getPublicCommunityNeighbors, parseGameFilter, listPublicCommunityComments, loginHref, meHref, myVotedPostIds, profileHref,
  type PublicCommunityComment, type PublicCommunityPost,
} from "@soop-lol/core/lib/contract/community";

import { CommentActions, CommentForm, DeletePostForm, ReportForm, VoteButton } from "./interactions.tsx";
import { communityHref, communityPostHref, type communityQuery } from "./paths.ts";
import { authorLabel, fullWhen, PlainText, shortWhen } from "./text.tsx";

/**
 * 글 하나 — 본문·태그·추천·신고, 그 아래 댓글(대댓글은 한 단계). 숨긴 글·없는 글은 404(공개 뷰가 거른다).
 * ★ 지운 댓글은 공개 대댓글이 있을 때만 자리로 남는다("삭제된 댓글입니다").
 */
export async function PostDetail({ post, browse }: { post: PublicCommunityPost | null; browse: ReturnType<typeof communityQuery> }) {
  if (!post) notFound();
  const comments = await listPublicCommunityComments(post.post_id);
  const neighbors = await getPublicCommunityNeighbors(post.post_id, { game: parseGameFilter(browse.game), streamer: browse.s ?? null, author: browse.author ?? null });
  const me = await currentMember();
  const voted = me ? (await myVotedPostIds([post.post_id])).has(post.post_id) : false;
  const here = communityPostHref(post.post_id, browse);
  const isAuthor = !!me && post.author_id === me.member_id;
  const canWrite = !!me?.nickname;
  const signIn = !me ? loginHref(here) : meHref({ setup: 1, next: here });
  const profileLinks = await publicProfileLinks(post.streamers.map(s => s.slug), post.game_code, browse.site);
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
    <article className="cm-article">
      <header>
        {(post.topic === "notice" || post.game_code) && <p className="cm-article-tags">
          {post.topic === "notice" && <span className="cm-topic cm-topic-notice">공지</span>}
          {post.game_code && <span className="cm-game">{COMMUNITY_GAME_LABEL[post.game_code]}</span>}
        </p>}
        <h1>{post.title}</h1>
        <p className="cm-article-meta">
          <b>{authorLabel(post.author_id, post.author_nickname)}</b>
          <span className="tabular">{fullWhen(post.created_at)}</span>
          {post.edited_at && <span>수정됨</span>}
        </p>


      </header>
      <div className="cm-text cm-body"><PlainText text={post.body} /></div>
      <footer className="cm-post-footer">
        <div className="cm-post-response">
          {post.topic !== "notice" && <div className="cm-recommend-action"><VoteButton postId={post.post_id} likeCount={post.like_count} voted={voted} loginHref={signIn}
            mode={!me ? "login" : !me.nickname ? "nickname" : isAuthor ? "own" : "can"} /></div>}
        {post.streamers.length > 0 && <section className="cm-related" aria-label="이 글에 태그된 스트리머">
          <ul className="cm-streamers">
            {post.streamers.map((s) => <li key={s.streamer_id}>
              <div className="cm-streamer-group" role="group" aria-label={`${s.display_name} 관련 링크`}>
                <strong>{s.display_name}</strong>
                <div className="cm-streamer-links">
                  <Link href={profileLinks.get(s.slug)!} aria-label={`${s.display_name} 프로필 보기`}><UserRound size={15} aria-hidden="true" />프로필</Link>
                  <Link href={communityHref({ site: browse.site, s: s.slug, game: post.game_code ?? undefined })} aria-label={`${s.display_name} 글 모아보기`}><MessagesSquare size={15} aria-hidden="true" />글 모아보기</Link>
                </div>
              </div>
            </li>)}
          </ul>
        </section>}
          {(isAuthor || (canWrite && post.author_id !== null)) && <div className="cm-post-manage">
            {isAuthor ? <><Link href={communityPostHref(post.post_id, { ...browse, edit: 1 })} className="cm-link-button">수정</Link><DeletePostForm postId={post.post_id} browse={browse} /></>
              : <ReportForm kind="post" targetId={post.post_id} />}
          </div>}
          <Link href={communityHref(browse)} className="cm-secondary cm-list-return"><ArrowLeft size={15} aria-hidden="true" />목록으로</Link>
        </div>
      </footer>
    </article>

    <section className="cm-comments" aria-label="댓글 목록">
      <div className="cm-comments-heading"><h2>댓글 <span>{visibleCount}</span></h2></div>
      {top.length > 0 && <ol>{top.map((c) => <Comment key={c.comment_id} c={c} />)}</ol>}
      {canWrite ? <CommentForm postId={post.post_id} />
        : <p className="cm-comment-signin"><Link href={signIn}>{me ? "닉네임을 정하고" : "로그인하고"}</Link> 댓글을 남길 수 있습니다.</p>}
    </section>
    <nav className="cm-neighbor-posts" aria-label="이전 글과 다음 글">
      {([{ key: "previous", label: "이전 글", icon: ChevronUp }, { key: "next", label: "다음 글", icon: ChevronDown }] as const).map(({ key, label, icon: Icon }) => {
        const neighbor = neighbors[key];
        return neighbor ? <Link key={key} href={communityPostHref(neighbor.post_id, { ...browse, cursor: undefined })}>
          <span><Icon size={16} aria-hidden="true" />{label}</span><strong>{neighbor.title}</strong>
        </Link> : <div key={key} className="cm-neighbor-empty"><span><Icon size={16} aria-hidden="true" />{label}</span><span>{label}이 없습니다.</span></div>;
      })}
    </nav>
  </div>;
}
