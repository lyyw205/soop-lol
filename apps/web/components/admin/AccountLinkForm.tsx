"use client";

import { useActionState, useState } from "react";
import type { StreamerAccountView } from "@soop-lol/core/lib/db/types";
import { PersonPicker } from "./PersonPicker";

import { linkAccountAction } from "@/app/admin/actions";
import { IDLE } from "@/lib/action-state";

import { ActionMessage, CheckField, Field, SelectField, SubmitButton } from "./Field";

/**
 * 계정 연결 폼.
 *
 * ★ 근거 입력이 **선택이 아니라 필수**다. 부계정 오노출은 실제 분쟁이 되므로
 *   "본인이 공개적으로 밝힌 계정만" 원칙을 UI 단계에서 강제한다.
 *   (docs/PLAN.md §11-2, docs/RESEARCH.md §6)
 */
export function AccountLinkForm({ streamerId = "", hasKey, candidate, people = [], account }: {
  streamerId?: string; hasKey: boolean;
  candidate?: { id: string; puuid: string; game_name: string | null; tag_line: string | null };
  people?: { id: string; slug: string; display_name: string }[];
  account?: StreamerAccountView;
}) {
  const [state, action] = useActionState(linkAccountAction, IDLE);
  const [person, setPerson] = useState("");

  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2">
      <input type="hidden" name="streamer_id" value={streamerId || people.find(p => p.slug === person)?.id || ""} />
      {account && <input type="hidden" name="account_mode" value="edit" />}
      {candidate && <><input type="hidden" name="candidate_id" value={candidate.id} />
        <div className="sm:col-span-2"><PersonPicker name="streamer_choice" people={people} value={person} onChange={setPerson} required /></div></>}

      <Field
        label={candidate || account ? "Riot ID" : hasKey ? "Riot ID *" : "Riot ID (조회 키 필요)"}
        name="riot_id"
        defaultValue={candidate?.game_name ? `${candidate.game_name}#${candidate.tag_line ?? ""}` : account?.game_name ? `${account.game_name}#${account.tag_line ?? ""}` : ""}
        placeholder="닉네임#KR1"
        disabled={!hasKey}
        readOnly={!!candidate || !!account}
        hint={!candidate && !account && hasKey ? "입력하면 Riot API로 계정을 조회합니다." : undefined}
      />
      <Field
        label={candidate || account ? "계정 식별자" : hasKey ? "puuid (직접 입력, 선택)" : "puuid *"}
        name="puuid"
        defaultValue={candidate?.puuid ?? account?.puuid ?? ""}
        readOnly={!!candidate || !!account}
        placeholder="78자 puuid"
        hint={
          candidate || account ? undefined : hasKey
            ? "Riot ID 대신 puuid 를 알면 이쪽에 넣어도 됩니다."
            : "RIOT_API_KEY 가 없어 Riot ID 조회가 안 됩니다. puuid 를 직접 넣으세요."
        }
      />

      <Field label="계정 라벨" name="label" placeholder="본계 / 부계1 / 섭계" defaultValue={account?.label ?? ""} />
      <SelectField
        label="신뢰도"
        name="confidence"
        defaultValue={account?.confidence ?? "likely"}
        options={[
          { value: "verified", label: "확인됨 — 본인이 직접 밝힘" },
          { value: "likely", label: "추정 — 정황상 거의 확실" },
          { value: "unverified", label: "미확인 — 제보만 있음" },
        ]}
        hint="화면에 그대로 노출됩니다. 확신 없으면 낮게 잡으세요."
      />

      <SelectField
        label="근거 종류"
        name="evidence_source"
        defaultValue={account?.evidence?.source ?? "broadcast_notice"}
        options={[
          { value: "stream_clip", label: "방송 클립" },
          { value: "broadcast_notice", label: "방송 공지" },
          { value: "self_declared", label: "본인 언급" },
          { value: "community_post", label: "커뮤니티 글" },
          { value: "user_report", label: "유저 제보" },
          { value: "manual", label: "기타 (메모 참조)" },
        ]}
      />
      <Field label="근거 URL" name="evidence_url" placeholder="https://…" defaultValue={account?.evidence?.url ?? ""} />

      <div className="sm:col-span-2">
        <Field
          label="근거 메모"
          name="evidence_note"
          defaultValue={account?.evidence?.note ?? ""}
          placeholder="예: 2026-08-01 방송에서 본인이 화면에 띄움"
          hint="URL 과 메모 중 최소 하나는 반드시 필요합니다. 근거 없는 매핑은 등록되지 않습니다."
        />
      </div>

      <div className="flex items-center gap-4 sm:col-span-2">
        <CheckField label="대표 계정으로 지정" name="is_main" defaultChecked={account?.is_main} />
        <SubmitButton>{account ? "계정 정보 저장" : "계정 연결"}</SubmitButton>
        <ActionMessage state={state} />
      </div>
    </form>
  );
}
