import Link from "next/link";
import type { ReactNode } from "react";

import { getPublicStreamer } from "@soop-lol/core/lib/contract";
import {
  COMMUNITY_GAME_LABEL, COMMUNITY_TOPIC_LABEL, MEMBER_TOPICS, NO_GAME_LABEL,
  currentMember, listPublicCommunityPosts, listPublicNotices, loginHref, meHref, parseGameFilter, parseTopicFilter, profileHref,
  type CommunityTopic, type GameFilter, type PublicCommunityPostRow,
} from "@soop-lol/core/lib/contract/community";

import { communityHref, communityPostHref } from "./paths.ts";
import { authorLabel, shortWhen } from "./text.tsx";

type RoleHref = (role: string, params?: Record<string, string>, query?: Record<string, string>) => string | null;
type Params = Record<string, string | string[] | undefined>;

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
const slug = (v: string | undefined) => (v && /^[\w.-]{1,64}$/.test(v) ? v : null);

const GAME_CHIPS: { value: GameFilter; label: string }[] = [
  { value: null, label: "전체" },
  { value: "lol", label: COMMUNITY_GAME_LABEL.lol }, { value: "fconline", label: COMMUNITY_GAME_LABEL.fconline },
  { value: "etc", label: NO_GAME_LABEL },
];
const TOPIC_CHIPS: { value: CommunityTopic | null; label: string }[] = [
  { value: null, label: "전체" }, ...MEMBER_TOPICS.map((t) => ({ value: t, label: COMMUNITY_TOPIC_LABEL[t] })),
  { value: "notice", label: COMMUNITY_TOPIC_LABEL.notice },
];

function Row({ post }: { post: PublicCommunityPostRow }) {
  return <li className="cm-row">
    <Link href={communityPostHref(post.post_id)} className="cm-row-main">
      <span className="cm-topic">{COMMUNITY_TOPIC_LABEL[post.topic]}</span>
      {post.game_code && <span className="cm-game">{COMMUNITY_GAME_LABEL[post.game_code]}</span>}
      <strong>{post.title}</strong>
      {post.comment_count > 0 && <span className="cm-count" aria-label={`댓글 ${post.comment_count}개`}>[{post.comment_count}]</span>}
    </Link>
    <span className="cm-row-meta">
      <span>{authorLabel(post.author_id, post.author_nickname)}</span>
      <span className="tabular">{shortWhen(post.created_at)}</span>
      <span className="tabular" aria-label={`추천 ${post.like_count}`}>추천 {post.like_count}</span>
    </span>
  </li>;
}

/**
 * 목록 — 게임 칩(전체·LOL·FC·기타) × 말머리 칩, 그 아래 공지 띠, 그 아래 글. 필터는 전부 주소다(공유한 주소가 같은 화면).
 * ★ ?game=lol 에 기타 글을 섞지 않는다(편성표와 같은 뜻). ★ ?s= · ?a=&b= 로 들어오면 그 사람(들) 이야기만, 비었으면 "첫 글 쓰기".
 */
export async function CommunityList({ searchParams, roleHref }: { searchParams: Params; roleHref: RoleHref }) {
  const game = parseGameFilter(one(searchParams.game));
  const topic = parseTopicFilter(one(searchParams.topic));
  const s = slug(one(searchParams.s));
  const a = slug(one(searchParams.a)), b = slug(one(searchParams.b));
  const pair: [string, string] | null = a && b && a !== b ? [a, b] : null;
  const author = one(searchParams.author) ?? null;
  const cursor = one(searchParams.cursor) ?? null;

  // 질의는 순서대로 — 화면 하나의 동시 질의를 늘리지 않는다(PLAN §M4-1).
  const person = s ? await getPublicStreamer(s) : null;
  const pairPeople = pair ? [await getPublicStreamer(pair[0]), await getPublicStreamer(pair[1])] : null;
  const missing = (s && !person) || (pairPeople && pairPeople.some((p) => !p));
  const notices = !missing && topic === null && !s && !pair && !author && !cursor ? await listPublicNotices(game) : [];
  const { posts, next } = missing ? { posts: [], next: null } : await listPublicCommunityPosts({ game, topic, streamer: s, pair, author, cursor });
  const me = await currentMember();

  type Query = Record<string, string | undefined>;
  const filters: Query = { game: game ?? undefined, topic: topic ?? undefined, s: s ?? undefined, a: pair?.[0], b: pair?.[1], author: author ?? undefined };
  const href = (changes: Query) => communityHref({ ...filters, cursor: undefined, ...changes });
  const writeTarget = communityHref({ write: 1, game: game && game !== "etc" ? game : undefined, s: s ?? undefined, a: pair?.[0], b: pair?.[1] });
  const writeHref = !me ? loginHref(writeTarget) : me.nickname ? writeTarget : meHref({ setup: 1, next: writeTarget });
  const site = game === "fconline" ? "fconline" : "lol";

  let title = "커뮤니티";
  let lead: ReactNode = "스트리머 이야기를 게임별로 나눠 봅니다. 읽기는 누구나, 글쓰기는 로그인한 회원만 할 수 있습니다.";
  if (missing) {
    title = "찾을 수 없는 스트리머";
    lead = <Link href={communityHref()}>커뮤니티 전체 글 보기</Link>;
  } else if (person) {
    title = `${person.display_name} 이야기`;
    lead = <><Link href={profileHref(site, person.slug)}>프로필 보기</Link> · <Link href={href({ s: undefined })}>전체 글</Link></>;
  } else if (pairPeople && pair) {
    const versus = roleHref(game === "fconline" ? "fc-versus" : "versus", {}, { a: pair[0], b: pair[1] });
    title = `${pairPeople[0]!.display_name} · ${pairPeople[1]!.display_name} 맞대결 이야기`;
    lead = <>{versus && <><Link href={versus}>상대전적 보기</Link> · </>}<Link href={href({ a: undefined, b: undefined })}>전체 글</Link></>;
  } else if (author) {
    title = posts[0] ? `${authorLabel(posts[0].author_id, posts[0].author_nickname)}의 글` : "회원의 글";
    lead = <Link href={href({ author: undefined })}>전체 글</Link>;
  }

  return <div className="cm">
    <div className="cm-heading">
      <div><h1>{title}</h1><p>{lead}</p></div>
      <Link href={writeHref} className="cm-write">글쓰기</Link>
    </div>
    <div className="cm-toolbar">
      <nav className="cm-chips" aria-label="게임">
        {GAME_CHIPS.map((c) => <Link key={c.label} href={href({ game: c.value ?? undefined })} aria-current={game === c.value ? "true" : undefined}>{c.label}</Link>)}
      </nav>
      <nav className="cm-chips" aria-label="말머리">
        {TOPIC_CHIPS.map((c) => <Link key={c.label} href={href({ topic: c.value ?? undefined })} aria-current={topic === c.value ? "true" : undefined}>{c.label}</Link>)}
      </nav>
    </div>
    {notices.length > 0 && <ul className="cm-notices" aria-label="공지">
      {notices.map((n) => <li key={n.post_id}>
        <span className="cm-topic cm-topic-notice">공지</span>
        {n.game_code && <span className="cm-game">{COMMUNITY_GAME_LABEL[n.game_code]}</span>}
        <Link href={communityPostHref(n.post_id)}>{n.title}</Link>
        <span className="cm-row-meta tabular">{shortWhen(n.created_at)}</span>
      </li>)}
    </ul>}
    {posts.length === 0
      ? <div className="cm-empty"><p>아직 글이 없습니다.</p>{!missing && <Link href={writeHref} className="cm-write">첫 글 쓰기</Link>}</div>
      : <ol className="cm-list">{posts.map((p) => <Row key={p.post_id} post={p} />)}</ol>}
    {next && <p className="cm-more"><Link href={href({ cursor: next })}>다음 글 더 보기</Link></p>}
  </div>;
}
