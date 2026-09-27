"use client";

import { useActionState } from "react";
import { setReviewCompletedAction } from "@/app/admin/ck/actions";
import { IDLE } from "@/lib/action-state";
import { ActionMessage } from "./Field";

export function ReviewCompletion({ matchId, version, completed, disabled = false, statusButton = false }: {
  matchId: string; version: number; completed: boolean; disabled?: boolean; statusButton?: boolean;
}) {
  const [state, action, pending] = useActionState(setReviewCompletedAction, IDLE);
  return <form action={action} className={statusButton ? "ck-review-completion" : "flex flex-wrap items-center gap-2"} data-review-completion>
    <input type="hidden" name="match_id" value={matchId} />
    <input type="hidden" name="version" value={version} />
    <input type="hidden" name="completed" value={completed ? "0" : "1"} />
    {!statusButton && <span className={`text-xs ${completed ? "text-win" : "text-ink-400"}`}>{completed ? "검수 완료" : "미검수"}</span>}
    <button type="submit" disabled={disabled || pending} aria-label={completed ? "미검수로 변경" : "검수 완료로 표시"}
      className={statusButton
        ? `ck-review-completion-button rounded border px-2 py-1 text-xs hover:border-accent-400 disabled:opacity-50 ${completed ? "is-complete" : "is-pending"}`
        : "rounded border border-ink-700 px-2 py-1 text-xs text-ink-200 hover:border-accent-400 disabled:opacity-50"}>
      {pending ? "저장 중" : statusButton ? (completed ? "검수 완료" : "미검수") : (completed ? "완료 취소" : "검수 완료")}
    </button>
    {!state.ok && <ActionMessage state={state} />}
  </form>;
}
