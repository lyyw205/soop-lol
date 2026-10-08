"use client";

/**
 * 내 정보 화면의 폼. 저장이 거부돼도(닉네임 규칙·동의 누락) 입력값을 잃지 않는다 — 판단은 서버(core member.ts)가 한다.
 */

import Link from "next/link";

import { PURGE_AFTER_DAYS, REJOIN_COOLDOWN_DAYS } from "@soop-lol/core/lib/metrics/community";
import { NICKNAME_MAX, NICKNAME_MIN } from "@soop-lol/core/lib/metrics/nickname";
import { policyHref, privacyHref, termsHref } from "@soop-lol/core/lib/site-paths";

import { changeNicknameAction, completeSignupAction, withdrawAction } from "@/app/me/actions";
import { IDLE, type ActionState } from "@/lib/action-state";

import { useKeptFormAction } from "../../../packages/ui/use-kept-form-action";

function Message({ state }: { state: ActionState }) {
  if (!state.message) return null;
  return <p className={state.ok ? "member-ok" : "member-alert"} role={state.ok ? "status" : "alert"}>{state.message}</p>;
}

function NicknameInput({ defaultValue }: { defaultValue?: string }) {
  return <label className="member-field">
    <span>닉네임 <small>{NICKNAME_MIN}~{NICKNAME_MAX}자 · 스트리머 이름·운영진처럼 보이는 이름은 쓸 수 없습니다</small></span>
    <input name="nickname" required minLength={NICKNAME_MIN} maxLength={NICKNAME_MAX * 2} defaultValue={defaultValue} autoComplete="nickname" />
  </label>;
}

export function SignupForm({ next }: { next: string }) {
  const { state, dispatch: action, pending, onSubmit } = useKeptFormAction(completeSignupAction, IDLE);
  return <form action={action} onSubmit={onSubmit} className="member-form">
    <input type="hidden" name="next" value={next} />
    <NicknameInput />
    <label className="member-check">
      <input type="checkbox" name="agree" required />
      <span>
        <Link href={termsHref()} target="_blank">이용약관</Link>·<Link href={privacyHref()} target="_blank">개인정보처리방침</Link>·<Link href={policyHref()} target="_blank">운영정책</Link>에
        동의하며 만 14세 이상입니다.
      </span>
    </label>
    <Message state={state} />
    <button type="submit" className="member-primary" disabled={pending}>가입 마치기</button>
  </form>;
}

export function NicknameForm({ current }: { current: string }) {
  const { state, dispatch: action, pending, onSubmit } = useKeptFormAction(changeNicknameAction, IDLE);
  return <form action={action} onSubmit={onSubmit} className="member-form">
    <NicknameInput defaultValue={current} />
    <Message state={state} />
    <button type="submit" className="member-secondary" disabled={pending}>닉네임 바꾸기</button>
  </form>;
}

export function WithdrawForm() {
  const { state, dispatch: action, pending, onSubmit } = useKeptFormAction(withdrawAction, IDLE);
  return <form action={action} onSubmit={onSubmit} className="member-form">
    <p className="member-muted">
      탈퇴하면 닉네임이 지워지고 쓴 글·댓글은 &lsquo;탈퇴한 회원&rsquo; 으로 남습니다. 같은 소셜 계정으로는 {REJOIN_COOLDOWN_DAYS}일 동안(제재 중이면 제재가 끝날 때까지) 다시 가입할 수 없습니다.
    </p>
    <label className="member-check">
      <input type="checkbox" name="deleteContent" />
      <span>내 글·댓글도 지우기(공개에서 바로 빠지고 {PURGE_AFTER_DAYS}일 뒤 파기됩니다)</span>
    </label>
    <label className="member-field">
      <span>확인을 위해 &lsquo;탈퇴&rsquo; 를 적어 주세요</span>
      <input name="confirm" required autoComplete="off" />
    </label>
    <Message state={state} />
    <button type="submit" className="member-danger" disabled={pending}>탈퇴하기</button>
  </form>;
}
