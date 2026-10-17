"use client";

import { useMemo, useState } from "react";

import type { CorrectionTarget } from "@soop-lol/core/lib/db/submission";
import {
  CORRECTION_POSITIONS, SCHEDULE_REPORT_STATUS_LABEL, SCHEDULE_REPORT_STATUSES, type MatchCorrection, type ScheduleReport,
} from "@soop-lol/core/lib/metrics/submission";
import { SCHEDULE_GAME_LABEL, SCHEDULE_GAMES } from "@soop-lol/core/lib/metrics/schedule";

import { useKeptFormAction } from "../../../packages/ui/use-kept-form-action";
import { IDLE } from "@/lib/action-state";
import { submitCorrectionAction, submitScheduleReportAction, supportAction } from "@/app/submit/actions";

type Slot = CorrectionTarget["slots"][number];
type Editable = Pick<Slot, "streamer_id" | "observed_name" | "champion_id" | "team_position" | "kills" | "deaths" | "assists">;
const FIELDS = ["streamer_id", "observed_name", "champion_id", "team_position", "kills", "deaths", "assists"] as const;
const POSITION_NAME: Record<string, string> = { TOP: "탑", JUNGLE: "정글", MIDDLE: "미드", BOTTOM: "원딜", UTILITY: "서폿" };
interface Added { participant_id: number; team_id: 100 | 200; streamer_id: string | null; observed_name: string | null; champion_id: number | null; team_position: string | null }

/**
 * 경기 고치기 폼 — 화면은 **바뀐 칸만** 보낸다(from = 처음 본 값, to = 고친 값). 같은 뜻인지·이미 그 값인지·그 사이 바뀌었는지는 core 가 판단한다.
 * ★ 요청 번호는 폼을 열 때 하나 — 두 번 누르거나 다시 보내도 core 가 같은 제보로 돌려준다(중복 막기 겹 1).
 */
export function CorrectionForm({ target, streamers, champions }: {
  target: CorrectionTarget;
  streamers: { id: string; display_name: string }[];
  champions: { id: number; name: string }[];
}) {
  const { state, dispatch, pending, onSubmit } = useKeptFormAction(submitCorrectionAction, IDLE);
  const [requestId] = useState(() => crypto.randomUUID());
  const [winner, setWinner] = useState<number | null>(target.winning_team);
  const [edits, setEdits] = useState<Record<number, Editable>>(() =>
    Object.fromEntries(target.slots.map((s) => [s.participant_id, pick(s)])));
  const [removed, setRemoved] = useState<Set<number>>(new Set());
  const [added, setAdded] = useState<Added[]>([]);

  const payload = useMemo<MatchCorrection>(() => {
    const out: MatchCorrection = {};
    if (winner !== target.winning_team && winner !== null) out.winning_team = { from: target.winning_team as 100 | 200 | null, to: winner as 100 | 200 };
    const parts: NonNullable<MatchCorrection["participants"]> = [];
    for (const s of target.slots) {
      if (removed.has(s.participant_id)) continue;
      const e = edits[s.participant_id];
      const changes: NonNullable<MatchCorrection["participants"]>[number]["changes"] = {};
      for (const f of FIELDS) if ((e[f] ?? null) !== (s[f] ?? null)) changes[f] = { from: s[f] ?? null, to: e[f] ?? null };
      if (Object.keys(changes).length) parts.push({ participant_id: s.participant_id, changes });
    }
    if (parts.length) out.participants = parts;
    if (removed.size) out.remove = [...removed];
    if (added.length) out.add = added.map((a) => ({ ...a, kills: null, deaths: null, assists: null }));
    return out;
  }, [winner, edits, removed, added, target]);
  const empty = !Object.keys(payload).length;
  const used = new Set([...target.slots.map((s) => s.participant_id), ...added.map((a) => a.participant_id)]);
  const nextSlot = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].find((n) => !used.has(n));
  const set = (id: number, patch: Partial<Editable>) => setEdits((cur) => ({ ...cur, [id]: { ...cur[id], ...patch } }));

  return <form action={dispatch} onSubmit={onSubmit} className="submission-form">
    <input type="hidden" name="request_id" value={requestId} />
    <input type="hidden" name="match_id" value={target.match_id} />
    <input type="hidden" name="payload" value={JSON.stringify(payload)} />
    <label>승리 팀
      <select value={winner ?? ""} onChange={(e) => setWinner(e.target.value ? Number(e.target.value) : null)}>
        {target.winning_team === null && <option value="">모름</option>}
        <option value="100">블루</option><option value="200">레드</option>
      </select>
    </label>
    {[100, 200].map((team) => <fieldset key={team} className="submission-team">
      <legend>{team === 100 ? "블루" : "레드"}</legend>
      {target.slots.filter((s) => s.team_id === team).map((s) => {
        const e = edits[s.participant_id], gone = removed.has(s.participant_id);
        return <div key={s.participant_id} className="submission-slot" data-removed={gone || undefined}>
          <span className="submission-slot-no">{s.participant_id}</span>
          {s.has_account
            ? <span className="submission-slot-person" title="계정이 연결된 자리 — 사람은 운영자가 확인한 뒤 바뀝니다">{s.display_name ?? "계정 자리"}</span>
            : <>
              <select aria-label={`${s.participant_id}번 스트리머`} value={e.streamer_id ?? ""} disabled={gone}
                onChange={(ev) => set(s.participant_id, { streamer_id: ev.target.value || null })}>
                <option value="">(스트리머 아님)</option>
                {streamers.map((o) => <option key={o.id} value={o.id}>{o.display_name}</option>)}
              </select>
              {!e.streamer_id && <input aria-label={`${s.participant_id}번 화면 이름`} value={e.observed_name ?? ""} maxLength={32} disabled={gone}
                placeholder="화면 이름" onChange={(ev) => set(s.participant_id, { observed_name: ev.target.value || null })} />}
            </>}
          <ChampionSelect value={e.champion_id} champions={champions} disabled={gone} label={`${s.participant_id}번 챔피언`}
            onChange={(v) => set(s.participant_id, { champion_id: v })} />
          <PositionSelect value={e.team_position} disabled={gone} label={`${s.participant_id}번 포지션`}
            onChange={(v) => set(s.participant_id, { team_position: v })} />
          {(["kills", "deaths", "assists"] as const).map((f) => <input key={f} type="number" min={0} max={99} inputMode="numeric"
            aria-label={`${s.participant_id}번 ${f === "kills" ? "킬" : f === "deaths" ? "데스" : "어시스트"}`} disabled={gone}
            value={e[f] ?? ""} onChange={(ev) => set(s.participant_id, { [f]: ev.target.value === "" ? null : Number(ev.target.value) })} />)}
          {!s.has_account && <label className="submission-remove"><input type="checkbox" checked={gone}
            onChange={(ev) => setRemoved((cur) => { const n = new Set(cur); if (ev.target.checked) n.add(s.participant_id); else n.delete(s.participant_id); return n; })} />없던 자리</label>}
        </div>;
      })}
      {added.filter((a) => a.team_id === team).map((a) => <div key={a.participant_id} className="submission-slot" data-added>
        <span className="submission-slot-no">{a.participant_id}</span>
        <select aria-label="더할 자리 스트리머" value={a.streamer_id ?? ""} onChange={(ev) => setAdded((cur) => cur.map((x) => x === a ? { ...x, streamer_id: ev.target.value || null } : x))}>
          <option value="">(스트리머 아님)</option>
          {streamers.map((o) => <option key={o.id} value={o.id}>{o.display_name}</option>)}
        </select>
        {!a.streamer_id && <input aria-label="더할 자리 화면 이름" value={a.observed_name ?? ""} maxLength={32} placeholder="화면 이름"
          onChange={(ev) => setAdded((cur) => cur.map((x) => x === a ? { ...x, observed_name: ev.target.value || null } : x))} />}
        <ChampionSelect value={a.champion_id} champions={champions} label="더할 자리 챔피언"
          onChange={(v) => setAdded((cur) => cur.map((x) => x === a ? { ...x, champion_id: v } : x))} />
        <PositionSelect value={a.team_position} label="더할 자리 포지션"
          onChange={(v) => setAdded((cur) => cur.map((x) => x === a ? { ...x, team_position: v } : x))} />
        <button type="button" onClick={() => setAdded((cur) => cur.filter((x) => x !== a))}>빼기</button>
      </div>)}
      {nextSlot && <button type="button" className="submission-add"
        onClick={() => setAdded((cur) => [...cur, { participant_id: nextSlot, team_id: team as 100 | 200, streamer_id: null, observed_name: null, champion_id: null, team_position: null }])}>
        + 빠진 자리 더하기</button>}
    </fieldset>)}
    <label>근거 링크(선택)<input name="evidence_url" type="url" maxLength={500} placeholder="VOD 시점 링크·공지 주소" /></label>
    <label>메모(선택)<textarea name="note" rows={3} maxLength={1000} placeholder="어디서 확인했는지 적어 주면 확인이 빨라집니다" /></label>
    {state.message && <p role={state.ok ? "status" : "alert"}>{state.message}</p>}
    <button disabled={pending || empty || (state.ok && !!state.message)}>{pending ? "보내는 중…" : empty ? "바꾼 칸이 없습니다" : "제보 보내기"}</button>
  </form>;
}

function pick(s: Slot): Editable {
  return { streamer_id: s.streamer_id, observed_name: s.observed_name, champion_id: s.champion_id, team_position: s.team_position, kills: s.kills, deaths: s.deaths, assists: s.assists };
}

function ChampionSelect({ value, champions, onChange, disabled, label }: {
  value: number | null; champions: { id: number; name: string }[]; onChange: (v: number | null) => void; disabled?: boolean; label: string;
}) {
  return <select aria-label={label} value={value ?? ""} disabled={disabled} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
    <option value="">챔피언 모름</option>
    {champions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
  </select>;
}

function PositionSelect({ value, onChange, disabled, label }: { value: string | null; onChange: (v: string | null) => void; disabled?: boolean; label: string }) {
  return <select aria-label={label} value={value ?? ""} disabled={disabled} onChange={(e) => onChange(e.target.value || null)}>
    <option value="">포지션 모름</option>
    {CORRECTION_POSITIONS.map((p) => <option key={p} value={p}>{POSITION_NAME[p]}</option>)}
  </select>;
}

/** 같은 내용이에요(+1) — 새 제보 대신. 경기 제보는 matchId, 편성표 제보는 entryId. */
export function SupportButton({ id, matchId, entryId }: { id: string; matchId?: string; entryId?: string }) {
  const { state, dispatch, pending, onSubmit } = useKeptFormAction(supportAction, IDLE);
  return <form action={dispatch} onSubmit={onSubmit} className="submission-support">
    <input type="hidden" name="id" value={id} /><input type="hidden" name="match_id" value={matchId ?? ""} /><input type="hidden" name="entry_id" value={entryId ?? ""} />
    <button disabled={pending || (state.ok && !!state.message)}>같은 내용이에요(+1)</button>
    {state.message && <span role={state.ok ? "status" : "alert"}>{state.message}</span>}
  </form>;
}

/** 편성표 제보가 처음 보여 주는 값(고치기는 지금 일정, 새 일정은 빈 칸). */
export interface ScheduleReportStart { game_code: string; title: string; status: string; on_date: string; start: string; participants: string }

/**
 * 편성표 제보 폼 — 고치기는 **바뀐 칸만** 보낸다(처음 본 값과 다른 칸). 새 일정은 전부 보낸다.
 * 반영은 운영자가 한다 — 보낸 뒤에도 편성표는 그대로이고 내 제보에서 처리 상태를 본다.
 */
export function ScheduleReportForm({ entryId, start }: { entryId: string | null; start: ScheduleReportStart }) {
  const { state, dispatch, pending, onSubmit } = useKeptFormAction(submitScheduleReportAction, IDLE);
  const [requestId] = useState(() => crypto.randomUUID());
  const [v, setV] = useState(start);
  const [note, setNote] = useState("");
  const isNew = entryId === null;
  const payload = useMemo<ScheduleReport>(() => {
    if (isNew) return { type: "new", game_code: v.game_code as ScheduleReport["game_code"], title: v.title, on_date: v.on_date, start: v.start || null, participants: v.participants };
    const out: Record<string, unknown> = { type: "correction" };
    if (v.title !== start.title) out.title = v.title;
    if (v.status !== start.status) out.status = v.status;
    if (v.on_date !== start.on_date || v.start !== start.start) { out.on_date = v.on_date; out.start = v.start || null; }
    if (v.participants !== start.participants) out.participants = v.participants;
    return out as unknown as ScheduleReport;
  }, [v, start, isNew]);
  const empty = !isNew && Object.keys(payload).length === 1 && !note.trim();
  const set = (patch: Partial<ScheduleReportStart>) => setV((cur) => ({ ...cur, ...patch }));
  return <form action={dispatch} onSubmit={onSubmit} className="submission-form">
    <input type="hidden" name="request_id" value={requestId} />
    <input type="hidden" name="entry_id" value={entryId ?? ""} />
    <input type="hidden" name="payload" value={JSON.stringify(payload)} />
    {isNew && <label>게임
      <select value={v.game_code} onChange={(e) => set({ game_code: e.target.value })}>
        {SCHEDULE_GAMES.map((g) => <option key={g} value={g}>{SCHEDULE_GAME_LABEL[g]}</option>)}
      </select>
    </label>}
    <label>제목<input value={v.title} maxLength={100} required={isNew} onChange={(e) => set({ title: e.target.value })} placeholder="예: 멸망전 시즌 5 결승" /></label>
    {!isNew && <label>상태
      <select value={v.status} onChange={(e) => set({ status: e.target.value })}>
        {!SCHEDULE_REPORT_STATUSES.includes(start.status as never) && <option value={start.status}>지금 그대로</option>}
        {SCHEDULE_REPORT_STATUSES.map((s) => <option key={s} value={s}>{SCHEDULE_REPORT_STATUS_LABEL[s]}</option>)}
      </select>
    </label>}
    <div className="submission-row">
      <label>날짜<input type="date" value={v.on_date} required={isNew} onChange={(e) => set({ on_date: e.target.value })} /></label>
      <label>시작 시각(선택)<input type="time" value={v.start} onChange={(e) => set({ start: e.target.value })} /></label>
    </div>
    <label>참가자(선택)<textarea rows={2} maxLength={300} value={v.participants} placeholder="이름을 쉼표로 나눠 써 주세요"
      onChange={(e) => set({ participants: e.target.value })} /></label>
    <label>근거 링크{isNew ? "" : "(선택)"}<input name="evidence_url" type="url" maxLength={500} required={isNew} placeholder="방송 공지·SNS 주소" /></label>
    <label>메모(선택)<textarea name="note" rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)}
      placeholder={isNew ? "알고 있는 내용을 더 적어 주세요" : "바뀐 내용이나 확인한 곳을 적어 주세요"} /></label>
    {state.message && <p role={state.ok ? "status" : "alert"}>{state.message}</p>}
    <button disabled={pending || empty || (state.ok && !!state.message)}>{pending ? "보내는 중…" : empty ? "바꾼 칸이 없습니다" : "제보 보내기"}</button>
  </form>;
}
