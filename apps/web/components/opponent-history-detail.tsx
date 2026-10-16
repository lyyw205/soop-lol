"use client";
import { useState, useRef, type ReactNode } from "react";
import { loadOpponentHistory } from "./opponent-history-action";
import { kstDateString } from "@soop-lol/core/lib/time";
import { formatBadge, matchOutcome, matchOutcomeLabel } from "../../../packages/ui/match-row-model";

type Data = Awaited<ReturnType<typeof loadOpponentHistory>>;
export function OpponentHistoryDetail({slug, otherId, category, from, to, laneOnly, summary, heading}: {
  slug: string; otherId: string; category: string; from?: string; to?: string; laneOnly: boolean;
  summary: ReactNode; heading: ReactNode;
}) {
  const [data,setData] = useState<Data | null>(null);
  const [error,setError] = useState(false);
  const busy = useRef(false);
  const load = async () => {
    if (busy.current || data) return;
    busy.current = true; setError(false);
    try { setData(await loadOpponentHistory(slug,otherId,category,from,to,laneOnly)); }
    catch { setError(true); } finally { busy.current = false; }
  };
  return <details className="personal-match-detail" onToggle={e => { if (e.currentTarget.open) void load(); }}>
    {summary}
    <div className="opponent-history-expanded">{heading}
      {!data && !error && <p role="status">불러오는 중…</p>}
      {error && <button type="button" onClick={load}>다시 불러오기</button>}
      {data && <><ul>{data.matches.map(m => <li key={m.series}>
        <time dateTime={kstDateString(new Date(m.played_at))}>{kstDateString(new Date(m.played_at)).replaceAll("-", ".")}</time>
        <span className="opponent-history-event">{m.event_name ?? "맞대결"}</span><strong>{m.wins} : {m.sets - m.wins}</strong>
        <small>{m.land ? `랜드 ${m.sets}판` : formatBadge(m.best_of,m.sets,m.standalone)}</small>
        <span data-result={matchOutcome(m.wins,m.sets,m.land)}>{matchOutcomeLabel(m.wins,m.sets,m.land)}</span>
      </li>)}</ul>{data.truncated && <p>최근 200개 기록을 표시합니다. 요약은 선택한 기간 전체 기준입니다.</p>}</>}
    </div>
  </details>;
}
