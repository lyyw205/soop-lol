"use client";

import { useActionState } from "react";
import { setReviewCompletedAction } from "@/app/admin/ck/actions";
import { IDLE } from "@/lib/action-state";
import { ActionMessage } from "./Field";

export function ReviewCompletion({ matchId, version, completed, disabled = false, statusButton = false, primary = false, onCompleted }: {
  onCompleted?: () => void;
  matchId: string; version: number; completed: boolean; disabled?: boolean; statusButton?: boolean;
  /** 경기 검수 화면 위 줄의 큰 버튼 — 완료하면 다음 경기로 간다. */
  primary?: boolean;
}) {
  const [state, action, pending] = useActionState(async (prev: typeof IDLE, form: FormData) => {
    const result = await setReviewCompletedAction(prev, form); if (result.ok && !completed) onCompleted?.(); return result;
  }, IDLE);
  return <form action={action} className={statusButton ? "ck-review-completion" : "flex flex-wrap items-center gap-2"} data-review-completion>
    <input type="hidden" name="match_id" value={matchId} />
    <input type="hidden" name="version" value={version} />
    <input type="hidden" name="completed" value={completed ? "0" : "1"} />
    {!statusButton && !primary && <span className={`text-xs ${completed ? "text-win" : "text-ink-400"}`}>{completed ? "검수 완료" : "미검수"}</span>}
    <button type="submit" disabled={disabled || pending} aria-label={completed ? "미검수로 변경" : "검수 완료로 표시"}
      className={primary ? `ck-review-complete-primary ${completed ? "is-complete" : ""}` : statusButton
        ? `ck-review-completion-button rounded border px-2 py-1 text-xs hover:border-accent-400 disabled:opacity-50 ${completed ? "is-complete" : "is-pending"}`
        : "rounded border border-ink-700 px-2 py-1 text-xs text-ink-200 hover:border-accent-400 disabled:opacity-50"}>
      {pending ? "저장 중" : primary ? (completed ? "완료 취소" : "검수 완료 · 다음 →") : statusButton ? (completed ? "검수 완료" : "미검수") : (completed ? "완료 취소" : "검수 완료")}
    </button>
    {!state.ok && <ActionMessage state={state} />}
  </form>;
}
