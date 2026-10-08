"use client";

/**
 * 글쓰기·고치기 폼. 저장이 거부돼도(검증·한도·제재·동시 수정) 입력값을 잃지 않는다 — 판단은 서버(core 접근자)가 한다.
 * 스트리머 태그는 slug 로 보내고 서버가 공개 명부에서 찾는다(숨긴 스트리머는 찾지 못한다).
 */

import Link from "next/link";
import { useState } from "react";

import {
  BODY_MAX, COMMUNITY_GAME_LABEL, COMMUNITY_GAMES, COMMUNITY_TOPIC_LABEL, MEMBER_TOPICS, TAG_MAX, TITLE_MAX,
  type CommunityGame, type CommunityTopic,
} from "@soop-lol/core/lib/contract/community-client";

import { useKeptFormAction } from "../../../ui/use-kept-form-action.ts";
import { savePostAction } from "../server/actions.ts";
import { IDLE } from "./form-state.ts";

export interface StreamerChoice { slug: string; display_name: string }

export interface ComposeInitial {
  id: number | null;
  version: string | null;
  game: CommunityGame | null;
  topic: CommunityTopic;
  title: string;
  body: string;
  tags: StreamerChoice[];
}

export function ComposeForm({ initial, streamers, cancelHref }: { initial: ComposeInitial; streamers: StreamerChoice[]; cancelHref: string }) {
  const { state, dispatch: action, pending, onSubmit } = useKeptFormAction(savePostAction, IDLE);
  const [tags, setTags] = useState<StreamerChoice[]>(initial.tags);
  const [query, setQuery] = useState("");
  const [body, setBody] = useState(initial.body);
  const [tagError, setTagError] = useState("");

  function addTag() {
    const q = query.trim();
    if (!q) return;
    const bySlug = /\(([\w.-]+)\)\s*$/.exec(q)?.[1];
    const found = streamers.find((s) => s.slug === bySlug) ?? streamers.find((s) => s.display_name === q || s.slug === q);
    if (!found) { setTagError("등록된 스트리머 이름으로 골라 주세요."); return; }
    if (tags.some((t) => t.slug === found.slug)) { setQuery(""); return; }
    if (tags.length >= TAG_MAX) { setTagError(`스트리머는 ${TAG_MAX}명까지 태그할 수 있습니다.`); return; }
    setTags([...tags, found]); setQuery(""); setTagError("");
  }

  return <form action={action} onSubmit={onSubmit} className="cm-compose">
    {initial.id !== null && <input type="hidden" name="id" value={initial.id} />}
    {initial.version !== null && <input type="hidden" name="version" value={initial.version} />}
    <input type="hidden" name="tags" value={tags.map((t) => t.slug).join(",")} />
    <div className="cm-compose-row">
      <label><span>게임</span>
        <select name="game" defaultValue={initial.game ?? ""}>
          <option value="">공통(게임 무관)</option>
          {COMMUNITY_GAMES.map((g) => <option key={g} value={g}>{COMMUNITY_GAME_LABEL[g]}</option>)}
        </select>
      </label>
      <label><span>말머리</span>
        <select name="topic" defaultValue={initial.topic}>
          {MEMBER_TOPICS.map((t) => <option key={t} value={t}>{COMMUNITY_TOPIC_LABEL[t]}</option>)}
        </select>
      </label>
    </div>
    <label className="cm-compose-field"><span>제목</span>
      <input name="title" required maxLength={TITLE_MAX} defaultValue={initial.title} />
    </label>
    <label className="cm-compose-field"><span>본문 <small className="tabular">{body.length.toLocaleString()} / {BODY_MAX.toLocaleString()}</small></span>
      <textarea name="body" required maxLength={BODY_MAX} rows={12} value={body} onChange={(e) => setBody(e.target.value)}
        placeholder="일반 텍스트로 씁니다. http(s) 주소는 링크가 됩니다." />
    </label>
    <div className="cm-compose-field">
      <span>스트리머 태그 <small>{tags.length}/{TAG_MAX} · 프로필의 &lsquo;이 스트리머 이야기&rsquo; 에 모입니다</small></span>
      {tags.length > 0 && <ul className="cm-tags">
        {tags.map((t) => <li key={t.slug}>{t.display_name}
          <button type="button" onClick={() => setTags(tags.filter((x) => x.slug !== t.slug))} aria-label={`${t.display_name} 태그 빼기`}>×</button></li>)}
      </ul>}
      <div className="cm-tag-input">
        <input list="cm-streamer-options" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="스트리머 이름"
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTag(); } }} aria-label="태그할 스트리머" />
        <button type="button" onClick={addTag}>추가</button>
      </div>
      <datalist id="cm-streamer-options">{streamers.map((s) => <option key={s.slug} value={`${s.display_name} (${s.slug})`} />)}</datalist>
      {tagError && <p className="cm-error" role="alert">{tagError}</p>}
    </div>
    {state.message && <p className={state.ok ? "cm-ok" : "cm-error"} role="alert">{state.message}</p>}
    <div className="cm-compose-foot">
      <Link href={cancelHref} className="cm-link-button">취소</Link>
      <button type="submit" className="cm-write" disabled={pending}>{initial.id === null ? "올리기" : "고친 내용 저장"}</button>
    </div>
  </form>;
}
