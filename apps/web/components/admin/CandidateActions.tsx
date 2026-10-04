"use client";
import { useActionState } from "react";
import { setCandidateStateAction } from "@/app/admin/actions";
import { IDLE } from "@/lib/action-state";
import { ActionMessage } from "./Field";

export function CandidateActions({ id, state }: { id: string; state: string }) {
  const [result, action, pending] = useActionState(setCandidateStateAction, IDLE);
  if (state === "approved") return null;
  return <form action={action} className="flex flex-wrap items-center gap-2">
    <input type="hidden" name="id" value={id} /><input type="hidden" name="expected_state" value={state} />
    {(state === "pending" ? [["ignored", "보류"], ["rejected", "대상 아님"]] : [["pending", "대기로 되돌리기"]]).map(([value, label]) =>
      <button key={value} name="state" value={value} disabled={pending} className="rounded border border-ink-700 px-2 py-1 text-xs text-ink-300 disabled:opacity-50">{pending ? "처리 중…" : label}</button>)}
    <ActionMessage state={result} />
  </form>;
}
