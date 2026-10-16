"use client";

/** 제보 처리 폼. 거부돼도(충돌·이미 처리됨) 입력값을 잃지 않는다. 판단은 core submission.ts 가 한다. */

import { duplicateSubmissionAction, rejectSubmissionAction, verifySubmissionAction } from "@/app/admin/submissions/actions";
import { IDLE } from "@/lib/action-state";

import { useKeptFormAction } from "../../../../packages/ui/use-kept-form-action";

import { ActionMessage, SubmitButton } from "./Field";

const input = "rounded-lg border border-ink-700 bg-ink-950 px-2.5 py-1.5 text-sm text-ink-200 outline-none focus:border-accent-600";

export function DecideSubmissionForm({ id, held, duplicateOptions }: { id: string; held: boolean; duplicateOptions: { id: string; label: string }[] }) {
  const verify = useKeptFormAction(verifySubmissionAction, IDLE);
  const reject = useKeptFormAction(rejectSubmissionAction, IDLE, { confirm: held ? undefined : "이 제보가 바꾼 값을 되돌립니다. 계속할까요?" });
  const dup = useKeptFormAction(duplicateSubmissionAction, IDLE);
  return <div className="grid gap-3">
    <form action={verify.dispatch} onSubmit={verify.onSubmit} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="id" value={id} />
      <input name="note" className={`${input} min-w-64 flex-1`} placeholder="메모(선택 — 회원에게 보입니다)" aria-label="확인 메모" />
      <SubmitButton>{held ? "확인하고 반영" : "확인(표시 떼기)"}</SubmitButton>
      <ActionMessage state={verify.state} />
    </form>
    <form action={reject.dispatch} onSubmit={reject.onSubmit} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="id" value={id} />
      <input name="note" className={`${input} min-w-64 flex-1`} placeholder="반려 사유(선택 — 회원에게 보입니다)" aria-label="반려 사유" />
      <SubmitButton tone="ghost">{held ? "반려" : "반려(되돌리기)"}</SubmitButton>
      <ActionMessage state={reject.state} />
    </form>
    {held && duplicateOptions.length > 0 && <form action={dup.dispatch} onSubmit={dup.onSubmit} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="id" value={id} />
      <select name="of" className={input} aria-label="합칠 제보">{duplicateOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select>
      <SubmitButton tone="ghost">중복으로 합치기</SubmitButton>
      <ActionMessage state={dup.state} />
    </form>}
  </div>;
}
