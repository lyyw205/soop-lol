"use client";

/**
 * 편성표 입력 폼. 본문·방송 칸·참가자·출처를 한 화면에서 고치고 **한 번에** 저장한다.
 *
 * ★ 값은 React 상태에 두고, 저장할 때 hidden input 하나(payload)에 JSON 으로 담는다.
 *   저장이 거부돼도(검증·동시 수정) 컴포넌트가 그대로라 입력값을 잃지 않는다.
 * ★ 검증은 서버(core 의 saveScheduleEntry)가 한다. 여기선 입력을 돕기만 한다.
 */

import { useActionState, useState } from "react";

import {
  SCHEDULE_GAME_LABEL, SCHEDULE_KIND_LABEL, SCHEDULE_ROLE_LABEL, SCHEDULE_SCALE_LABEL,
  addDays, type ScheduleGame,
} from "@soop-lol/core/lib/metrics/schedule";

import { deleteScheduleAction, saveScheduleAction, type ScheduleFormPayload } from "@/app/admin/schedule/actions";
import { IDLE } from "@/lib/action-state";

import { ActionMessage, SubmitButton } from "./Field";

const input = "w-full rounded-lg border border-ink-700 bg-ink-950 px-2.5 py-1.5 text-sm text-ink-200 outline-none focus:border-accent-600";
const label = "mb-1 block text-xs text-ink-400";

type Slot = ScheduleFormPayload["slots"][number];
type Person = ScheduleFormPayload["participants"][number];
type Source = ScheduleFormPayload["sources"][number];

export interface ScheduleEventChoice { id: string; name: string; kind: string; date: string | null }

export function ScheduleForm({ initial, streamers, events }: {
  initial: ScheduleFormPayload;
  streamers: { slug: string; display_name: string }[];
  events: Record<ScheduleGame, ScheduleEventChoice[]>;
}) {
  const [state, action] = useActionState(saveScheduleAction, IDLE);
  const [v, setV] = useState(initial);
  const set = <K extends keyof ScheduleFormPayload>(k: K, value: ScheduleFormPayload[K]) => setV((p) => ({ ...p, [k]: value }));
  const setRow = <K extends "slots" | "participants" | "sources">(k: K, i: number, patch: Partial<ScheduleFormPayload[K][number]>) =>
    setV((p) => ({ ...p, [k]: p[k].map((row, j) => (j === i ? { ...row, ...patch } : row)) }));
  const addRow = <K extends "slots" | "participants" | "sources">(k: K, row: ScheduleFormPayload[K][number]) =>
    setV((p) => ({ ...p, [k]: [...p[k], row] }));
  const dropRow = (k: "slots" | "participants" | "sources", i: number) => setV((p) => ({ ...p, [k]: p[k].filter((_, j) => j !== i) }));
  const [repeat, setRepeat] = useState(3);

  /** 마지막 칸과 같은 시각으로 다음 날부터 N일 — 조별 리그처럼 매일 같은 시각의 대회용. */
  function repeatLast() {
    const last = v.slots[v.slots.length - 1];
    if (!last?.on_date) return;
    setV((p) => ({ ...p, slots: [...p.slots, ...Array.from({ length: repeat }, (_, i) => ({ ...last, label: "", on_date: addDays(last.on_date, i + 1) }))] }));
  }

  const gameEvents = events[v.game_code as ScheduleGame] ?? [];

  return (
    <form action={action} className="space-y-6">
      <input type="hidden" name="payload" value={JSON.stringify(v)} />

      <section className="grid gap-3 sm:grid-cols-4">
        <label className="sm:col-span-2"><span className={label}>제목 *</span>
          <input className={input} value={v.title} onChange={(e) => set("title", e.target.value)} required /></label>
        <label><span className={label}>게임</span>
          <select className={input} value={v.game_code} onChange={(e) => setV((p) => ({ ...p, game_code: e.target.value, event_id: "" }))}>
            {Object.entries(SCHEDULE_GAME_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select></label>
        <label><span className={label}>규모</span>
          <select className={input} value={v.scale} onChange={(e) => set("scale", e.target.value)}>
            {Object.entries(SCHEDULE_SCALE_LABEL).map(([k, l]) => <option key={k} value={k}>{l} {k === "major" ? "(여러 날·확정 편성)" : "(하루·예고)"}</option>)}
          </select></label>
        <label><span className={label}>분류(공지 기준)</span>
          <select className={input} value={v.planned_kind} onChange={(e) => set("planned_kind", e.target.value)}>
            {Object.entries(SCHEDULE_KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select></label>
        <label><span className={label}>후원</span>
          <input className={input} value={v.sponsor} onChange={(e) => set("sponsor", e.target.value)} /></label>
        <label><span className={label}>공개 여부</span>
          <select className={input} value={v.visibility} onChange={(e) => set("visibility", e.target.value)}>
            <option value="public">공개 (출처 1개 이상 필요)</option><option value="hidden">숨김</option>
          </select></label>
        <label><span className={label}>상태</span>
          <select className={input} value={v.status} onChange={(e) => setV((p) => ({ ...p, status: e.target.value, event_id: e.target.value === "held" ? p.event_id : "" }))}>
            <option value="scheduled">예정 (개최 미확인)</option><option value="held">개최 확인</option><option value="cancelled">무산</option>
          </select></label>
        <label className="sm:col-span-2"><span className={label}>공개 설명</span>
          <textarea className={input} rows={2} value={v.description} onChange={(e) => set("description", e.target.value)} placeholder="미등록 참가자도 여기 적습니다" /></label>
        <label className="sm:col-span-2"><span className={label}>관리자 메모 (공개 안 됨)</span>
          <textarea className={input} rows={2} value={v.admin_note} onChange={(e) => set("admin_note", e.target.value)} /></label>
        <label className="sm:col-span-4"><span className={label}>결과 경기 연결 (개최 확인일 때만 · 같은 게임의 대회만)</span>
          <select className={input} value={v.event_id} disabled={v.status !== "held"} onChange={(e) => set("event_id", e.target.value)}>
            <option value="">연결 안 함</option>
            {gameEvents.map((ev) => <option key={ev.id} value={ev.id}>{ev.date ?? "날짜 없음"} · {ev.name} ({ev.kind})</option>)}
          </select></label>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold">방송 칸 * <small className="font-normal text-ink-400">끝 시각이 시작보다 이르면 다음 날로 봅니다(밤샘 방송). 시각을 모르면 비워 둡니다.</small></h3>
        <div className="space-y-2">
          {v.slots.map((s: Slot, i) => <div key={i} className="grid grid-cols-2 gap-2 sm:grid-cols-[150px_100px_100px_1fr_1fr_auto]">
            <input aria-label="날짜" type="date" className={input} value={s.on_date} onChange={(e) => setRow("slots", i, { on_date: e.target.value })} required />
            <input aria-label="시작" type="time" className={input} value={s.start} onChange={(e) => setRow("slots", i, { start: e.target.value })} />
            <input aria-label="끝" type="time" className={input} value={s.end} onChange={(e) => setRow("slots", i, { end: e.target.value })} />
            <input aria-label="단계" className={input} placeholder="단계 (조별 1일차 등)" value={s.label} onChange={(e) => setRow("slots", i, { label: e.target.value })} />
            <input aria-label="중계 채널" className={input} placeholder="중계 SOOP 아이디 (비우면 주최 채널)" value={s.channel_id} onChange={(e) => setRow("slots", i, { channel_id: e.target.value })} />
            <button type="button" className="text-xs text-ink-400 hover:text-lose" onClick={() => dropRow("slots", i)}>삭제</button>
          </div>)}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <button type="button" className="rounded border border-ink-700 px-2 py-1" onClick={() => addRow("slots", { label: "", on_date: "", start: "", end: "", channel_id: "" })}>칸 추가</button>
          <span className="text-ink-400">마지막 칸과 같은 시각으로 다음 날부터</span>
          <input aria-label="반복 일수" type="number" min={1} max={30} className={`${input} w-16`} value={repeat} onChange={(e) => setRepeat(Number(e.target.value) || 1)} />
          <button type="button" className="rounded border border-ink-700 px-2 py-1" onClick={repeatLast}>일 추가</button>
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold">참가자 <small className="font-normal text-ink-400">등록 스트리머만 연결합니다(slug).</small></h3>
        <datalist id="schedule-streamers">{streamers.map((s) => <option key={s.slug} value={s.slug}>{s.display_name}</option>)}</datalist>
        <div className="space-y-2">
          {v.participants.map((p: Person, i) => <div key={i} className="grid grid-cols-[1fr_110px_1fr_auto] gap-2">
            <input aria-label="스트리머 slug" list="schedule-streamers" className={input} placeholder="slug" value={p.slug} onChange={(e) => setRow("participants", i, { slug: e.target.value })} />
            <select aria-label="역할" className={input} value={p.role} onChange={(e) => setRow("participants", i, { role: e.target.value })}>
              {Object.entries(SCHEDULE_ROLE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            <input aria-label="팀" className={input} placeholder="팀 (선택)" value={p.team} onChange={(e) => setRow("participants", i, { team: e.target.value })} />
            <button type="button" className="text-xs text-ink-400 hover:text-lose" onClick={() => dropRow("participants", i)}>삭제</button>
          </div>)}
        </div>
        <button type="button" className="mt-2 rounded border border-ink-700 px-2 py-1 text-xs" onClick={() => addRow("participants", { slug: "", role: "player", team: "" })}>참가자 추가</button>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold">근거 공지 <small className="font-normal text-ink-400">공개하려면 1개 이상. 공지가 여러 개면 모두 붙입니다.</small></h3>
        <div className="space-y-2">
          {v.sources.map((s: Source, i) => <div key={i} className="grid grid-cols-1 gap-2 sm:grid-cols-[2fr_1fr_190px_auto]">
            <input aria-label="공지 주소" className={input} placeholder="https://…" value={s.url} onChange={(e) => setRow("sources", i, { url: e.target.value })} />
            <input aria-label="공지 제목" className={input} placeholder="공지 제목" value={s.title} onChange={(e) => setRow("sources", i, { title: e.target.value })} />
            <input aria-label="공지 작성 시각" type="datetime-local" className={input} value={s.posted_at} onChange={(e) => setRow("sources", i, { posted_at: e.target.value })} />
            <button type="button" className="text-xs text-ink-400 hover:text-lose" onClick={() => dropRow("sources", i)}>삭제</button>
          </div>)}
        </div>
        <button type="button" className="mt-2 rounded border border-ink-700 px-2 py-1 text-xs" onClick={() => addRow("sources", { url: "", title: "", posted_at: "" })}>출처 추가</button>
      </section>

      <div className="flex flex-wrap items-center gap-4">
        {v.id && <label className="flex items-center gap-2 text-sm text-ink-200" title="처음 입력을 고친 것까지 공개 화면에 '일정 변경' 으로 보이면 거짓이다">
          <input type="checkbox" className="size-4 accent-accent-600" checked={v.typo} onChange={(e) => set("typo", e.target.checked)} />
          오타 수정 — 공개 변경 이력에 남기지 않음
        </label>}
        <SubmitButton>{v.id ? "저장" : "일정 등록"}</SubmitButton>
        <ActionMessage state={state} />
      </div>
    </form>
  );
}

export function ScheduleDeleteForm({ id, version }: { id: string; version: string }) {
  const [state, action] = useActionState(deleteScheduleAction, IDLE);
  return <form action={action} className="flex items-center gap-3" onSubmit={(e) => { if (!confirm("이 일정을 지울까요? 되돌릴 수 없습니다.")) e.preventDefault(); }}>
    <input type="hidden" name="id" value={id} /><input type="hidden" name="version" value={version} />
    <SubmitButton tone="danger">일정 삭제</SubmitButton>
    <ActionMessage state={state} />
  </form>;
}
