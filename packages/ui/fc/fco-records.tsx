import Link from "next/link";
import { Fragment } from "react";
import {
  addFcoStats, EMPTY_FCO_STATS, fcoNumber, FCO_MODE_LABEL, kstDateString,
  type FcoGame, type FcoParticipant, type FcoStatLine,
} from "@soop-lol/core/lib/contract";
import { RecordTimeline, RecordTimelineRow, RecordTimelineYear } from "../record-structure.tsx";

export function fcDate(date: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(date));
}

export function FcoMatchList({ games, perspectiveStreamerId, rowIdPrefix }: { games: FcoGame[]; perspectiveStreamerId?: string; rowIdPrefix?: string }) {
  if (games.length === 0) return <div className="fc-empty">스트리머 간 FC 온라인 경기 기록이 없습니다.</div>;
  let previousYear = "";
  let previousDate = "";
  return <RecordTimeline>{games.map((game) => {
    const [a, b] = game.participants;
    const date = kstDateString(new Date(game.played_at)).replaceAll("-", ".");
    const year = date.slice(0, 4);
    const showYear = previousYear !== year;
    const showDate = showYear || previousDate !== date;
    previousYear = year;
    previousDate = date;
    const perspective = game.participants.find((participant) => participant.streamer_id === perspectiveStreamerId);
    const result = perspective?.outcome ?? "unknown";
    return <Fragment key={game.id}>
      {showYear && <RecordTimelineYear year={year} />}
      <RecordTimelineRow id={rowIdPrefix ? `${rowIdPrefix}${game.id}` : undefined}
        dateTime={kstDateString(new Date(game.played_at))} title={fcDate(game.played_at)} result={result}
        date={showDate ? <><span className="personal-match-date-year">{date.slice(0, 5)}</span>{date.slice(5)}</> : <span className="sr-only">{date}</span>}>
        <div className="personal-match-detail">
          <Link className="arena-match-toggle personal-match-toggle fc-history-link" href={`/fc/m/${encodeURIComponent(game.provider_id)}`}>
            <span className="record-match-event" title={game.event_name ?? "일반 경기"}><span className="record-match-clip">{game.event_name ?? "일반 경기"}</span></span>
            <span className="personal-match-teams"><span className="record-match-clip">{a?.streamer_name ?? a?.nickname ?? "미확인"}</span>
              <strong>{a?.score_display ?? a?.goals ?? "?"}<i>:</i>{b?.score_display ?? b?.goals ?? "?"}</strong>
              <span className="record-match-clip">{b?.streamer_name ?? b?.nickname ?? "미확인"}</span></span>
            <small>{FCO_MODE_LABEL[game.mode_key ?? ""] ?? `모드 ${game.mode_key ?? "미상"}`}</small>
            {perspective && <span className="personal-match-result">{result === "win" ? "승" : result === "loss" ? "패" : result === "draw" ? "무" : "?"}</span>}
            <span className="fc-history-arrow" aria-hidden="true">→</span>
          </Link>
        </div>
      </RecordTimelineRow>
    </Fragment>;
  })}</RecordTimeline>;
}

export function statsForGames(games: FcoGame[], streamerId: string): FcoStatLine {
  return games.flatMap((game) => game.participants.filter((p) => p.streamer_id === streamerId))
    .reduce(addFcoStats, EMPTY_FCO_STATS);
}

export function FcoStatsTable({ games, emptyMessage = "대회에 연결된 경기부터 스탯표가 채워집니다." }: { games: FcoGame[]; emptyMessage?: string }) {
  const lines = new Map<string, { name: string; slug: string | null; stats: FcoStatLine }>();
  for (const game of games) for (const participant of game.participants) {
    if (!participant.streamer_id) continue;
    const key = participant.streamer_id ?? `ouid:${participant.ouid}`;
    const current = lines.get(key) ?? {
      name: participant.streamer_name ?? participant.nickname,
      slug: participant.streamer_slug,
      stats: EMPTY_FCO_STATS,
    };
    current.stats = addFcoStats(current.stats, participant);
    lines.set(key, current);
  }
  if (!lines.size) return <div className="fc-empty">{emptyMessage}</div>;
  return <div className="fc-table-wrap"><table className="fc-table">
    <thead><tr><th>참가자</th><th>경기</th><th>승-무-패</th><th>골</th><th>슛</th><th>유효 슛</th><th>패스 성공</th><th>평균 점유율</th><th>태클 성공</th></tr></thead>
    <tbody>{[...lines.values()].sort((a,b) => b.stats.wins-a.stats.wins || b.stats.goals-a.stats.goals).map(({name,slug,stats}) =>
      <tr key={`${name}:${slug}`}>
        <td>{slug ? <Link href={`/fc/s/${slug}`}>{name}</Link> : name}</td>
        <td>{stats.games}</td><td>{stats.wins}-{stats.draws}-{stats.losses}</td>
        <td>{stats.goals}</td><td>{stats.shots}</td><td>{stats.shotsOnTarget}</td>
        <td>{stats.passTry ? `${Math.round(stats.passSuccess/stats.passTry*100)}%` : "—"}</td>
        <td>{stats.games ? `${Math.round(stats.possessionTotal/stats.games)}%` : "—"}</td>
        <td>{stats.tackles}</td>
      </tr>)}</tbody>
  </table></div>;
}

export function FcoSquad({ participant, names, positions }: {
  participant: FcoParticipant;
  names: Map<number,string>;
  positions: Map<number,string>;
}) {
  const raw = participant.match_info.player;
  const players = Array.isArray(raw) ? raw as Record<string, unknown>[] : [];
  if (!players.length) return <div className="fc-empty">이 경기의 선수 기록이 없습니다.</div>;
  return <div className="fc-table-wrap"><table className="fc-table">
    <thead><tr><th>선수</th><th>포지션</th><th>강화</th><th>평점</th><th>골</th><th>도움</th><th>패스 성공</th><th>태클</th></tr></thead>
    <tbody>{players.map((player, i) => {
      const id = fcoNumber(player.spId);
      const status = player.status && typeof player.status === "object" ? player.status as Record<string,unknown> : {};
      return <tr key={`${id}-${i}`}>
        <td>{names.get(id) ?? `선수 ${id}`}</td><td>{positions.get(fcoNumber(player.spPosition)) ?? player.spPosition?.toString() ?? "—"}</td>
        <td>+{fcoNumber(player.spGrade)}</td><td>{status.spRating == null ? "—" : fcoNumber(status.spRating).toFixed(1)}</td>
        <td>{fcoNumber(status.goal)}</td><td>{fcoNumber(status.assist)}</td>
        <td>{fcoNumber(status.passSuccess)}/{fcoNumber(status.passTry)}</td><td>{fcoNumber(status.tackle)}</td>
      </tr>;
    })}</tbody>
  </table></div>;
}

export function FcoTournamentPlayers({ games, names, emptyMessage = "선수별 대회 기록이 없습니다." }: { games: FcoGame[]; names: Map<number,string>; emptyMessage?: string }) {
  const rows = new Map<string, {
    streamer: string; slug: string | null; playerId: number; games: number;
    goals: number; assists: number; rating: number; rated: number; passes: number; passTry: number;
  }>();
  for (const game of games) for (const participant of game.participants) {
    if (!participant.streamer_id) continue;
    const roster = participant.match_info.player;
    if (!Array.isArray(roster)) continue;
    for (const raw of roster) {
      if (!raw || typeof raw !== "object") continue;
      const player = raw as Record<string,unknown>;
      const playerId = fcoNumber(player.spId);
      if (!playerId) continue;
      const status = player.status && typeof player.status === "object" ? player.status as Record<string,unknown> : {};
      const key = `${participant.streamer_id}:${playerId}`;
      const line = rows.get(key) ?? {
        streamer: participant.streamer_name ?? participant.nickname,
        slug: participant.streamer_slug, playerId, games: 0, goals: 0, assists: 0,
        rating: 0, rated: 0, passes: 0, passTry: 0,
      };
      line.games++;
      line.goals += fcoNumber(status.goal);
      line.assists += fcoNumber(status.assist);
      line.passes += fcoNumber(status.passSuccess);
      line.passTry += fcoNumber(status.passTry);
      if (typeof status.spRating === "number") { line.rating += status.spRating; line.rated++; }
      rows.set(key, line);
    }
  }
  if (!rows.size) return <div className="fc-empty">{emptyMessage}</div>;
  return <div className="fc-table-wrap"><table className="fc-table">
    <thead><tr><th>선수</th><th>사용한 스트리머</th><th>출전</th><th>골</th><th>도움</th><th>평균 평점</th><th>패스 성공</th></tr></thead>
    <tbody>{[...rows.values()].sort((a,b) => b.goals-a.goals || b.assists-a.assists || b.games-a.games).map((line) =>
      <tr key={`${line.slug}:${line.playerId}`}>
        <td>{names.get(line.playerId) ?? `선수 ${line.playerId}`}</td>
        <td>{line.slug ? <Link href={`/fc/s/${line.slug}`}>{line.streamer}</Link> : line.streamer}</td>
        <td>{line.games}</td><td>{line.goals}</td><td>{line.assists}</td>
        <td>{line.rated ? (line.rating/line.rated).toFixed(1) : "—"}</td>
        <td>{line.passTry ? `${Math.round(line.passes/line.passTry*100)}%` : "—"}</td>
      </tr>)}</tbody>
  </table></div>;
}
