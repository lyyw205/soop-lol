"use client";

/**
 * 글쓰기·고치기 폼. 저장이 거부돼도(검증·한도·제재·동시 수정) 입력값을 잃지 않는다 — 판단은 서버(core 접근자)가 한다.
 * 스트리머 태그는 slug 로 보내고 서버가 공개 명부에서 찾는다(숨긴 스트리머는 찾지 못한다).
 */

import Link from "next/link";
import { useState } from "react";

import {
  BODY_MAX, COMMUNITY_GAME_LABEL, COMMUNITY_GAMES, NO_GAME_LABEL, TAG_MAX, TITLE_MAX,
  type CommunityGame, type CommunityTopic,
} from "@soop-lol/core/lib/contract/community-client";

import { useKeptFormAction } from "../../../ui/use-kept-form-action.ts";
import { savePostAction } from "../server/actions.ts";
import { IDLE } from "./form-state.ts";
import type { communityQuery } from "./paths.ts";

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

export function ComposeForm({ initial, streamers, cancelHref, browse }: { initial: ComposeInitial; streamers: StreamerChoice[]; cancelHref: string; browse: ReturnType<typeof communityQuery> }) {
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
    {Object.entries(browse).map(([key, value]) => value && <input key={key} type="hidden" name={`return_${key}`} value={value} />)}
    {initial.id !== null && <input type="hidden" name="id" value={initial.id} />}
    {initial.version !== null && <input type="hidden" name="version" value={initial.version} />}
    <input type="hidden" name="tags" value={tags.map((t) => t.slug).join(",")} />
    <input type="hidden" name="topic" value={initial.topic} />
    <div className="cm-compose-row">
      <label><span>게임</span>
        <select name="game" defaultValue={initial.game ?? ""}>
          {COMMUNITY_GAMES.map((g) => <option key={g} value={g}>{COMMUNITY_GAME_LABEL[g]}</option>)}
          <option value="">{NO_GAME_LABEL}(게임 무관)</option>
        </select>
      </label>

    </div>
    <label className="cm-compose-field"><span>제목</span>
      <input name="title" required maxLength={TITLE_MAX} defaultValue={initial.title} />
    </label>
    <label className="cm-compose-field"><span className="cm-field-heading">본문 <small className="tabular">{body.length.toLocaleString()} / {BODY_MAX.toLocaleString()}</small></span>
      <textarea name="body" required maxLength={BODY_MAX} rows={12} value={body} onChange={(e) => setBody(e.target.value)}
        placeholder="내용을 입력해 주세요." />
    </label>
    <div className="cm-compose-field">
      <label htmlFor="cm-streamer-tag" className="cm-tag-label">스트리머 태그 <small>선택 · {tags.length}/{TAG_MAX}</small></label>
      <p id="cm-tag-help" className="cm-field-help">태그한 스트리머의 프로필에도 이 글이 표시됩니다.</p>
      {tags.length > 0 && <ul className="cm-tags">
        {tags.map((t) => <li key={t.slug}>{t.display_name}
          <button type="button" onClick={() => setTags(tags.filter((x) => x.slug !== t.slug))} aria-label={`${t.display_name} 태그 빼기`}>×</button></li>)}
      </ul>}
      <div className="cm-tag-input">
        <input id="cm-streamer-tag" list="cm-streamer-options" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="스트리머 이름"
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTag(); } }} aria-describedby="cm-tag-help" />
        <button type="button" onClick={addTag}>추가</button>
      </div>
      <datalist id="cm-streamer-options">{streamers.map((s) => <option key={s.slug} value={`${s.display_name} (${s.slug})`} />)}</datalist>
      {tagError && <p className="cm-error" role="alert">{tagError}</p>}
    </div>
    {state.message && <p className={state.ok ? "cm-ok" : "cm-error"} role="alert">{state.message}</p>}
    <div className="cm-compose-foot">
      <Link href={cancelHref} className="cm-secondary">취소</Link>
      <button type="submit" className="cm-write" disabled={pending}>{pending ? "저장 중…" : initial.id === null ? "등록" : "수정 완료"}</button>
    </div>
  </form>;
}
