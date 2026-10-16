import Link from "next/link";
import { ArrowRight, PenLine } from "lucide-react";
import "./list.css";
import type { ReactNode } from "react";

import { getPublicStreamer } from "@soop-lol/core/lib/contract";
import {
  COMMUNITY_GAME_LABEL, NO_GAME_LABEL,
  publicProfileLinks, currentMember, listPublicCommunityPosts, listPublicNotices, loginHref, meHref, parseGameFilter,
  type GameFilter, type PublicCommunityPostRow,
} from "@soop-lol/core/lib/contract/community";

import { communityHref, communityPostHref, communityQuery } from "./paths.ts";
import { authorLabel, shortWhen } from "./text.tsx";

type Params = Record<string, string | string[] | undefined>;

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
const slug = (v: string | undefined) => (v && /^[\w.-]{1,64}$/.test(v) ? v : null);

const GAME_CHIPS: { value: GameFilter; label: string }[] = [
  { value: null, label: "전체" },
  { value: "lol", label: COMMUNITY_GAME_LABEL.lol }, { value: "fconline", label: COMMUNITY_GAME_LABEL.fconline },
  { value: "etc", label: NO_GAME_LABEL },
];

function Row({ post, query }: { post: PublicCommunityPostRow; query: Record<string, string | undefined> }) {
  return <li className="cm-row">
    <span className="cm-post-number" aria-label={`글 번호 ${post.post_id}`}>{post.post_id}</span>
    <Link href={communityPostHref(post.post_id, query)} className="cm-row-main">
      {post.game_code && <span className="cm-post-game">{COMMUNITY_GAME_LABEL[post.game_code]}</span>}
      <span className="cm-post-title">{post.title}</span>
      {post.comment_count > 0 && <span className="cm-post-comments" aria-label={`댓글 ${post.comment_count}개`}>[{post.comment_count}]</span>}
    </Link>
    <span className="cm-post-author">{authorLabel(post.author_id, post.author_nickname)}</span>
    <time className="cm-post-date" dateTime={new Date(post.created_at).toISOString()}>{shortWhen(post.created_at)}</time>
    <span className="cm-post-likes" aria-label={`추천 ${post.like_count}개`}><span>추천 </span>{post.like_count}</span>
  </li>;
}

/**
 * 목록 — 게임 탭(전체·LOL·FC·기타), 그 아래 공지 띠, 그 아래 글. 필터는 전부 주소다(공유한 주소가 같은 화면).
 * ★ ?game=lol 에 기타 글을 섞지 않는다(편성표와 같은 뜻). ★ ?s= 로 들어오면 그 사람 이야기만, 비었으면 "첫 글 쓰기".
 */
export async function CommunityList({ searchParams }: { searchParams: Params }) {
  const context = communityQuery(searchParams);
  const game = parseGameFilter(one(searchParams.game));
  const s = slug(one(searchParams.s));
  const author = one(searchParams.author) ?? null;
  const cursor = one(searchParams.cursor) ?? null;

  // 질의는 순서대로 — 화면 하나의 동시 질의를 늘리지 않는다(PLAN §M4-1).
  const person = s ? await getPublicStreamer(s) : null;
  const missing = s !== null && !person;
  const notices = !missing && !s && !author && !cursor ? await listPublicNotices(game) : [];
  const { posts, next } = missing ? { posts: [], next: null } : await listPublicCommunityPosts({ game, topic: null, streamer: s, author, cursor });
  const me = await currentMember();

  type Query = Record<string, string | undefined>;
  const filters: Query = { site: context.site, game: game ?? undefined, s: s ?? undefined, author: author ?? undefined };
  const href = (changes: Query) => communityHref({ ...filters, cursor: undefined, ...changes });
  const writeTarget = communityHref({ ...filters, write: 1, game: game && game !== "etc" ? game : undefined });
  const writeHref = !me ? loginHref(writeTarget) : me.nickname ? writeTarget : meHref({ setup: 1, next: writeTarget });
  const profileLinks = await publicProfileLinks(person ? [person.slug] : [], game, context.site);

  let title = "커뮤니티";
  let lead: ReactNode = "게임과 스트리머 이야기를 자유롭게 나눠 보세요.";
  if (missing) {
    title = "찾을 수 없는 스트리머";
    lead = <Link href={href({ s: undefined })}>커뮤니티 전체 글 보기</Link>;
  } else if (person) {
    title = `${person.display_name} 이야기`;
    lead = <><Link href={profileLinks.get(person.slug)!}>프로필 보기</Link> · <Link href={href({ s: undefined })}>전체 글</Link></>;
  } else if (author) {
    title = posts[0] ? `${authorLabel(posts[0].author_id, posts[0].author_nickname)}의 글` : "회원의 글";
    lead = <Link href={href({ author: undefined })}>전체 글</Link>;
  }

  return <div className="cm cm-board">
    <header className="cm-heading">
      <div><h1>{title}</h1><p>{lead}</p></div>
      <Link href={writeHref} className="cm-write"><PenLine size={17} aria-hidden="true" />글쓰기</Link>
    </header>
    <div className="cm-browse-layout">
    <div className="cm-toolbar" aria-label="게시글 필터">
      <div className="cm-game-filter">
      <nav className="cm-game-tabs" aria-label="게임">
        {GAME_CHIPS.map((c) => <Link key={c.label} href={href({ game: c.value ?? undefined })} aria-current={game === c.value ? "true" : undefined}>{c.label}</Link>)}
      </nav>
      </div>

    </div>
    <section className="cm-feed" aria-label="게시글 목록">
    <div className="cm-list-columns" aria-hidden="true"><span>번호</span><span>제목</span><span>글쓴이</span><span>작성일</span><span>추천</span></div>
    {notices.length > 0 && <ul className="cm-notices" aria-label="공지">
      {notices.map((n) => <li key={n.post_id}>
        <span className="cm-topic cm-topic-notice">공지</span>
        {n.game_code && <span className="cm-game">{COMMUNITY_GAME_LABEL[n.game_code]}</span>}
        <Link href={communityPostHref(n.post_id, filters)}>{n.title}</Link>
        <span className="cm-row-meta tabular">{shortWhen(n.created_at)}</span>
      </li>)}
    </ul>}
    {posts.length === 0
      ? <div className="cm-empty"><h3>{missing ? "스트리머를 찾을 수 없어요" : "아직 이야기가 없어요"}</h3><p>{missing ? "상단의 전체 글 보기에서 다른 이야기를 둘러보세요." : "이 주제의 첫 이야기를 남겨 보세요."}</p>{!missing && <Link href={writeHref} className="cm-write">첫 글 쓰기</Link>}</div>
      : <ol className="cm-list">{posts.map((p) => <Row key={p.post_id} post={p} query={{ ...filters, cursor: cursor ?? undefined }} />)}</ol>}
    {next && <p className="cm-more"><Link href={href({ cursor: next })}>다음 글 더 보기<ArrowRight size={16} aria-hidden="true" /></Link></p>}
    </section>

    </div>
  </div>;
}
