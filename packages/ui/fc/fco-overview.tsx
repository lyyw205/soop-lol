import Link from "next/link";
import type { FcoGame, FcoPerson } from "@soop-lol/core/lib/contract";
import { Avatar } from "../avatar.tsx";
import { RecordOverviewCard } from "../record-structure.tsx";
import { fcDate, statsForGames } from "./fco-records.tsx";

/** 대회 링크는 대회 화면을 가진 모듈이 있을 때만 부르는 쪽이 넘긴다. 없으면 이름만 보인다. */
export function FcoPersonalOverview({ person, games, scopeLabel, eventHref }: {
  person: FcoPerson; games: FcoGame[]; scopeLabel?: string; eventHref?: (slug: string) => string;
}) {
  const stats = statsForGames(games, person.id);
  const decided = stats.wins + stats.losses;
  const events = new Map<string, { name: string; count: number }>();
  for (const game of games) {
    if (!game.event_slug || !game.event_name) continue;
    const current = events.get(game.event_slug) ?? { name: game.event_name, count: 0 };
    current.count++;
    events.set(game.event_slug, current);
  }
  return <RecordOverviewCard className="personal-profile-card fc-personal-card" label="개인 프로필 및 전적 요약">
    <div className="personal-profile-portrait"><Avatar name={person.name} src={person.image} channelId={person.channel_id} /></div>
    <header className="personal-profile-identity">
      <p className="personal-profile-accounts"><span>{person.nickname}</span></p>
      <h2>{person.name}</h2>
      <p className="fc-card-identity-note">FC 온라인 · {scopeLabel ?? `수집한 최근 ${games.length}경기 기준`}</p>
    </header>
    <div className="personal-stat-grid">
      <div><small>경기</small><strong>{stats.games}</strong><span>{games[0] ? `최근 ${fcDate(games[0].played_at)}` : "기록 없음"}</span></div>
      <div><small>승 · 무 · 패</small><strong className="personal-wdl">{stats.wins}<i> / </i>{stats.draws}<i> / </i>{stats.losses}</strong><span>득점 {stats.goals}골</span></div>
      <div><small>경기 승률</small><strong>{decided ? `${(stats.wins / decided * 100).toFixed(1)}%` : "—"}</strong><span>무승부 제외</span></div>
    </div>
    <div className="profile-most profile-info-section">
      <h3>주요 경기 지표</h3>
      <div className="fc-card-facts"><span>슛 <b>{stats.shots}</b></span><span>유효 슛 <b>{stats.shotsOnTarget}</b></span>
        <span>패스 성공률 <b>{stats.passTry ? `${Math.round(stats.passSuccess / stats.passTry * 100)}%` : "—"}</b></span></div>
    </div>
    <div className="profile-career profile-info-section">
      <h3>참가 대회</h3>
      {events.size ? <div className="fc-card-events">{[...events.entries()].slice(0, 2).map(([slug, event]) =>
        eventHref ? <Link key={slug} href={eventHref(slug)}>{event.name} <small>{event.count}경기</small></Link>
          : <span key={slug}>{event.name} <small>{event.count}경기</small></span>)}</div>
        : <p className="profile-info-empty">연결된 대회 경기가 없습니다.</p>}
    </div>
  </RecordOverviewCard>;
}

export function FcoVersusOverview({ a, b, games, periodLabel = "수집한 경기", onRecentSelect, swapHref }: {
  a: FcoPerson; b: FcoPerson; games: FcoGame[]; periodLabel?: string;
  onRecentSelect?: (game: FcoGame) => void; swapHref?: string;
}) {
  const stats = statsForGames(games, a.id);
  const recent = games.slice(0, 5).reverse();
  const first = games[games.length - 1];
  return <>
    <RecordOverviewCard className="record-overview fc-versus-card" label="상대전적 요약">
      <div className="arena-fixture-top">FC 온라인 <span className="arena-fixture-sep" aria-hidden="true">|</span> {periodLabel}</div>
      <div className="arena-duel">
        <Link href={`/fc/s/${a.slug}`} className="arena-person">
          <span className="arena-disc"><Avatar name={a.name} src={a.image} channelId={a.channel_id} /><i className="arena-person-badge">기준</i></span>
          <strong className="arena-person-name">{a.name}</strong><small>{a.nickname}</small>
        </Link>
        {swapHref && <Link className="arena-duel-swap" href={swapHref}
          title="스트리머 순서 바꾸기" aria-label="스트리머 순서 바꾸기">
          <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2.5 5h9M9 2.5 11.5 5 9 7.5M13.5 11h-9M7 8.5 4.5 11 7 13.5" />
          </svg>
        </Link>}
        <Link href={`/fc/s/${b.slug}`} className="arena-person">
          <span className="arena-disc"><Avatar name={b.name} src={b.image} channelId={b.channel_id} /></span>
          <strong className="arena-person-name">{b.name}</strong><small>{b.nickname}</small>
        </Link>
      </div>
      <div className="arena-score-area">
        <p>{games.length ? `${games.length}번의 맞대결` : "아직 맞대결 기록이 없습니다"}</p>
        <div className="arena-score" aria-label={`${a.name} ${stats.wins}승, ${b.name} ${stats.losses}승`}>
          {games.length ? stats.wins : "—"}<span>–</span>{games.length ? stats.losses : "—"}
        </div>
        <p>무승부 {stats.draws}경기 · {a.name} 기준 {stats.goals}골</p>
      </div>
      {recent.length > 0 && <div className="record-form">
        <span className="record-form-label">최근 {recent.length}경기</span>
        <ol className="record-form-chips">{recent.map((game) => {
          const outcome = game.participants.find((participant) => participant.streamer_id === a.id)?.outcome;
          const label = outcome === "win" ? "승" : outcome === "draw" ? "무" : outcome === "loss" ? "패" : "?";
          const title = `${fcDate(game.played_at)} · ${label}`;
          return <li key={game.id}>{onRecentSelect
            ? <button type="button" className="fc-form-chip" data-result={outcome} title={title}
                aria-label={`${title} · 경기 기록으로 이동`} onClick={() => onRecentSelect(game)}>{label}</button>
            : <Link className="fc-form-chip" data-result={outcome} title={title}
                aria-label={`${title} · 경기 상세 보기`} href={`/fc/m/${encodeURIComponent(game.provider_id)}`}>{label}</Link>}</li>;
        })}</ol>
        <span className="record-form-hint">오래된 → 최근</span>
      </div>}
    </RecordOverviewCard>
    <div className="arena-score-meta"><span>{first ? `처음 만난 날 ${fcDate(first.played_at)}` : "수집된 맞대결 경기가 없습니다"}</span></div>
  </>;
}
