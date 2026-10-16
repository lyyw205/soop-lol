"use client";
import { useState, useRef, type ReactNode } from "react";
import { loadOpponentHistory } from "./opponent-history-action";
import { kstDateString } from "@soop-lol/core/lib/time";
import { formatBadge, OUTCOME_LABEL } from "../../../packages/ui/match-row-model";

type Data = Awaited<ReturnType<typeof loadOpponentHistory>>;
/** 펼친 목록 — 시리즈 한 줄. 결과는 core 의 시리즈 판정(result)이고, 스코어는 상대편이었던 세트의 승:패(무·미상은 옆에). */
export function OpponentHistoryDetail({slug, otherId, map, format, from, to, laneOnly, summary, heading}: {
  slug: string; otherId: string; map: string; format: string; from?: string; to?: string; laneOnly: boolean;
  summary: ReactNode; heading: ReactNode;
}) {
  const [data,setData] = useState<Data | null>(null);
  const [error,setError] = useState(false);
  const busy = useRef(false);
  const load = async () => {
    if (busy.current || data) return;
    busy.current = true; setError(false);
    try { setData(await loadOpponentHistory(slug,otherId,map,format,from,to,laneOnly)); }
    catch { setError(true); } finally { busy.current = false; }
  };
  return <details className="personal-match-detail" onToggle={e => { if (e.currentTarget.open) void load(); }}>
    {summary}
    <div className="opponent-history-expanded">{heading}
      {!data && !error && <p role="status">불러오는 중…</p>}
      {error && <button type="button" onClick={load}>다시 불러오기</button>}
      {data && <><ul>{data.matches.map(m => {
        const sets = m.record.win + m.record.draw + m.record.loss + m.record.unknown;
        const extra = [m.record.draw ? `무 ${m.record.draw}` : "", m.record.unknown ? `미상 ${m.record.unknown}` : ""].filter(Boolean).join(" · ");
        return <li key={m.series_id}>
          <time dateTime={kstDateString(new Date(m.played_at))}>{kstDateString(new Date(m.played_at)).replaceAll("-", ".")}</time>
          <span className="opponent-history-event">{m.event_name}</span><strong>{m.record.win} : {m.record.loss}{extra && <small> {extra}</small>}</strong>
          <small>{m.format === "land" ? `랜드 ${sets}판` : formatBadge(m.best_of,sets,m.standalone)}</small>
          <span data-result={m.result}>{OUTCOME_LABEL[m.result]}</span>
        </li>;
      })}</ul>{data.truncated && <p>최근 200개 기록을 표시합니다. 요약은 선택한 기간 전체 기준입니다.</p>}</>}
    </div>
  </details>;
}
