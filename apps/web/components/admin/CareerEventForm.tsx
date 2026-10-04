"use client";

import type { CareerEventRow } from "@soop-lol/core/lib/db/types";
import { useActionState } from "react";

import { addCareerEventAction } from "@/app/admin/actions";
import { IDLE } from "@/lib/action-state";

import { ActionMessage, Field, SubmitButton } from "./Field";

/**
 * 커리어는 Riot API 에 없다 — 100% 수기다 (docs/RESEARCH.md §3-3).
 * 그래서 화면에서도 '수기' 로 표시해 관측 데이터와 구분한다.
 */
export function CareerEventForm({ streamerId, career }: { streamerId: string; career?: CareerEventRow }) {
  const [state, action] = useActionState(addCareerEventAction, IDLE);
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2">
      <input type="hidden" name="streamer_id" value={streamerId} />
      {career && <><input type="hidden" name="career_id" value={career.id} /><input type="hidden" name="version" value={career.admin_version} /></>}
      <Field label="대회/활동 이름 *" name="title" defaultValue={career?.title ?? ""} placeholder="2026 SOOP 멸망전" required />
      <Field label="성적" name="placement" defaultValue={career?.placement ?? ""} placeholder="준우승 / 4강 / 조별탈락" />
      <Field label="역할" name="role" defaultValue={career?.role ?? ""} placeholder="선수 / 감독 / 해설" />
      <Field label="팀" name="team_name" defaultValue={career?.team_name ?? ""} placeholder="팀 이름" />
      <Field label="시작일" name="date_from" defaultValue={career?.date_from ?? ""} type="date" />
      <Field label="종료일" name="date_to" defaultValue={career?.date_to ?? ""} type="date" />
      <div className="sm:col-span-2">
        <Field label="출처 URL" name="source_url" defaultValue={career?.source_url ?? ""} placeholder="https://…" hint="나중에 근거를 되짚을 수 있게 남겨주세요." />
      </div>
      <div className="flex items-center gap-4 sm:col-span-2">
        <SubmitButton>{career ? "커리어 저장" : "커리어 추가"}</SubmitButton>
        <ActionMessage state={state} />
      </div>
    </form>
  );
}
