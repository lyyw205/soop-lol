import Link from "next/link";
import { fcMatchHref, profileHref, tally, type FcoGame, type FcoPerson, type FcoStatLine, type Tally } from "@soop-lol/core/lib/contract/client";
import { Avatar } from "../avatar.tsx";
import { RecordOverviewCard } from "../record-structure.tsx";
import { RecordPair } from "../record-pair.tsx";
import { recordText } from "../record-pair-model.ts";
import { fcDate, fcoSetOutcome, statsForGames } from "./fco-records.tsx";

/** 대회 링크는 대회 화면을 가진 모듈이 있을 때만 부르는 쪽이 넘긴다. 없으면 이름만 보인다. */
export function FcoPersonalOverview({ person, stats: input, careerEvents, scopeLabel, eventHref }: {
  person: FcoPerson; stats: (FcoStatLine & { record: Tally; lastPlayed: string | null }) | null;
  careerEvents: {slug: string; name: string; games: number}[];
  scopeLabel?: string; eventHref?: (slug: string) => string;
}) {
  // 기록은 tally(세트·시리즈) 하나 — 목록과 같은 공개 내전 세트에서 셌다(db/fconline.ts getFcoPersonalSummary).
  const stats = input ?? { games: 0, record: tally([]), goals: 0, shots: 0, shotsOnTarget: 0, passTry: 0, passSuccess: 0, lastPlayed: null };
  return <RecordOverviewCard className="personal-profile-card fc-personal-card" label="개인 프로필 및 전적 요약">
    <div className="personal-profile-portrait"><Avatar name={person.name} src={person.image} channelId={person.channel_id} /></div>
    <header className="personal-profile-identity">
      <p className="personal-profile-accounts"><span>{person.nickname}</span></p>
      <h2>{person.name}</h2>
      <p className="fc-card-identity-note">FC 온라인 · {scopeLabel ?? "전체 기록"}</p>
    </header>
    <div className="personal-stat-grid">
      <div><small>내전 세트</small><strong>{stats.games}</strong><span>{stats.lastPlayed ? `최근 ${fcDate(stats.lastPlayed)}` : "기록 없음"}</span></div>
      <div><small>세트</small><strong className="personal-wdl">{recordText(stats.record.sets)}</strong><span>득점 {stats.goals}골</span></div>
      <div><small>시리즈</small><strong className="personal-wdl">{recordText(stats.record.series)}</strong><span>한 판짜리도 시리즈 하나</span></div>
    </div>
    <div className="profile-most profile-info-section">
      <h3>주요 경기 지표</h3>
      <div className="fc-card-facts"><span>슛 <b>{stats.shots}</b></span><span>유효 슛 <b>{stats.shotsOnTarget}</b></span>
        <span>패스 성공률 <b>{stats.passTry ? `${Math.round(stats.passSuccess / stats.passTry * 100)}%` : "—"}</b></span></div>
    </div>
    <div className="profile-career profile-info-section">
      <h3>참가 CK · 대회 <small>통산</small></h3>
      {careerEvents.length ? <div className="fc-card-events">{careerEvents.slice(0, 2).map(event =>
        eventHref ? <Link key={event.slug} href={eventHref(event.slug)}>{event.name} <small>{event.games}경기</small></Link>
          : <span key={event.slug}>{event.name} <small>{event.games}경기</small></span>)}</div>
        : <p className="profile-info-empty">연결된 대회 경기가 없습니다.</p>}
    </div>
  </RecordOverviewCard>;
}

export function FcoVersusOverview({ a, b, games, periodLabel = "수집한 경기", onRecentSelect, swapHref }: {
  a: FcoPerson; b: FcoPerson; games: FcoGame[]; periodLabel?: string;
  onRecentSelect?: (game: FcoGame) => void; swapHref?: string;
}) {
  const stats = statsForGames(games, a.id);
  // ★ 맞대결 기록은 두 사람의 결과 짝(pairSetOutcome)으로 센다 — 양쪽 몰수패는 무, 그래서 순서를 바꿔도 거울이다(감사 B2).
  const record = tally(games.map((game) => ({ series_id: game.series_id ?? game.id, outcome: fcoSetOutcome(game, a.id, b.id) })));
  const recent = games.slice(0, 5).reverse();
  const first = games[games.length - 1];
  return <>
    <RecordOverviewCard className="record-overview fc-versus-card" label="상대전적 요약">
      <div className="arena-fixture-top">FC 온라인 <span className="arena-fixture-sep" aria-hidden="true">|</span> {periodLabel}</div>
      <div className="arena-duel">
        <Link href={profileHref("fconline", a.slug)} className="arena-person">
          <span className="arena-disc"><Avatar name={a.name} src={a.image} channelId={a.channel_id} /><i className="arena-person-badge">기준</i></span>
          <strong className="arena-person-name">{a.name}</strong><small>{a.nickname}</small>
        </Link>
        {swapHref && <Link className="arena-duel-swap" href={swapHref} prefetch={false}
          title="스트리머 순서 바꾸기" aria-label="스트리머 순서 바꾸기">
          <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2.5 5h9M9 2.5 11.5 5 9 7.5M13.5 11h-9M7 8.5 4.5 11 7 13.5" />
          </svg>
        </Link>}
        <Link href={profileHref("fconline", b.slug)} className="arena-person">
          <span className="arena-disc"><Avatar name={b.name} src={b.image} channelId={b.channel_id} /></span>
          <strong className="arena-person-name">{b.name}</strong><small>{b.nickname}</small>
        </Link>
      </div>
      <div className="arena-score-area">
        <p>{games.length ? `${games.length}세트 맞대결` : "아직 맞대결 기록이 없습니다"}</p>
        <div className="arena-score" aria-label={`세트 ${a.name} ${record.sets.win}승, ${b.name} ${record.sets.loss}승`}>
          {games.length ? record.sets.win : "—"}<span>–</span>{games.length ? record.sets.loss : "—"}
        </div>
        <p>무 {record.sets.draw}{record.sets.unknown ? ` · 미상 ${record.sets.unknown}` : ""} · {a.name} 기준 {stats.goals}골</p>
        {games.length > 0 && <RecordPair tally={record} subject={a.name} compact />}
      </div>
      {recent.length > 0 && <div className="record-form">
        <span className="record-form-label">최근 {recent.length}경기</span>
        <ol className="record-form-chips">{recent.map((game) => {
          const outcome = fcoSetOutcome(game, a.id, b.id);
          const label = outcome === "win" ? "승" : outcome === "draw" ? "무" : outcome === "loss" ? "패" : "?";
          const title = `${fcDate(game.played_at)} · ${label}`;
          return <li key={game.id}>{onRecentSelect
            ? <button type="button" className="fc-form-chip" data-result={outcome} title={title}
                aria-label={`${title} · 경기 기록으로 이동`} onClick={() => onRecentSelect(game)}>{label}</button>
            : <Link className="fc-form-chip" data-result={outcome} title={title}
                aria-label={`${title} · 경기 상세 보기`} href={fcMatchHref(game.provider_id)}>{label}</Link>}</li>;
        })}</ol>
        <span className="record-form-hint">오래된 → 최근</span>
      </div>}
    </RecordOverviewCard>
    <div className="arena-score-meta"><span>{first ? `처음 만난 날 ${fcDate(first.played_at)}` : "수집된 맞대결 경기가 없습니다"}</span></div>
  </>;
}
