"use client";

import { useActionState } from "react";

import { createStreamerAction, updateStreamerAction } from "@/app/admin/actions";
import { IDLE } from "@/lib/action-state";
import type { StreamerRow } from "@soop-lol/core/lib/db/types";

import { ActionMessage, CheckField, Field, SelectField, SubmitButton } from "./Field";

export function StreamerCreateForm() {
  const [state, action] = useActionState(createStreamerAction, IDLE);
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2">
      <Field label="스트리머 이름 *" name="display_name" placeholder="표시될 이름" required />
      <Field
        label="SOOP 아이디"
        name="platform_user_id"
        placeholder="예: bjexample"
        hint="채널 주소의 영문 아이디. slug 기본값으로도 쓰입니다."
      />
      <Field label="slug" name="slug" placeholder="비우면 SOOP 아이디를 씁니다" hint="/s/{slug} 주소가 됩니다." />
      <Field label="별명 (쉼표로 구분)" name="aliases" placeholder="구닉, 별명" hint="검색에 걸리게 할 이름들." />
      <div className="sm:col-span-2">
        <Field label="메모" name="note" placeholder="내부 메모" />
      </div>
      <div className="flex items-center gap-4 sm:col-span-2">
        <CheckField label="프로게이머 출신" name="is_pro" />
        <SubmitButton>스트리머 등록</SubmitButton>
        <ActionMessage state={state} />
      </div>
    </form>
  );
}

export function StreamerEditForm({ streamer }: { streamer: StreamerRow }) {
  const [state, action] = useActionState(updateStreamerAction, IDLE);
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2">
      <input type="hidden" name="id" value={streamer.id} />
      <Field label="스트리머 이름" name="display_name" defaultValue={streamer.display_name} required />
      <Field label="SOOP 아이디" name="platform_user_id" defaultValue={streamer.platform_user_id ?? ""} />
      <Field label="채널 URL" name="channel_url" defaultValue={streamer.channel_url ?? ""} />
      <Field label="소속 팀" name="team_name" defaultValue={streamer.team_name ?? ""} />
      <Field label="별명 (쉼표로 구분)" name="aliases" defaultValue={streamer.aliases.join(", ")} />
      <SelectField
        label="공개 여부"
        name="visibility"
        defaultValue={streamer.visibility}
        options={[
          { value: "public", label: "공개" },
          { value: "hidden", label: "숨김 (본인 요청 등)" },
        ]}
        hint="본인이 원하지 않으면 즉시 숨깁니다."
      />
      <div className="sm:col-span-2">
        <Field label="메모" name="note" defaultValue={streamer.note ?? ""} />
      </div>
      <div className="flex items-center gap-4 sm:col-span-2">
        <CheckField label="프로게이머 출신" name="is_pro" defaultChecked={streamer.is_pro} />
        <SubmitButton>저장</SubmitButton>
        <ActionMessage state={state} />
      </div>
    </form>
  );
}
