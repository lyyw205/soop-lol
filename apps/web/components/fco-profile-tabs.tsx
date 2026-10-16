import Link from "next/link";
import { formatLabel } from "@soop-lol/core/lib/metrics/format";
import { pairSetOutcome, type Tally } from "@soop-lol/core/lib/metrics/tally";
import { RecordPair } from "../../../packages/ui/record-pair";
import { recordText } from "../../../packages/ui/record-pair-model";
import { fcMatchHref } from "@soop-lol/core/lib/site-paths";
import type { FcoGame, FcoPerson, FcoProfileEventRecord } from "@soop-lol/core/lib/db/fconline";
import { kstDateString } from "@soop-lol/core/lib/time";
import { rawWinRate } from "@soop-lol/core/lib/metrics/affinity";
import { FCO_MODE_LABEL } from "@soop-lol/core/lib/games/fconline/view";
import { Avatar } from "./avatar";
import { RecordEventItem, RecordEventList } from "./record-structure";
import { fcTournamentHref, fcVersusHref } from "@/lib/module-links";

/** 상대 한 사람과의 맞대결 — 기록은 tally(세트·시리즈), 세트 결과는 두 사람의 결과 짝(pairSetOutcome). */
export interface FcoOpponentRow {
  id: string; slug: string; name: string; matches: FcoGame[];
  record: Tally; last_met: string;
}

export function FcoOpponentHistory({ rows, people, streamerId, streamerSlug, streamerName }: {
  rows: FcoOpponentRow[]; people: FcoPerson[];
  streamerId: string; streamerSlug: string; streamerName: string;
}) {
  if (!rows.length) return <p className="personal-history-empty">연결된 스트리머와의 맞대결 기록이 없습니다.</p>;
  const byId = new Map(people.map((person) => [person.id, person]));
  return <div className="opponent-history-list">{rows.map((row) => {
    const person = byId.get(row.id);
    // 승률·색은 시리즈 기준(다전제 한 번이 단판 세 번처럼 무게를 갖지 않게 — metrics/opponents 와 같은 기준). 미상은 분모에서 뺀다.
    const { win, loss } = row.record.series;
    const rate = rawWinRate({ wins: win, losses: loss });
    const versusHref = fcVersusHref(streamerSlug, row.slug);
    return <div key={row.id} className="personal-timeline-row opponent-history-row"
      data-result={win === loss ? "draw" : win > loss ? "win" : "loss"}>
      <details className="personal-match-detail">
        <summary className="arena-match-toggle personal-match-toggle opponent-history-toggle">
          <span className="opponent-history-person"><Avatar name={row.name} src={person?.image ?? null} channelId={person?.channel_id} /><strong>{row.name}</strong></span>
          <span className="opponent-history-record"><b>{recordText(row.record.series)}</b><span>시리즈</span></span>
          <span className="opponent-history-rate">{rate === null ? "—" : `${Math.round(rate * 100)}%`}<small>세트 {recordText(row.record.sets)}</small></span>
          <span className="personal-match-expand" aria-hidden="true" />
        </summary>
        <div className="opponent-history-expanded">
          <div className="opponent-history-expanded-heading"><span>{streamerName} vs {row.name}</span>{versusHref && <Link href={versusHref}>상대전적 페이지 →</Link>}</div>
          <ul>{row.matches.map((game) => {
            const mine = game.participants.find((participant) => participant.streamer_id === streamerId);
            const other = game.participants.find((participant) => participant.streamer_id === row.id);
            if (!mine || !other) return null;
            const day = kstDateString(new Date(game.played_at));
            return <li key={game.id}>
              <time dateTime={day}>{day.replaceAll("-", ".")}</time>
              <span className="opponent-history-event"><Link href={fcMatchHref(game.provider_id)}>{game.event_name ?? (game.format && formatLabel(game.format)) ?? "맞대결"}</Link></span>
              <strong>{mine.score_display ?? mine.goals ?? "?"} : {other.score_display ?? other.goals ?? "?"}</strong>
              <small>{FCO_MODE_LABEL[game.mode_key ?? ""] ?? "경기"}</small>
              {(() => { const o = pairSetOutcome(mine.outcome, other.outcome); return <span data-result={o}>{o === "win" ? "승" : o === "draw" ? "무" : o === "loss" ? "패" : "?"}</span>; })()}
            </li>;
          })}</ul>
        </div>
      </details>
    </div>;
  })}</div>;
}

export type FcoProfileEventRow = FcoProfileEventRecord;

export function FcoProfileEventList({ rows }: { rows: FcoProfileEventRow[] }) {
  if (!rows.length) return <p className="personal-history-empty">연결된 CK·대회 경기가 없습니다.</p>;
  return <RecordEventList>{rows.map((row) => {
    const firstDay = kstDateString(new Date(row.firstPlayed));
    const lastDay = kstDateString(new Date(row.lastPlayed));
    return <RecordEventItem key={row.slug}>
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      {formatLabel(row.format) && <span className="text-xs text-ink-400">{formatLabel(row.format)}</span>}
      {fcTournamentHref(row.slug)
        ? <Link className="font-medium text-ink-200" href={fcTournamentHref(row.slug)!}>{row.name} →</Link>
        : <span className="font-medium text-ink-200">{row.name}</span>}
      <span className="text-[length:var(--type-micro)] text-ink-400">{firstDay.replaceAll("-", ".")}{firstDay !== lastDay ? ` – ${lastDay.replaceAll("-", ".")}` : ""}</span>
    </div>
    <div className="mt-2"><RecordPair tally={row.record} compact /></div>
  </RecordEventItem>;
  })}</RecordEventList>;
}
