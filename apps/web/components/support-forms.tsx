"use client";
import { useKeptFormAction } from "../../../packages/ui/use-kept-form-action";
import { IDLE } from "@/lib/action-state";
import { submitSupport } from "@/app/support/actions";
import { answerSupport } from "@/app/admin/support/actions";
export function SupportForm({ id }: { id?: string }) {
  const { state, dispatch, pending, onSubmit } = useKeptFormAction(id ? answerSupport : submitSupport, IDLE);
  return <form action={dispatch} onSubmit={onSubmit} className="support-form">
    {id ? <input type="hidden" name="id" value={id} /> : <>
      <label>유형<select name="kind"><option value="inquiry">문의</option><option value="suggestion">건의</option></select></label>
      <label>제목<input name="title" maxLength={100} required /></label>
    </>}
    <label>{id ? "답변" : "내용"}<textarea name={id ? "reply" : "body"} rows={7} maxLength={5000} required aria-describedby="support-help" /></label>
    <p id="support-help" className="support-muted">{id ? "답변은 작성자에게만 표시됩니다." : "최대 5,000자 · 비밀번호나 연락처 등 민감한 정보는 적지 마세요."}</p>
    {state.message && <p role={state.ok ? "status" : "alert"}>{state.message}</p>}
    <button disabled={pending || (state.ok && !!state.message)}>{pending ? "저장 중…" : id ? "답변 등록" : "비공개로 접수하기"}</button>
  </form>;
}
