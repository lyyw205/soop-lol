"use client";

import { useActionState } from "react";

import { IDLE, type ActionState } from "@/lib/action-state";
import { addEvidenceAction } from "@/app/admin/fco/actions";

/**
 * 근거 추가 — 조사가 놓친 근거를 사람이 손으로 붙이는 자리.
 * ⚠ 판단(미해결·단순 친선)과 행사 연결은 **상단 토글**로 옮겼다. 자주 쓰는 조작이
 *   접힌 메뉴 안에 있으면 안 되고, 저장 경로가 두 벌이면 규칙이 어긋난다.
 * 저장은 CLI 와 같은 반영 함수를 지난다(⏭ 포함).
 */

const input = "w-full rounded border border-ink-700 bg-ink-900 px-2 py-1.5 text-sm text-ink-200";
const label = "block text-[11px] text-ink-400";

function Result({ state }: { state: ActionState }) {
  if (!state.message) return null;
  return (
    <p role="status" className={`text-xs ${state.ok ? "text-ink-400" : "text-red-400"}`}>
      {state.ok ? state.message : `✗ ${state.message}`}
    </p>
  );
}

export function FcoContextReviewer({ providerMatchId, version }: { providerMatchId: string; version: number }) {
  const [evidenced, evidence, evidencing] = useActionState(addEvidenceAction, IDLE);

  return (
    <form action={evidence} onReset={event => event.preventDefault()} className="grid gap-2">
      <input type="hidden" name="provider_match_id" value={providerMatchId} />
      <input type="hidden" name="context_version" value={version} />
      <div className="grid grid-cols-2 gap-2">
        <div>
          <span className={label}>종류</span>
          <select name="kind" className={input} defaultValue="vod_frame">
            <option value="vod_frame">화면</option>
            <option value="chat">채팅</option>
            <option value="audio">음성</option>
            <option value="notice">공지</option>
            <option value="url">외부 링크</option>
          </select>
        </div>
        <div>
          <span className={label}>채널 (선택)</span>
          <input name="channel_id" className={input} placeholder="phonics1" />
        </div>
        <div>
          <span className={label}>VOD 번호</span>
          <input name="vod_title_no" className={input} placeholder="207643193" />
        </div>
        <div>
          <span className={label}>전체 초</span>
          <input name="at_sec" className={input} placeholder="1479" />
        </div>
      </div>
      <div>
        <span className={label}>공지·외부 링크 URL</span>
        <input name="url" className={input} placeholder="https://pick.sooplive.com/…" />
      </div>
      <div>
        <span className={label}>관찰 내용 (필수)</span>
        <input name="observed" required className={input} placeholder="인게임 88:23, 교로텔리 3:4 호날두" />
      </div>
      <div>
        <span className={label}>판단 근거 (선택)</span>
        <input name="why" className={input} placeholder="matchDate 16초 전 88분 — 이 matchId 경기다" />
      </div>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={evidencing}
          className="rounded-md border border-accent-600/40 bg-accent-600/10 px-3 py-1.5 text-xs text-accent-400 hover:bg-accent-600/20">
          근거 저장
        </button>
        <Result state={evidenced} />
      </div>
    </form>
  );
}
