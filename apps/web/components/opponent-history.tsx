import Link from "next/link";
import { Avatar } from "./avatar";
import { kstDateString } from "@soop-lol/core/lib/time";
import { formatBadge, matchOutcome, OUTCOME_LABEL } from "../../../packages/ui/match-row-model";
import { rawWinRate } from "@soop-lol/core/lib/metrics/affinity";
import type { OpponentHistory } from "@soop-lol/core/lib/metrics/opponent-history";
import type { RecordPeriod } from "@soop-lol/core/lib/metrics/record-period";
import type { PublicStreamer } from "@soop-lol/core/lib/contract";
import { versusHref } from "@/lib/module-links";

export function OpponentHistoryList({ rows, people, slug, streamerName, category, period, laneOnly }: {
  rows: OpponentHistory[]; people: PublicStreamer[]; slug: string; streamerName: string;
  category: string; period: RecordPeriod; laneOnly: boolean;
}) {
  const byId = new Map(people.map((p)=>[p.streamer_id,p]));
  if (!rows.length) return <p className="personal-history-empty">선택한 조건에 맞는 {laneOnly ? "맞라인" : "상대"} 기록이 없습니다.</p>;
  return <div className="opponent-history-list">
    {rows.map((r)=>{
      const person = byId.get(r.other_id);
      if (!person) return null;
      const losses = r.vs_matches-r.vs_match_wins-r.vs_match_draws;
      const rate = rawWinRate({wins:r.vs_match_wins,losses});
      const detailHref = versusHref(slug,person.slug,{category,from:period.from,to:period.to,relation:laneOnly?"lane":undefined});
      return <div key={r.other_id} className="personal-timeline-row opponent-history-row" data-result={r.vs_match_wins===losses?"draw":r.vs_match_wins>losses?"win":"loss"}>
        <details className="personal-match-detail">
          <summary className="arena-match-toggle personal-match-toggle opponent-history-toggle">
            <span className="opponent-history-person"><Avatar name={person.display_name} src={person.profile_image_url} channelId={person.channel_id ?? undefined} /><strong>{person.display_name}</strong></span>
            <span className="opponent-history-record"><b>{r.vs_match_wins}승</b><span>{r.vs_match_draws}무</span><b>{losses}패</b></span>
            <span className="opponent-history-rate">{rate===null?"—":`${Math.round(rate*100)}%`}<small>{r.vs_matches}경기 · {r.vs_sets}세트</small></span>
            <span className="personal-match-expand" aria-hidden="true" />
          </summary>
          <div className="opponent-history-expanded">
            <div className="opponent-history-expanded-heading"><span>{streamerName} vs {person.display_name}</span>{detailHref && <Link href={detailHref}>상대전적 페이지 →</Link>}</div>
            <ul>{r.matches.map((m)=><li key={m.series}>
              <time dateTime={kstDateString(m.played_at)}>{kstDateString(m.played_at).replaceAll("-", ".")}</time>
              <span className="opponent-history-event">{m.event_name ?? "맞대결"}</span>
              <strong>{m.wins} : {m.sets-m.wins}</strong>
              {/* 형식을 몰라도 세트 수로 채운다 — 비우면 이 화면만 빈칸이 된다. */}
              <small>{formatBadge(m.best_of, m.sets, m.standalone)}</small>
              <span data-result={matchOutcome(m.wins, m.sets)}>{OUTCOME_LABEL[matchOutcome(m.wins, m.sets)]}</span>
            </li>)}</ul>
          </div>
        </details>
      </div>;
    })}
  </div>;
}
