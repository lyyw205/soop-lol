"use client";
import { useActionState } from "react";
import { completeBatchAction } from "@/app/admin/review-actions";
import type { ReviewTarget } from "@soop-lol/core/lib/db/review-batch";
import { IDLE } from "@/lib/action-state";
export function BulkReviewCompletion({ game, targets, onDone, disabled = false }: { game: "lol" | "fconline"; targets: ReviewTarget[]; onDone: () => void; disabled?: boolean }) {
  const [state, action, pending] = useActionState(async (prev: typeof IDLE, form: FormData) => {
    const result = await completeBatchAction(prev, form); if (result.ok) onDone(); return result;
  }, IDLE);
  return <form action={action} className="my-2 flex flex-wrap items-center gap-2 text-xs" onSubmit={e => { if (!window.confirm(`직접 확인한 ${targets.length}경기를 완료하시겠습니까?`)) e.preventDefault(); }}>
    <input type="hidden" name="game" value={game} /><input type="hidden" name="targets" value={JSON.stringify(targets)} />
    <button type="submit" disabled={disabled || pending || !targets.length || targets.length > 50} className="rounded border border-accent-600 px-3 py-2 text-accent-400 disabled:opacity-40">{pending ? '처리 중…' : `선택한 ${targets.length}경기 완료`}</button>
    <span className="text-ink-400">직접 확인한 경기만 선택 · 최대 50개</span>
    {state.message && <p role={state.ok ? 'status' : 'alert'} className={state.ok ? 'text-ink-300' : 'text-red-400'}>{state.message}</p>}
  </form>;
}
