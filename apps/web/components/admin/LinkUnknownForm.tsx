"use client";

import { useActionState, useState } from "react";
import type { UnidentifiedSeat } from "@soop-lol/core/lib/db/ck";
import { linkUnknownAction } from "@/app/admin/ck/actions";
import { IDLE } from "@/lib/action-state";
import { ActionMessage } from "./Field";
import { kstDateString } from "@soop-lol/core/lib/time";
import { REVIEWED_HINT, REVIEWED_LABEL } from "@/lib/admin-labels";

const seatKey = (seat: UnidentifiedSeat) => JSON.stringify([seat.match_id, seat.participant_id]);

/** 선택한 자리와 기준값을 고정한다. 저장할 때 새로운 동명 행을 찾지 않는다. */
export function LinkUnknownForm({ targets }: { targets: UnidentifiedSeat[] }) {
  // RSC refresh during another form's save must not alter this form's selection/baseline.
  const [snapshot, setSnapshot] = useState(targets);
  const [selected, setSelected] = useState<string[]>([]);
  const [slug, setSlug] = useState("");
  const [state, action, pending] = useActionState(async (prev: typeof IDLE, form: FormData) => {
    const submitted = selected;
    const result = await linkUnknownAction(prev, form);
    if (result.ok) {
      setSnapshot(old => old.filter(t => !submitted.includes(seatKey(t))));
      setSelected([]);
    }
    return result;
  }, IDLE);
  const groups = Map.groupBy(snapshot, t => t.series_id ? `series:${t.series_id}` : `match:${t.match_id}`);
  const toggle = (ids: string[], checked: boolean) => setSelected(old => checked
    ? [...new Set([...old, ...ids])] : old.filter(id => !ids.includes(id)));

  return (
    <form action={action} onReset={event => event.preventDefault()} className="mt-3 grid gap-3 border-t border-ink-800 pt-3">
      <fieldset disabled={pending} className="grid gap-3">
        <legend className="mb-2 text-xs text-ink-400">같은 사람으로 확인한 자리를 선택하세요.</legend>
        {[...groups].map(([group, seats]) => {
          const available = seats.filter(t => !t.reviewed_at).map(seatKey);
          return <div key={group} className="grid gap-2 rounded border border-ink-800 p-2">
            <label className="flex gap-2 text-xs text-ink-200">
              <input type="checkbox" checked={available.length > 0 && available.every(id => selected.includes(id))}
                disabled={!available.length} onChange={e => toggle(available, e.target.checked)} />
              {seats[0].series_id ?? seats[0].match_id} — 연결 가능한 {available.length}자리 선택
            </label>
            {seats.map(t => <label key={seatKey(t)} className="flex gap-2 pl-4 text-xs text-ink-400">
              <input type="checkbox" name="targets" value={JSON.stringify(t)} checked={selected.includes(seatKey(t))}
                disabled={t.reviewed_at !== null} onChange={e => toggle([seatKey(t)], e.target.checked)} />
              <span>{kstDateString(new Date(t.played_at))} · {t.match_id} · {t.participant_id}번 · {t.champion_name ?? "챔피언 미상"}
                {t.reviewed_at !== null && <span title={REVIEWED_HINT}>{` · ${REVIEWED_LABEL} (경기 검수 화면에서 수정)`}</span>}</span>
            </label>)}
          </div>;
        })}
        <div className="flex flex-wrap items-center gap-2">
          <input name="streamer_slug" list="admin-streamers" placeholder="이 사람의 slug" value={slug}
            onChange={e => setSlug(e.target.value)} required
            className="w-56 rounded border border-ink-700 bg-ink-950 px-2 py-1 text-xs text-ink-200"
            title="등록된 스트리머의 slug" />
          <button type="submit" disabled={!selected.length || pending} className="rounded border border-ink-700 px-3 py-2 text-sm disabled:opacity-50">
            {pending ? "처리 중…" : `선택한 ${selected.length}자리 연결`}
          </button>
          <button type="button" onClick={() => window.location.reload()} className="text-xs text-ink-400">목록 새로 불러오기</button>
        </div>
      </fieldset>
      <ActionMessage state={state} />
      <p className="text-[11px] text-ink-600">
        선택한 자리만 한 번에 저장합니다. 챔피언·KDA는 유지하고 조우·통계를 다시 계산합니다.
        연결한 경기는 검수 처리되어 이후 자동 재수집으로 바뀌지 않습니다.
      </p>
    </form>
  );
}
