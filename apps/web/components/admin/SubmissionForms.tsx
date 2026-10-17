"use client";

/** 제보 처리 폼. 거부돼도(충돌·이미 처리됨) 입력값을 잃지 않는다. 판단은 core submission.ts 가 한다. */

import {
  cancelVodRequestAction, duplicateSubmissionAction, rejectSubmissionAction, requestVodAction, verifySubmissionAction,
} from "@/app/admin/submissions/actions";
import { IDLE } from "@/lib/action-state";

import { useKeptFormAction } from "../../../../packages/ui/use-kept-form-action";

import { ActionMessage, SubmitButton } from "./Field";

const input = "rounded-lg border border-ink-700 bg-ink-950 px-2.5 py-1.5 text-sm text-ink-200 outline-none focus:border-accent-600";

export function DecideSubmissionForm({ id, held, schedule = false, duplicateOptions }: { id: string; held: boolean; schedule?: boolean; duplicateOptions: { id: string; label: string }[] }) {
  const verify = useKeptFormAction(verifySubmissionAction, IDLE);
  const reject = useKeptFormAction(rejectSubmissionAction, IDLE, { confirm: held ? undefined : "이 제보가 바꾼 값을 되돌립니다. 계속할까요?" });
  const dup = useKeptFormAction(duplicateSubmissionAction, IDLE);
  return <div className="grid gap-3">
    <form action={verify.dispatch} onSubmit={verify.onSubmit} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="id" value={id} />
      <input name="note" className={`${input} min-w-64 flex-1`} placeholder="메모(선택 — 회원에게 보입니다)" aria-label="확인 메모" />
      {/* 편성표 제보의 반영은 편성표 편집 저장이 한다 — 여기 확인은 반영 없이 닫기(이미 고쳤거나 고칠 것이 없다). */}
      <SubmitButton>{schedule ? "반영 없이 확인" : held ? "확인하고 반영" : "확인(표시 떼기)"}</SubmitButton>
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

/** VOD 판독 요청 — 링크나 번호. 판단(번호 읽기·중복)은 core vod-request.ts. */
export function RequestVodForm() {
  const { state, dispatch, onSubmit } = useKeptFormAction(requestVodAction, IDLE);
  return <form action={dispatch} onSubmit={onSubmit} className="flex flex-wrap items-center gap-2">
    <input name="vod" required className={`${input} min-w-64 flex-1`} placeholder="SOOP VOD 링크 또는 번호" aria-label="VOD 링크" />
    <input name="note" maxLength={500} className={`${input} min-w-64 flex-1`} placeholder="메모(선택 — 판독 세션에 넘깁니다)" aria-label="요청 메모" />
    <SubmitButton>판독 요청</SubmitButton>
    <ActionMessage state={state} />
  </form>;
}

export function CancelVodRequestForm({ id }: { id: number }) {
  const { state, dispatch, onSubmit } = useKeptFormAction(cancelVodRequestAction, IDLE);
  return <form action={dispatch} onSubmit={onSubmit} className="inline-flex items-center gap-2">
    <input type="hidden" name="id" value={id} />
    <SubmitButton tone="ghost">거두기</SubmitButton>
    <ActionMessage state={state} />
  </form>;
}
