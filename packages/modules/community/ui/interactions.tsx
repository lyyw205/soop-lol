"use client";

/**
 * 글·댓글 화면의 손으로 누르는 부분 — 추천·신고·지우기·댓글 쓰기·고치기. 판단은 서버(core 접근자)가 한다.
 * 거부되면(로그인·한도·제재·동시 수정) 그 사유를 그대로 보여 주고 입력값을 잃지 않는다.
 */

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { COMMENT_MAX, REPORT_DETAIL_MAX, REPORT_REASON_LABEL, REPORT_REASONS } from "@soop-lol/core/lib/contract/community-client";

import { useKeptFormAction } from "../../../ui/use-kept-form-action.ts";
import { commentAction, deleteCommentAction, deletePostAction, editCommentAction, reportAction, voteAction } from "../server/actions.ts";
import { IDLE, type FormResult } from "./form-state.ts";

function Message({ state }: { state: FormResult }) {
  if (!state.message) return null;
  return <p className={state.ok ? "cm-ok" : "cm-error"} role={state.ok ? "status" : "alert"}>{state.message}</p>;
}

export function VoteButton({ postId, likeCount, voted, mode, loginHref }: {
  postId: number; likeCount: number; voted: boolean; mode: "can" | "own" | "login" | "nickname"; loginHref: string;
}) {
  const { state, dispatch: action, pending, onSubmit } = useKeptFormAction(voteAction, IDLE);
  if (mode === "login" || mode === "nickname") {
    return <Link href={loginHref} className="cm-vote" aria-label={`추천 ${likeCount} — 로그인하고 추천하기`}>추천 {likeCount}</Link>;
  }
  return <form action={action} onSubmit={onSubmit} className="cm-inline">
    <input type="hidden" name="post" value={postId} />
    <button type="submit" className="cm-vote" aria-pressed={voted} disabled={pending || mode === "own" || voted}
      title={mode === "own" ? "내 글은 추천할 수 없습니다" : voted ? "추천했습니다" : "추천하기"}>추천 {likeCount}</button>
    <Message state={state} />
  </form>;
}

export function ReportForm({ kind, targetId }: { kind: "post" | "comment"; targetId: number }) {
  const { state, dispatch: action, pending, onSubmit } = useKeptFormAction(reportAction, IDLE);
  if (state.ok && state.message) return <Message state={state} />;
  return <details className="cm-report">
    <summary>신고</summary>
    <form action={action} onSubmit={onSubmit} className="cm-report-form">
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="target" value={targetId} />
      <select name="reason" required defaultValue="" aria-label="신고 사유">
        <option value="" disabled>사유를 고르세요</option>
        {REPORT_REASONS.map((r) => <option key={r} value={r}>{REPORT_REASON_LABEL[r]}</option>)}
      </select>
      <input name="detail" maxLength={REPORT_DETAIL_MAX} placeholder="설명(기타는 필수)" aria-label="신고 설명" />
      <button type="submit" disabled={pending}>신고하기</button>
      <Message state={state} />
    </form>
  </details>;
}

export function DeletePostForm({ postId }: { postId: number }) {
  const { state, dispatch: action, pending, onSubmit } = useKeptFormAction(deletePostAction, IDLE, { confirm: "이 글을 지울까요? 지운 글은 되살릴 수 없습니다." });
  return <form action={action} onSubmit={onSubmit} className="cm-inline">
    <input type="hidden" name="id" value={postId} />
    <button type="submit" className="cm-link-button" disabled={pending}>지우기</button>
    <Message state={state} />
  </form>;
}

export function CommentForm({ postId, parentId, onDone, autoFocus }: { postId: number; parentId?: number; onDone?: () => void; autoFocus?: boolean }) {
  const { state, dispatch: action, pending, onSubmit } = useKeptFormAction(commentAction, IDLE);
  const form = useRef<HTMLFormElement>(null);
  const seen = useRef(state);
  useEffect(() => {
    // 저장에 성공하면 입력칸을 비운다(실패하면 그대로 둔다 — 입력값을 잃지 않는다).
    if (state !== seen.current && state.ok) { form.current?.reset(); onDone?.(); }
    seen.current = state;
  }, [state, onDone]);
  return <form ref={form} action={action} onSubmit={onSubmit} className="cm-comment-form">
    <input type="hidden" name="post" value={postId} />
    {parentId && <input type="hidden" name="parent" value={parentId} />}
    <textarea name="body" required maxLength={COMMENT_MAX} rows={parentId ? 2 : 3} autoFocus={autoFocus}
      placeholder={parentId ? "답글" : "댓글을 남겨 주세요"} aria-label={parentId ? "답글" : "댓글"} />
    <div className="cm-comment-form-foot"><Message state={state} /><button type="submit" disabled={pending}>{parentId ? "답글 달기" : "댓글 달기"}</button></div>
  </form>;
}

export function CommentActions({ postId, comment, canReply, isAuthor, canReport }: {
  postId: number; comment: { id: number; version: string; body: string }; canReply: boolean; isAuthor: boolean; canReport: boolean;
}) {
  const [mode, setMode] = useState<"none" | "reply" | "edit">("none");
  const { state: editState, dispatch: editAction, pending: editing, onSubmit: onEdit } = useKeptFormAction(editCommentAction, IDLE);
  const { state: deleteState, dispatch: deleteAction, pending: deleting, onSubmit: onDelete } = useKeptFormAction(deleteCommentAction, IDLE, { confirm: "이 댓글을 지울까요?" });
  const seenEdit = useRef(editState);
  useEffect(() => {
    if (editState !== seenEdit.current && editState.ok) setMode("none");
    seenEdit.current = editState;
  }, [editState]);
  return <div className="cm-comment-actions">
    <div className="cm-comment-buttons">
      {canReply && <button type="button" className="cm-link-button" onClick={() => setMode(mode === "reply" ? "none" : "reply")}>답글</button>}
      {isAuthor && <button type="button" className="cm-link-button" onClick={() => setMode(mode === "edit" ? "none" : "edit")}>고치기</button>}
      {isAuthor && <form action={deleteAction} onSubmit={onDelete} className="cm-inline">
        <input type="hidden" name="post" value={postId} /><input type="hidden" name="comment" value={comment.id} />
        <button type="submit" className="cm-link-button" disabled={deleting}>지우기</button>
      </form>}
      {canReport && <ReportForm kind="comment" targetId={comment.id} />}
    </div>
    <Message state={deleteState} />
    {mode === "reply" && <CommentForm postId={postId} parentId={comment.id} onDone={() => setMode("none")} autoFocus />}
    {mode === "edit" && <form action={editAction} onSubmit={onEdit} className="cm-comment-form">
      <input type="hidden" name="post" value={postId} /><input type="hidden" name="comment" value={comment.id} />
      <input type="hidden" name="version" value={comment.version} />
      <textarea name="body" required maxLength={COMMENT_MAX} rows={3} defaultValue={comment.body} aria-label="댓글 고치기" autoFocus />
      <div className="cm-comment-form-foot"><Message state={editState} /><button type="submit" disabled={editing}>저장</button></div>
    </form>}
  </div>;
}
