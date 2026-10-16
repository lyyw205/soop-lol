import { eventKindLabel } from "@soop-lol/core/lib/contract";
import Link from "next/link";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import { listFcoPeople, listFcoRecentEvents } from "@soop-lol/core/lib/db/fconline";
import { getEventBracket } from "@soop-lol/core/lib/db/event-bracket";
import { fcoEventResult, type FcoEventResult } from "@soop-lol/core/lib/games/fconline/event-result";
import { listFcoClubBoard } from "@soop-lol/core/lib/db/fconline-club";
import { formatWon, change7d } from "@soop-lol/core/lib/metrics/club-value";
import { kstDateString } from "@soop-lol/core/lib/time";
import { profileHref, recordSearchHref } from "@soop-lol/core/lib/site-paths";
import { Avatar } from "@/components/avatar";
import { SiteLogo } from "@/components/site-logo";
import { fcTournamentHref, fcTournamentsIndexHref, roleHref } from "@/lib/module-links";
import { ClubMovers, HomeMotion, HomeSearch, type HomeClub } from "./home-interactions";
import "./home.css";

export const metadata = { title: { absolute: "FC 온라인 · SOOP SEEK" } };
export const dynamic = "force-dynamic";

const datePart = (value: string, options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", ...options }).format(new Date(value));
const compactValue = (value: number) => (value / 1e8).toLocaleString("ko-KR", { maximumFractionDigits: 0 });

function SectionHeading({ id, index, title, href }: { id: string; index: string; title: string; href: string }) {
  return <div className="fh-section-heading" data-reveal>
    <h2 id={id}><span>{index}</span>{title}</h2>
    <Link href={href}>전체 보기 <ArrowRight size={18} aria-hidden="true" /></Link>
  </div>;
}

function EventResult({ result }: { result: FcoEventResult | null }) {
  if (!result) return <div className="fh-event-result fh-event-result-pending">
    <span>종합 결과 미확인</span><b aria-hidden="true">— <em>:</em> —</b>
  </div>;
  return <div className="fh-event-result"><span>{result.label}</span><div className="fh-matchup">
    {result.sides.map((side) => <div className="fh-match-person" key={side.id} data-winner={side.won}>
      <span className="fh-team-avatars" aria-hidden="true">{side.members.slice(0, 3).map((person, i) =>
        <Avatar key={i} name={person.name} src={person.image} channelId={person.channelId} />)}</span>
      <span title={side.name}>{side.name}</span><b>{side.score}</b>{side.won && <small>승</small>}
    </div>)}
  </div></div>;
}

export default async function FcHome() {
  const today = kstDateString(new Date());
  const clubHref = roleHref("fc-club-value");
  const eventsHref = fcTournamentsIndexHref();
  const [people, board, events] = await Promise.all([
    listFcoPeople(),
    clubHref ? listFcoClubBoard() : Promise.resolve([]),
    eventsHref ? listFcoRecentEvents(5) : Promise.resolve([]),
  ]);
  const clubs: HomeClub[] = board.flatMap((person) => {
    const href = roleHref("fc-club-value", {}, { s: person.slug });
    const { account } = person;
    if (!href || !account.rank_eligible || account.club_value === null) return [];
    return [{
      id: person.id, name: person.name, image: person.image, channelId: person.channel_id,
      nickname: account.nickname, href, value: account.club_value,
      ...change7d(account.history, today),
      capturedAt: account.captured_at ? new Date(account.captured_at).toISOString() : null,
    }];
  }).sort((a, b) => b.value - a.value || a.name.localeCompare(b.name, "ko"));
  const up = clubs.filter((p) => p.change && p.change.delta > 0).sort((a, b) => b.change!.delta - a.change!.delta)[0] ?? null;
  const down = clubs.filter((p) => p.change && p.change.delta < 0).sort((a, b) => a.change!.delta - b.change!.delta)[0] ?? null;
  const leaders = clubs.slice(0, 5);
  const latestCapture = clubs.map((p) => p.capturedAt).filter((d): d is string => !!d).sort().at(-1);
  const peopleById = new Map(people.map((p) => [p.id, p]));
  const quickPeople = [...new Map([
    ...leaders.map((p) => peopleById.get(p.id)), ...people,
  ].filter((p) => p !== undefined).map((p) => [p.id, p])).values()].slice(0, 4);
  const recent = await Promise.all(events.map(async (event) => ({
    event, href: fcTournamentHref(event.slug), result: fcoEventResult(await getEventBracket(event.id)),
  })));

  return <HomeMotion>
    <section className="fh-hero" aria-labelledby="fh-title">
      <div className="fh-stadium" aria-hidden="true"><div className="fh-stadium-image" /></div>
      <div className="fh-light-sweep" aria-hidden="true" />
      <div className="fh-container fh-hero-inner">
        <div className="fh-hero-edition"><span><i /> SOOP / FOOTBALL</span><span>STREAMER RECORDS</span></div>
        <div className="fh-hero-main">
          <h1 id="fh-title" className="fh-masthead" aria-label="FC ONLINE"><span>FC</span><span>ONLINE<span className="fh-title-dot">.</span></span></h1>
          <div className="fh-hero-side" aria-hidden="true"><span>FC ONLINE</span><div className="fh-reticle"><i /><i /></div><span>STREAMER RECORDS</span></div>
        </div>
        <div className="fh-hero-search">
          <HomeSearch people={people} />
          <div className="fh-quick-people" aria-label="스트리머 바로가기">
            {quickPeople.map((person) => <Link key={person.id} href={profileHref("fconline", person.slug)}>
              <Avatar name={person.name} src={person.image} channelId={person.channel_id} /><span>{person.name}</span>
            </Link>)}
          </div>
        </div>
        <Link className="fh-hero-count" href={recordSearchHref("fconline")} aria-label={`등록 스트리머 ${people.length}명 전체 보기`}>
          <span><b>{people.length.toString().padStart(2, "0")}</b><small>STREAMERS</small></span><ArrowUpRight size={24} aria-hidden="true" />
        </Link>
      </div>
    </section>

    <div className="fh-container fh-content">
      {clubHref && <section className="fh-market" id="club-value" aria-labelledby="fh-club-heading">
        <SectionHeading id="fh-club-heading" index="01" title="구단가치" href={clubHref} />
        <div className="fh-market-grid">
          <ClubMovers up={up} down={down} />
          <div className="fh-ranking" data-reveal>
            <div className="fh-ranking-heading"><h3>구단가치 <span>TOP {leaders.length || 5}</span></h3><span>BP</span></div>
            {leaders.map((person, i) => <Link key={person.id} href={person.href} className="fh-rank-row">
              <span className="fh-rank-number">{String(i + 1).padStart(2, "0")}</span>
              <Avatar name={person.name} src={person.image} channelId={person.channelId} />
              <span className="fh-rank-name"><b>{person.name}</b><small>{person.nickname}</small></span>
              <strong title={`${formatWon(person.value)} BP`}>{compactValue(person.value)}<small>억</small></strong>
              <ArrowUpRight size={18} aria-hidden="true" />
            </Link>)}
            {!leaders.length && <p className="fh-empty">아직 수집된 구단가치가 없습니다.</p>}
          </div>
        </div>
        <div className="fh-source"><span>대표 계정 · 최근 7일 내 수집분 기준</span>{latestCapture && <span>최근 수집 <time dateTime={latestCapture}>{new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(latestCapture))}</time></span>}</div>
      </section>}

      {eventsHref && <section className="fh-history" id="recent-events" aria-labelledby="fh-events-heading">
        <SectionHeading id="fh-events-heading" index={clubHref ? "02" : "01"} title="최근 CK · 대회" href={eventsHref} />
        <div className="fh-events">{recent.map(({ event, result, href }, i) => href && <Link className="fh-event" key={event.id} href={href} data-reveal>
          <time className="fh-event-date" dateTime={new Date(event.last_played_at).toISOString()} aria-label={new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "long" }).format(new Date(event.last_played_at))}>
            <span>{datePart(event.last_played_at, { year: "numeric" })}</span><b>{datePart(event.last_played_at, { month: "long", day: "numeric" })}</b>
          </time>
          <div className="fh-event-info">
            <div className="fh-event-tags"><span>{eventKindLabel(event.kind)}</span>{i === 0 && <span className="fh-latest">LATEST</span>}</div>
            <h3>{event.name.replace(/\s*\(\d{4}-\d{2}-\d{2}\)\s*$/, "")}</h3>
          </div>
          <EventResult result={result} />
          <ArrowUpRight className="fh-event-arrow" size={24} aria-hidden="true" />
        </Link>)}</div>
        {!recent.length && <p className="fh-empty">아직 등록된 CK·대회가 없습니다.</p>}
      </section>}
      <div className="fh-endmark" aria-hidden="true"><SiteLogo /><span className="fh-endmark-line" /><span>●</span></div>
    </div>
  </HomeMotion>;
}
