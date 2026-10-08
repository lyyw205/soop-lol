"use client";

/**
 * 커뮤니티 운영 폼. 처리가 거부돼도(상태 전이 불가·사유 누락) 입력값을 잃지 않는다. 판단은 서버(core community-admin.ts)가 한다.
 */

import { useActionState } from "react";

import {
  COMMUNITY_GAME_LABEL, MODERATION_ACTION_LABEL, type ModerationAction,
} from "@soop-lol/core/lib/metrics/community";

import { liftSanctionAction, moderateAction, noticeAction, sanctionAction } from "@/app/admin/community/actions";
import { IDLE } from "@/lib/action-state";

import { ActionMessage, SubmitButton } from "./Field";

const input = "rounded-lg border border-ink-700 bg-ink-950 px-2.5 py-1.5 text-sm text-ink-200 outline-none focus:border-accent-600";

export function ModerateForm({ kind, targetId, actions }: { kind: "post" | "comment"; targetId: number; actions: ModerationAction[] }) {
  const [state, action] = useActionState(moderateAction, IDLE);
  return <form action={action} className="mt-3 flex flex-wrap items-center gap-2">
    <input type="hidden" name="kind" value={kind} />
    <input type="hidden" name="target" value={targetId} />
    <select name="action" className={input} aria-label="처리" defaultValue={actions[0]}>
      {actions.map((a) => <option key={a} value={a}>{MODERATION_ACTION_LABEL[a]}</option>)}
    </select>
    <input name="reason" required className={`${input} min-w-64 flex-1`} placeholder="처리 사유(기록에 남습니다)" aria-label="처리 사유" />
    <SubmitButton tone="ghost">처리</SubmitButton>
    <ActionMessage state={state} />
  </form>;
}

export function SanctionForm({ memberId }: { memberId: string }) {
  const [state, action] = useActionState(sanctionAction, IDLE);
  return <form action={action} className="mt-3 flex flex-wrap items-center gap-2">
    <input type="hidden" name="member" value={memberId} />
    <select name="days" className={input} aria-label="제한 기간" defaultValue="1">
      <option value="1">1일</option><option value="7">7일</option><option value="30">30일</option><option value="permanent">영구</option>
    </select>
    <input name="reason" required className={`${input} min-w-64 flex-1`} placeholder="제한 사유(회원에게 그대로 보입니다)" aria-label="제한 사유" />
    <SubmitButton tone="danger">글쓰기 제한</SubmitButton>
    <ActionMessage state={state} />
  </form>;
}

export function LiftSanctionForm({ sanctionId }: { sanctionId: number }) {
  const [state, action] = useActionState(liftSanctionAction, IDLE);
  return <form action={action} className="inline-flex items-center gap-2">
    <input type="hidden" name="sanction" value={sanctionId} />
    <SubmitButton tone="ghost">풀기</SubmitButton>
    <ActionMessage state={state} />
  </form>;
}

export function NoticeForm() {
  const [state, action] = useActionState(noticeAction, IDLE);
  return <form action={action} className="grid gap-2">
    <div className="flex flex-wrap gap-2">
      <select name="game" className={input} aria-label="게임" defaultValue="">
        <option value="">공통(모든 게임 필터에 보임)</option>
        {Object.entries(COMMUNITY_GAME_LABEL).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select>
      <input name="title" required maxLength={100} className={`${input} min-w-64 flex-1`} placeholder="공지 제목" aria-label="공지 제목" />
    </div>
    <textarea name="body" required rows={4} className={input} placeholder="공지 본문(일반 텍스트)" aria-label="공지 본문" />
    <div className="flex items-center gap-3"><SubmitButton>공지 올리기</SubmitButton><ActionMessage state={state} /></div>
  </form>;
}
