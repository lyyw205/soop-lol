import Link from "next/link";
import { fcMatchHref } from "@soop-lol/core/lib/site-paths";
import type { FcoGame, FcoPerson } from "@soop-lol/core/lib/db/fconline";
import { kstDateString } from "@soop-lol/core/lib/time";
import { rawWinRate } from "@soop-lol/core/lib/metrics/affinity";
import { FCO_MODE_LABEL } from "@soop-lol/core/lib/games/fconline/view";
import { Avatar } from "./avatar";
import { RecordEventItem, RecordEventList } from "./record-structure";
import { fcTournamentHref, fcVersusHref } from "@/lib/module-links";

export interface FcoOpponentRow {
  id: string; slug: string; name: string; matches: FcoGame[];
  vs_matches: number; vs_match_wins: number; vs_match_draws: number; vs_match_unknown: number;
  ally_matches: number; last_met: string;
}

export function FcoOpponentHistory({ rows, people, streamerId, streamerSlug, streamerName }: {
  rows: FcoOpponentRow[]; people: FcoPerson[];
  streamerId: string; streamerSlug: string; streamerName: string;
}) {
  if (!rows.length) return <p className="personal-history-empty">연결된 스트리머와의 맞대결 기록이 없습니다.</p>;
  const byId = new Map(people.map((person) => [person.id, person]));
  return <div className="opponent-history-list">{rows.map((row) => {
    const person = byId.get(row.id);
    const losses = row.vs_matches - row.vs_match_wins - row.vs_match_draws - row.vs_match_unknown;
    const rate = rawWinRate({ wins: row.vs_match_wins, losses });
    const versusHref = fcVersusHref(streamerSlug, row.slug);
    return <div key={row.id} className="personal-timeline-row opponent-history-row"
      data-result={row.vs_match_wins === losses ? "draw" : row.vs_match_wins > losses ? "win" : "loss"}>
      <details className="personal-match-detail">
        <summary className="arena-match-toggle personal-match-toggle opponent-history-toggle">
          <span className="opponent-history-person"><Avatar name={row.name} src={person?.image ?? null} channelId={person?.channel_id} /><strong>{row.name}</strong></span>
          <span className="opponent-history-record"><b>{row.vs_match_wins}승</b><span>{row.vs_match_draws}무</span><b>{losses}패</b></span>
          <span className="opponent-history-rate">{rate === null ? "—" : `${Math.round(rate * 100)}%`}<small>{row.vs_matches}경기{row.vs_match_unknown ? ` · 결과 미상 ${row.vs_match_unknown}` : ""}</small></span>
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
              <span className="opponent-history-event"><Link href={fcMatchHref(game.provider_id)}>{game.event_name ?? "맞대결"}</Link></span>
              <strong>{mine.score_display ?? mine.goals ?? "?"} : {other.score_display ?? other.goals ?? "?"}</strong>
              <small>{FCO_MODE_LABEL[game.mode_key ?? ""] ?? "경기"}</small>
              <span data-result={mine.outcome}>{mine.outcome === "win" ? "승" : mine.outcome === "draw" ? "무" : mine.outcome === "loss" ? "패" : "?"}</span>
            </li>;
          })}</ul>
        </div>
      </details>
    </div>;
  })}</div>;
}

export interface FcoProfileEventRow {
  slug: string; name: string; games: number; wins: number; draws: number; losses: number; unknown: number;
  firstPlayed: string; lastPlayed: string;
}

export function FcoProfileEventList({ rows }: { rows: FcoProfileEventRow[] }) {
  if (!rows.length) return <p className="personal-history-empty">연결된 대회 경기가 없습니다.</p>;
  return <RecordEventList>{rows.map((row) => {
    const firstDay = kstDateString(new Date(row.firstPlayed));
    const lastDay = kstDateString(new Date(row.lastPlayed));
    return <RecordEventItem key={row.slug}>
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      {fcTournamentHref(row.slug)
        ? <Link className="font-medium text-ink-200" href={fcTournamentHref(row.slug)!}>{row.name} →</Link>
        : <span className="font-medium text-ink-200">{row.name}</span>}
      <span className="text-[11px] text-ink-400">{firstDay.replaceAll("-", ".")}{firstDay !== lastDay ? ` – ${lastDay.replaceAll("-", ".")}` : ""}</span>
    </div>
    <p className="tabular mt-2 text-sm text-ink-300">매치 {row.wins}승{row.draws ? ` ${row.draws}무` : ""} {row.losses}패{row.unknown ? ` · 결과 미상 ${row.unknown}` : ""}
      <span className="ml-3 text-[11px] text-ink-500">확인된 {row.games}경기</span></p>
  </RecordEventItem>;
  })}</RecordEventList>;
}
