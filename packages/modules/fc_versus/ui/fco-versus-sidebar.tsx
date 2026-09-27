import Link from "next/link";
import type { FcoGame, FcoPerson, FcoTopPair } from "@soop-lol/core/lib/contract";
import { Avatar } from "../../../ui/avatar.tsx";
import { VERSUS_PATH } from "./paths.ts";

/** LoL 상대전적과 같은 우측 프로필 레일. FC 지표만 슬롯 내용으로 다르게 보여 준다. */
/** 대회 링크는 host 가 역할로 풀어 넘긴다 — 대회 모듈이 없으면 이름만 보인다. */
export function FcoVersusSidebar({ person, games, people, topPairs, opponentId, eventHref }: {
  person: FcoPerson; games: FcoGame[]; people: FcoPerson[]; topPairs: FcoTopPair[]; opponentId: string;
  eventHref: (slug: string) => string | null;
}) {
  const events = [...new Map(games.filter((game) => game.event_slug && game.event_name)
    .map((game) => [game.event_slug!, { slug: game.event_slug!, name: game.event_name! }])).values()];
  const results = games.flatMap((game) => game.participants.filter((participant) => participant.streamer_id === person.id));
  const byId = new Map(people.map((streamer) => [streamer.id, streamer]));
  const pairs = topPairs.filter((pair) => !(pair.a_id === person.id && pair.b_id === opponentId)
    && !(pair.a_id === opponentId && pair.b_id === person.id))
    .map((pair) => ({ ...pair, a: byId.get(pair.a_id), b: byId.get(pair.b_id) }))
    .filter((pair) => pair.a && pair.b).slice(0, 3);
  return <aside className="arena-rail record-sidebar" aria-label="스트리머 정보">
    <section className="arena-panel">
      <h2>스트리머 정보</h2>
      <Link className="arena-profile-mini" href={`/fc/s/${person.slug}`}>
        <Avatar name={person.name} src={person.image} channelId={person.channel_id} />
        <span><strong>{person.name}</strong><small>FC 온라인 감독명 {person.nickname}</small></span>
      </Link>
      <div className="arena-mini-stats">
        <div><strong>{games.length}</strong><small>맞대결</small></div>
        <div><strong>{results.filter((result) => result.outcome === "win").length}</strong><small>승리</small></div>
        <div><strong>{events.length}</strong><small>참가 대회</small></div>
      </div>
      <Link className="arena-panel-link" href={`/fc/s/${person.slug}`}>개인 기록 보기　→</Link>
    </section>
    <section className="arena-panel">
      <h2>연결된 대회</h2>
      {events.length ? <ul className="fc-sidebar-events">{events.slice(0, 4).map((event) =>
        <li key={event.slug}>{eventHref(event.slug)
          ? <Link href={eventHref(event.slug)!}>{event.name} →</Link> : event.name}</li>)}</ul>
        : <p className="text-xs text-ink-400">확인해 연결한 대회 경기가 없습니다.</p>}
    </section>
    <section className="arena-panel">
      <h2>핵심 선수 <small className="record-sidebar-note">시세 TOP 5</small></h2>
      <p className="text-xs text-ink-400">선수 시세 데이터가 연결되면 가격순 TOP 5가 표시됩니다.</p>
    </section>
    <section className="arena-panel arena-pairs-sidebar">
      <h2>자주 만난 매치업 <small className="record-sidebar-note">경기 기준</small></h2>
      {pairs.length ? <ul className="arena-pair-list">{pairs.map((pair) => {
        const { a, b } = pair;
        if (!a || !b) return null;
        return <li key={`${pair.a_id}:${pair.b_id}`}><Link className="arena-pair-row"
          href={`${VERSUS_PATH}?a=${encodeURIComponent(a.slug)}&b=${encodeURIComponent(b.slug)}`}
          aria-label={`${a.name} 대 ${b.name} · ${pair.a_wins}승 ${pair.draws}무 ${pair.b_wins}패`}>
          <span className="arena-pair-person"><Avatar name={a.name} src={a.image} channelId={a.channel_id} /><span title={a.name}>{a.name}</span></span>
          <span className="arena-pair-score"><strong data-leading={pair.a_wins > pair.b_wins}>{pair.a_wins}</strong><span>:</span><strong data-leading={pair.b_wins > pair.a_wins}>{pair.b_wins}</strong></span>
          <span className="arena-pair-person"><Avatar name={b.name} src={b.image} channelId={b.channel_id} /><span title={b.name}>{b.name}</span></span>
        </Link></li>;
      })}</ul> : <p className="text-xs text-ink-400">아직 다른 맞대결 기록이 없습니다.</p>}
    </section>
  </aside>;
}
