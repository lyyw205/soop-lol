/**
 * 커뮤니티 모듈 화면. host 가 로비(플랫폼) 틀 안에서 띄운다. docs/COMMUNITY-PLAN.md §4
 *
 * ★ 경로는 편성표처럼 둘이다 — /community(목록)와 /community/[id](상세). 글쓰기는 ?write=1, 고치기는 /community/[id]?edit=1.
 *   값이 "1" 인지로 가른다(값을 비우면 주소 함수가 그 쿼리를 지운다). 독립 화면이 늘면 이름 있는 경로를 지원한다.
 * ★ 자기 표가 없다 — core 계약(contract/community)만 읽고 쓴다. 판단은 core 접근자 하나가 한다.
 */

import { notFound, redirect } from "next/navigation";
import { cache } from "react";

import { getPublicStreamer, listPublicStreamerOptions } from "@soop-lol/core/lib/contract";
import {
  currentMember, getPublicCommunityPost, loginHref, meHref, parseContentId, parseGameFilter,
} from "@soop-lol/core/lib/contract/community";

import { ComposeForm, type ComposeInitial, type StreamerChoice } from "./compose.tsx";
import { CommunityList } from "./list.tsx";
import { communityHref, communityPostHref } from "./paths.ts";
import { PostDetail } from "./post.tsx";
import "./community.css";

type Props = {
  params?: Record<string, string>;
  searchParams: Record<string, string | string[] | undefined>;
};

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
// 제목과 본문이 같은 요청에서 두 번 읽지 않게 한다.
const loadPost = cache(getPublicCommunityPost);

export async function generateMetadata({ params, searchParams }: Props) {
  const id = parseContentId(params?.id);
  if (id !== null) {
    const post = await loadPost(id);
    return { title: post ? (one(searchParams.edit) === "1" ? `고치기 — ${post.title}` : post.title) : "커뮤니티" };
  }
  return { title: one(searchParams.write) === "1" ? "글쓰기" : "커뮤니티" };
}

async function streamerChoices(): Promise<StreamerChoice[]> {
  return (await listPublicStreamerOptions()).map((s) => ({ slug: s.slug, display_name: s.display_name }));
}

/** 글쓰기 — 로그인·닉네임이 없으면 거기로 보낸다. 들어온 문맥(게임·스트리머)을 기본값으로 채운다. */
async function Compose({ searchParams }: { searchParams: Props["searchParams"] }) {
  const game = parseGameFilter(one(searchParams.game));
  const slugs = [one(searchParams.s)].filter((s): s is string => !!s && /^[\w.-]{1,64}$/.test(s));
  const here = communityHref({ write: 1, game: game && game !== "etc" ? game : undefined, s: one(searchParams.s) });
  const me = await currentMember();
  if (!me) redirect(loginHref(here));
  if (!me.nickname) redirect(meHref({ setup: 1, next: here }));
  const tags: StreamerChoice[] = [];
  for (const slug of [...new Set(slugs)]) {
    const s = await getPublicStreamer(slug);
    if (s) tags.push({ slug: s.slug, display_name: s.display_name });
  }
  const initial: ComposeInitial = {
    id: null, version: null, game: game === "lol" || game === "fconline" ? game : null, topic: "free", title: "", body: "", tags,
  };
  const back = communityHref({ game: game ?? undefined, s: one(searchParams.s) });
  return <div className="cm cm-compose-page">
    <div className="cm-heading"><div><h1>글쓰기</h1><p>스트리머를 태그하면 그 사람 프로필의 &lsquo;이 스트리머 이야기&rsquo; 에 모입니다.</p></div></div>
    <ComposeForm initial={initial} streamers={await streamerChoices()} cancelHref={back} />
  </div>;
}

/** 고치기 — 작성자만, 공개 글만(숨긴 글은 공개 뷰에 없어 404 다 — 고쳐서 다시 공개되지 않는다). */
async function Edit({ id }: { id: number }) {
  const me = await currentMember();
  if (!me) redirect(loginHref(communityPostHref(id, { edit: 1 })));
  const post = await loadPost(id);
  if (!post || post.author_id !== me.member_id) notFound();
  const initial: ComposeInitial = {
    id, version: post.version, game: post.game_code, topic: post.topic === "notice" ? "free" : post.topic,
    title: post.title, body: post.body, tags: post.streamers.map((s) => ({ slug: s.slug, display_name: s.display_name })),
  };
  return <div className="cm cm-compose-page">
    <div className="cm-heading"><div><h1>글 고치기</h1><p>고친 뒤에는 &lsquo;수정됨&rsquo; 이 표시됩니다.</p></div></div>
    <ComposeForm initial={initial} streamers={await streamerChoices()} cancelHref={communityPostHref(id)} />
  </div>;
}

export default async function CommunityPage({ params, searchParams }: Props) {
  if (params?.id !== undefined) {
    const id = parseContentId(params.id);
    if (id === null) notFound(); // 숫자가 아닌 번호 — 질의 전에 거른다(캐스트 오류로 500 을 내지 않는다)
    if (one(searchParams.edit) === "1") return <Edit id={id} />;
    return <PostDetail post={await loadPost(id)} />;
  }
  if (one(searchParams.write) === "1") return <Compose searchParams={searchParams} />;
  return <CommunityList searchParams={searchParams} />;
}
