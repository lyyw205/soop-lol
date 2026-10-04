/**
 * FC 대회 상세. 롤 대회 상세의 틀(빵부스러기 → 히어로 → 탭 → 본문+사이드)을 그대로 쓰고,
 * 내용은 FC 사실에 맞게 바꾼다:
 *   대진표·결승·최종 순위 → 공통 대진(core 계산 + packages/ui/bracket). 대진이 없는 대회는 마지막 경기 카드만
 *     (결승이라는 근거가 없으면 결승이라 부르지 않는다)
 *   우승팀 로스터 → 하이라이트 + 상대 전적표 (1:1 대회라 "누가 누구를 이겼나"가 본론이다)
 *   경기 목록 + 참가자 필터 / 참가 팀 → 참가자 기록
 *   챔피언 픽 → 선수 카드 기록
 */
import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import { ArrowRight, ChevronRight, Flag, Target, Trophy, Zap, Star } from "lucide-react";
import {
  fcMatchHref, FCO_MODE_LABEL, profileHref, type FcoClubAccountSummary, type FcoEvent, type FcoGame,
} from "@soop-lol/core/lib/contract";
import { PlayersTable } from "./players-table.tsx";
import {
  cardRecords, entrants, headToHead, highlights, isLevelDecided, MIN_RATED_GAMES, outcomeLabel, sideScore,
  type CardRecord, type Entrant, type Highlights,
} from "./model.ts";
import { MatchBoard, MatchCard, type BoardMatch } from "./match-board.tsx";
import { FcoSeriesSummary } from "./fco-series.tsx";
import {
  DETAIL_TABS, eventHref, eventPeriod, Facts, kstTime, Panel, Person, playedWindow, SafeExternal,
  SectionHeading, TournamentHero, type DetailTab,
} from "./shared.tsx";
import { tournamentsIndexHref } from "./paths.ts";
import { BracketBoard } from "../../../ui/bracket/bracket-board.tsx";
import { BracketPlacements } from "../../../ui/bracket/placements.tsx";
import { placementNote, type BoardModel, type BoardSlot } from "../../../ui/bracket/bracket-model.ts";

/** 승부차기 점수(넥슨 shoot.shootOutScore). 0:0 은 승부차기가 없었던 것이라 호출부가 동점 경기에만 쓴다. */
const shootoutOf = (p: FcoGame["participants"][number]) => {
  const shoot = p.match_info.shoot;
  const n = shoot && typeof shoot === "object" ? (shoot as Record<string, unknown>).shootOutScore : null;
  return typeof n === "number" ? n : null;
};
const modeLabel = (game: FcoGame) => FCO_MODE_LABEL[game.mode_key ?? ""] ?? `모드 ${game.mode_key ?? "미상"}`;
const gd = (e: Entrant) => e.goalsFor - e.goalsAgainst;
const signed = (n: number) => (n > 0 ? `+${n}` : String(n));
/** 선수 카드 표를 처음에 몇 줄까지 펼쳐 두나. 전부 펼치면 수백 줄이라 페이지가 무너진다. */
const CARD_ROWS = 15;

interface View {
  event: FcoEvent;
  games: FcoGame[];
  people: Entrant[];
  cards: CardRecord[];
  highlights: Highlights;
  names: Map<number, string>;
  board: BoardMatch[];
  /** 공통 대진. 대진을 등록하지 않은 대회는 null */
  bracket: BoardModel | null;
}

export function DetailView({ event, games, people: info, names, tab, bracket, clubs }: {
  event: FcoEvent;
  games: FcoGame[];
  people: Map<string, { image: string | null; channel_id: string | null }>;
  names: Map<number, string>;
  tab: string;
  bracket: BoardModel | null;
  /** 스트리머 id → 현재 구단 정보(참가자 탭에서만 불러온다) */
  clubs: Map<string, FcoClubAccountSummary>;
}) {
  const people = entrants(games, info);
  const cards = cardRecords(games);
  const byKey = new Map(people.map((p) => [p.key, p]));
  const board: BoardMatch[] = games.map((g, i) => ({
    id: g.id, href: fcMatchHref(g.provider_id), no: i + 1, time: kstTime(g.played_at), mode: modeLabel(g),
    levelDecided: isLevelDecided(g),
    series: g.series_id ? `시리즈 ${g.series_game_no ?? "?"}세트` : null,
    sides: g.participants.map((p) => {
      const e = p.streamer_id ? byKey.get(p.streamer_id) : undefined;
      return {
        key: p.streamer_id ?? p.ouid, name: p.streamer_name ?? p.nickname,
        image: e?.image ?? null, channelId: e?.channelId ?? null, score: sideScore(p), outcome: p.outcome,
        shootout: isLevelDecided(g) ? shootoutOf(p) : null,
      };
    }),
  }));
  const view: View = { event, games, people, cards, highlights: highlights(games, people, cards), names, board, bracket };
  // 대진이 있으면 경기는 대진표가 보여준다(번호도 주최측 번호 하나로). 대진이 없으면 경기 탭이 유일한 대진 정보다.
  const tabs = DETAIL_TABS.filter(([key]) => (key === "bracket" ? bracket : key === "matches" ? !bracket : true));
  const active: DetailTab = tabs.some(([key]) => key === tab) ? tab as DetailTab : "overview";
  const goals = games.reduce((n, g) => n + g.participants.reduce((m, p) => m + (sideScore(p) ?? 0), 0), 0);

  return <>
    <div className="ft-breadcrumb">
      <Link href={tournamentsIndexHref()}>대회</Link>
      <ChevronRight size={12} />
      <span>{event.name}</span>
    </div>
    <TournamentHero event={event} games={games} numbers={{ people: people.length, games: games.length, goals }}
      champion={bracket?.champion ?? null} />
    <nav className="ft-detail-tabs" aria-label="대회 상세 메뉴">
      {tabs.map(([key, label]) => <Link key={key} href={eventHref(event.slug, key)} scroll={false}
        aria-current={active === key ? "page" : undefined}>
        {label}
        {key === "matches" && <small>{games.length}</small>}
        {key === "players" && <small>{people.length}</small>}
      </Link>)}
    </nav>
    <div className="ft-content">
      {games.length === 0
        ? <div className="ft-empty"><h2>이 대회에 연결된 경기가 아직 없어요</h2><p>경기 맥락 조사로 대회에 연결한 경기부터 이곳에 기록됩니다.</p></div>
        : active === "overview" ? <Overview view={view} />
        : active === "bracket" && bracket ? <BracketTab view={view} bracket={bracket} />
        : active === "matches" ? <Matches view={view} />
        : active === "players" ? <Players view={view} clubs={clubs} />
        : <Records view={view} />}
    </div>
  </>;
}

/* ── 개요 ─────────────────────────────────────────────────────────── */

function Overview({ view }: { view: View }) {
  const last = view.board.at(-1)!;
  // 대진이 있으면 1·2위를 정하는 칸이 결승이다. 없으면 마지막 경기만 보인다.
  const final = view.bracket?.lanes.flatMap((l) => l.slots).find((s) => s.loserRank === "2위") ?? null;
  return <div className="ft-overview-grid">
    <div className="ft-overview-main">
      {final ? <FinalSlot slot={final} view={view} /> : <LastMatch match={last} view={view} />}
      <HighlightTiles view={view} />
      <section className="ft-section">
        <SectionHeading title="상대 전적표" subtitle="가로줄 참가자 입장에서 본 결과 · 칸을 누르면 그 경기로 이동합니다."
          action={<Link className="ft-text-link" href={eventHref(view.event.slug, view.bracket ? "bracket" : "matches")}>{view.bracket ? "대진표" : "경기 전체"} <ArrowRight size={14} /></Link>} />
        <HeadToHead view={view} />
      </section>
    </div>
    <aside className="ft-overview-sidebar">
      {view.bracket ? <section>
        <SectionHeading title="최종 순위" subtitle="공식 발표 우선 · 없으면 대진 규칙으로 계산"
          action={<Link className="ft-text-link" href={eventHref(view.event.slug, "bracket")}>대진표 <ArrowRight size={14} /></Link>} />
        <BracketPlacements placements={view.bracket.placements} profileHref={(slug) => profileHref("fconline", slug)} />
      </section> : <Standings view={view} />}
      <EventFacts view={view} />
      <Sources event={view.event} />
    </aside>
  </div>;
}

/** 대진의 결승 칸. 경기 기록이 없을 수 있다(현장 계정) — 그때는 채택 결과의 출처를 보인다. */
function FinalSlot({ slot, view }: { slot: BoardSlot; view: View }) {
  const [a, b] = slot.sides;
  const winner = slot.sides.find((s) => s.won)?.entrant;
  return <div className="ft-final">
    <div className="ft-final-top">
      <span><Trophy size={14} /> GRAND FINAL</span>
      <span>{slot.title}{slot.bestOf && slot.bestOf > 1 ? ` · ${slot.bestOf}판 ${Math.floor(slot.bestOf / 2) + 1}선승` : ""}</span>
    </div>
    <div className="ft-final-score">
      {[a, b].map((side, i) => {
        const e = side?.entrant;
        const rec = e ? view.people.find((p) => p.slug === e.slug) : undefined;
        return <div className={`ft-final-side ${side?.won ? "ft-final-side-win" : ""}`} key={e?.id ?? i}>
          <Person entrant={{ name: e?.name ?? "미정", image: e?.image ?? null, channelId: e?.channelId ?? null }} size="lg" />
          <strong>{e?.slug ? <Link href={profileHref("fconline", e.slug)}>{e.name}</Link> : e?.name ?? "미정"}</strong>
          <small>{side?.won ? "우승" : e ? "준우승" : ""}{rec ? ` · 기록된 경기 ${rec.wins}승 ${rec.draws}무 ${rec.losses}패` : ""}</small>
        </div>;
      })}
      <div className="ft-final-numbers">
        <small>{winner ? `CHAMPION · ${winner.name}` : "결과 미확인"}</small>
        <b>{a?.score ?? "–"}<em>:</em>{b?.score ?? "–"}</b>
        <span>{a?.score == null ? "세트 점수 미확인" : "SET SCORE"}</span>
      </div>
    </div>
    <div className="ft-final-foot">
      <span>{slot.badge ? `${slot.badge} · ` : ""}{slot.games ? `경기 기록 ${slot.games}판` : "넥슨 경기 기록 없음"} — {slot.evidence}</span>
      {slot.href && <Link href={slot.href}>경기 상세 <ArrowRight size={13} /></Link>}
    </div>
  </div>;
}

function BracketTab({ view, bracket }: { view: View; bracket: BoardModel }) {
  const inBracket = new Set(bracket.lanes.flatMap((l) => l.slots).flatMap((s) => s.matchIds));
  const outside = view.board.filter((m) => !inBracket.has(m.id));
  const inferred = bracket.lanes.flatMap((l) => l.slots).filter((s) => s.badge === "추론" || s.badge === "기록 없음").sort((a, b) => a.no - b.no);
  return <>
    <SectionHeading title="대진표" subtitle="주최측 브래킷 그대로 · 승자/패자가 어디로 가는지 선으로 표시합니다" />
    <div className="ft-bracket">
      <BracketBoard model={bracket} />
    </div>
    {inferred.length > 0 && <p className="ft-data-note ft-bracket-note">
      넥슨 기록이 없는 칸 {inferred.map((s) => `${s.no}경기`).join(" · ")}은(는) 다음 경기에 누가 나왔는지로 승자를 추론했습니다(「추론」 표시).
      추론을 거쳐 정해진 순위에는 「일부 경기 결과 추론」을 함께 적습니다.
    </p>}
    {outside.length > 0 && <section className="ft-section">
      <SectionHeading title="대진 밖 경기" subtitle={`이 대회에 연결됐지만 대진표 칸에 들어가지 않은 경기 ${outside.length}판 — 번외·이벤트 경기 등`} />
      <div className="ft-match-grid">{outside.map((m) => <MatchCard key={m.id} match={m} />)}</div>
    </section>}
  </>;
}

function LastMatch({ match, view }: { match: BoardMatch; view: View }) {
  const winner = match.sides.find((s) => s.outcome === "win");
  return <div className="ft-final">
    <div className="ft-final-top">
      <span><Flag size={14} /> LAST MATCH</span>
      <span>{match.no}경기 · {match.time} · {match.mode}</span>
    </div>
    <div className="ft-final-score">
      {match.sides.slice(0, 2).map((side, i) => {
        const e = view.people.find((p) => p.key === side.key);
        return <div className={`ft-final-side ${side.outcome === "win" ? "ft-final-side-win" : ""}`} key={side.key + i}>
          <Person entrant={{ name: side.name, image: side.image, channelId: side.channelId }} size="lg" />
          <strong>{e?.slug ? <Link href={profileHref("fconline", e.slug)}>{side.name}</Link> : side.name}</strong>
          <small>{e ? `대회 ${e.wins}승 ${e.draws}무 ${e.losses}패` : "미연결 계정"}</small>
        </div>;
      })}
      <div className="ft-final-numbers">
        <small>{winner ? `${winner.name} 승` : "결과 미확인"}</small>
        <b>{match.sides[0]?.score ?? "?"}<em>:</em>{match.sides[1]?.score ?? "?"}</b>
        <span>{match.levelDecided ? "동점 승부" : "FINAL SCORE"}</span>
      </div>
    </div>
    <div className="ft-final-foot">
      <span>이 대회에서 마지막으로 기록된 경기입니다. 결승 여부는 기록에 없어 표시하지 않습니다.</span>
      <Link href={match.href}>경기 상세 <ArrowRight size={13} /></Link>
    </div>
  </div>;
}

function HighlightTiles({ view }: { view: View }) {
  const h = view.highlights;
  const tiles: { icon: ReactNode; label: string; value: string; sub: string; href?: string }[] = [];
  if (h.topScorer) tiles.push({
    icon: <Target size={15} />, label: "최다 득점", value: h.topScorer.name,
    sub: `${h.topScorer.goalsFor}골 · ${h.topScorer.games}경기`,
    href: h.topScorer.slug ? profileHref("fconline", h.topScorer.slug) : undefined,
  });
  if (h.highestScoring) {
    const [a, b] = h.highestScoring.game.participants;
    tiles.push({
      icon: <Zap size={15} />, label: "최다 골 경기", value: `${h.highestScoring.total}골`,
      sub: `${a?.streamer_name ?? a?.nickname} ${sideScore(a)} : ${sideScore(b)} ${b?.streamer_name ?? b?.nickname}`,
      href: fcMatchHref(h.highestScoring.game.provider_id),
    });
  }
  if (h.biggestWin) {
    const w = h.biggestWin.game.participants.find((p) => p.outcome === "win") ?? h.biggestWin.game.participants[0];
    const l = h.biggestWin.game.participants.find((p) => p !== w);
    tiles.push({
      icon: <Trophy size={15} />, label: "최다 점수차 승리", value: `${h.biggestWin.margin}골 차`,
      sub: `${w?.streamer_name ?? w?.nickname} ${sideScore(w)} : ${sideScore(l)} ${l?.streamer_name ?? l?.nickname}`,
      href: fcMatchHref(h.biggestWin.game.provider_id),
    });
  }
  if (h.topCard) tiles.push({
    icon: <Star size={15} />, label: "최다 득점 선수", value: cardName(view, h.topCard),
    sub: `${h.topCard.goals}골 ${h.topCard.assists}도움 · ${h.topCard.streamer}`,
  });
  if (!tiles.length) return null;
  return <div className="ft-highlights">
    {tiles.map((t) => {
      const body = <><span className="ft-highlight-label">{t.icon}{t.label}</span><strong>{t.value}</strong><small>{t.sub}</small></>;
      return t.href
        ? <Link key={t.label} className="ft-highlight" href={t.href}>{body}</Link>
        : <div key={t.label} className="ft-highlight">{body}</div>;
    })}
  </div>;
}

function HeadToHead({ view }: { view: View }) {
  const matrix = headToHead(view.games);
  const people = view.people;
  if (people.length < 2) return <p className="ft-footnote">전적표를 그릴 만큼 연결된 참가자가 없습니다.</p>;
  return <div className="ft-table-scroll" role="region" tabIndex={0} aria-label="참가자 상대 전적표">
    <table className="ft-h2h">
      <thead><tr>
        <th scope="col"><span className="sr-only">참가자</span></th>
        {people.map((p) => <th scope="col" key={p.key} title={p.name}><span className="ft-h2h-colname">{p.name}</span></th>)}
        <th scope="col">합계</th>
      </tr></thead>
      <tbody>{people.map((row) => <tr key={row.key}>
        <th scope="row"><span className="ft-h2h-rowname"><Person entrant={row} size="sm" /><span>{row.name}</span></span></th>
        {people.map((col) => {
          if (col.key === row.key) return <td key={col.key} className="ft-h2h-self" aria-label="같은 참가자" />;
          const results = matrix.get(row.key)?.get(col.key) ?? [];
          if (!results.length) return <td key={col.key} className="ft-h2h-none">—</td>;
          return <td key={col.key}>
            {results.map((r) => <Link key={r.gameId} href={fcMatchHref(r.providerId)} className={`ft-h2h-cell ft-o-${r.outcome}`}
              aria-label={`${row.name} ${r.own ?? "?"} 대 ${r.rival ?? "?"} ${col.name}, ${outcomeLabel(r.outcome)}`}>
              <b>{r.own ?? "?"}:{r.rival ?? "?"}</b><i>{outcomeLabel(r.outcome)}</i>
            </Link>)}
          </td>;
        })}
        <td className="ft-h2h-total">{row.wins}승 {row.draws}무 {row.losses}패</td>
      </tr>)}</tbody>
    </table>
  </div>;
}

function Standings({ view }: { view: View }) {
  return <section className="ft-standings">
    <SectionHeading title="참가자 기록" subtitle={`${view.people.length}명 · 이름순 · 순위 아님`}
      action={<Link className="ft-text-link" href={eventHref(view.event.slug, "players")}>자세히 <ArrowRight size={14} /></Link>} />
    <ol className="ft-standings-list">
      {view.people.map((p) => <li key={p.key}>
        <Link className="ft-standings-row" href={p.slug ? profileHref("fconline", p.slug) : eventHref(view.event.slug, "players")}>
          <Person entrant={p} />
          <span className="ft-standings-details">
            <strong>{p.name}</strong>
            <small>{p.wins}승 {p.draws}무 {p.losses}패 · 득실 {signed(gd(p))}</small>
          </span>
          <ChevronRight size={14} />
        </Link>
      </li>)}
    </ol>
  </section>;
}

function EventFacts({ view }: { view: View }) {
  const { event, games } = view;
  const modes = [...new Set(games.map(modeLabel))];
  const series = new Set(games.map((g) => g.series_id).filter(Boolean)).size;
  const period = eventPeriod(event, games);
  return <Panel title="대회 한눈에">
    <Facts rows={[
      ["기간", period.text],
      ["경기 시간", playedWindow(games) ?? "—"],
      ["주최", event.organizer ?? "미확인"],
      ["참가", `${view.people.length}명`],
      ["모드", modes.join(" · ") || "—"],
      ["기록", `${games.length}경기${series ? ` · 다전제 ${series}개` : ""}`],
    ]} />
  </Panel>;
}

function Sources({ event }: { event: FcoEvent }) {
  return <Panel title="출처" className="ft-sources">
    <SafeExternal href={event.source_url}>대회 출처</SafeExternal>
    <p className="ft-footnote">경기 결과·지표는 넥슨 Open API 기록이고, 대회 연결은 방송·공지를 근거로 조사해 붙인 것입니다.</p>
  </Panel>;
}

/* ── 경기 ─────────────────────────────────────────────────────────── */

function Matches({ view }: { view: View }) {
  const hasSeries = view.games.some((g) => g.series_id);
  return <>
    <SectionHeading title="경기" subtitle={`${view.games.length}경기 · 기록된 순서`} />
    <MatchBoard matches={view.board} people={view.people.map((p) => ({ key: p.key, name: p.name }))} />
    {hasSeries && <section className="ft-section">
      <SectionHeading title="다전제" subtitle="세트를 한 판으로 접어 시리즈 승패를 봅니다. 형식(3판 2선승 등)은 근거로 확인한 것만 표기합니다." />
      <FcoSeriesSummary games={view.games} />
    </section>}
  </>;
}

/* ── 참가자 ───────────────────────────────────────────────────────── */

function Players({ view, clubs }: { view: View; clubs: Map<string, FcoClubAccountSummary> }) {
  // 대회 순위는 대진표의 최종 순위(참가 단위 = 1인 팀 → 그 사람의 slug 로 잇는다)
  const places = new Map((view.bracket?.placements ?? []).filter((x) => x.entrant.slug).map((x) => [x.entrant.slug!, x]));
  const rows = view.people.map((p) => {
    const c = clubs.get(p.key);
    const place = p.slug ? places.get(p.slug) : undefined;
    return {
      rank: place?.rank && place.min != null ? { min: place.min, text: place.rank, note: placementNote(place) } : null,
      key: p.key, name: p.name, href: p.slug ? profileHref("fconline", p.slug) : null, image: p.image, channelId: p.channelId,
      games: p.games, wins: p.wins, draws: p.draws, losses: p.losses, goalsFor: p.goalsFor, goalsAgainst: p.goalsAgainst, form: p.form,
      club: c ? { club_value: c.club_value, captured_at: c.captured_at, teamColors: c.teamColors, rating: c.rating } : null,
    };
  });
  return <>
    <SectionHeading title="참가자 기록" subtitle={`${view.people.length}명 · ${view.bracket ? "대회 순위순" : "이름순"} · 헤더를 눌러 정렬`} />
    <PlayersTable rows={rows} />
    <p className="ft-footnote">
      대회 기록(경기·승무패·득실)은 이 대회 경기만 셉니다. 득점·실점은 경기 화면 점수 기준이고, 연결되지 않은 상대 계정은 집계에서 뺍니다.
      팀컬러·구단가치·이번 시즌 점수는 <b>지금</b> 넥슨 공식 홈페이지 값이며 대회 당시 값이 아닙니다(마우스를 올리면 조회 시각).
    </p>
  </>;
}

/* ── 기록실 ───────────────────────────────────────────────────────── */

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");
const cardName = (view: View, c: CardRecord) => view.names.get(c.playerId) ?? `선수 ${c.playerId}`;

function Records({ view }: { view: View }) {
  const [shown, rest] = [view.cards.slice(0, CARD_ROWS), view.cards.slice(CARD_ROWS)];
  const bestRated = view.highlights.bestRated;
  const cardRow = (c: CardRecord, i: number) => <tr key={c.key}>
    <td>{i + 1}</td>
    <th scope="row">{cardName(view, c)}</th>
    <td>{c.slug ? <Link href={profileHref("fconline", c.slug)}>{c.streamer}</Link> : c.streamer}</td>
    <td>{c.games}</td><td>{c.goals}</td><td>{c.assists}</td>
    <td>{c.rated ? (c.ratingSum / c.rated).toFixed(1) : "—"}</td>
    <td>{pct(c.passes, c.passTry)}</td>
  </tr>;
  const cardHead = <thead><tr><th>#</th><th>선수</th><th>사용한 스트리머</th><th>출전</th><th>골</th><th>도움</th><th>평균 평점</th><th>패스 성공</th></tr></thead>;
  return <>
    <SectionHeading title="대회 기록실" subtitle="이 대회에 연결된 경기만 집계합니다 · 경기가 늘면 기록도 갱신됩니다" />
    <HighlightTiles view={view} />
    <section className="ft-section">
      <Panel title="참가자 경기 지표">
        <div className="ft-table-scroll">
          <table className="ft-table">
            <thead><tr><th>참가자</th><th>경기</th><th>승-무-패</th><th>득점</th><th>슛</th><th>유효 슛</th><th>패스 성공</th><th>평균 점유율</th><th>태클 성공</th></tr></thead>
            <tbody>{view.people.map((p) => <tr key={p.key}>
              <th scope="row"><span className="ft-table-person"><Person entrant={p} size="sm" />
                {p.slug ? <Link href={profileHref("fconline", p.slug)}>{p.name}</Link> : p.name}</span></th>
              <td>{p.games}</td><td>{p.wins}-{p.draws}-{p.losses}</td><td>{p.goalsFor}</td>
              <td>{p.stats.shots}</td><td>{p.stats.shotsOnTarget} <small>({pct(p.stats.shotsOnTarget, p.stats.shots)})</small></td>
              <td>{pct(p.stats.passSuccess, p.stats.passTry)}</td>
              <td>{p.stats.games ? `${Math.round(p.stats.possessionTotal / p.stats.games)}%` : "—"}</td>
              <td>{p.stats.tackles}</td>
            </tr>)}</tbody>
          </table>
        </div>
      </Panel>
    </section>
    <section className="ft-section">
      <Panel title="선수 카드 기록">
        <p className="ft-data-note">
          같은 선수라도 쓴 스트리머가 다르면 다른 줄입니다 · 골 → 도움 → 출전 순
          {bestRated && <> · 평균 평점 1위(출전 {MIN_RATED_GAMES}경기 이상) <b>{cardName(view, bestRated)}</b> {(bestRated.ratingSum / bestRated.rated).toFixed(1)} · {bestRated.streamer}</>}
        </p>
        {view.cards.length ? <div className="ft-table-scroll">
          <table className="ft-table">{cardHead}<tbody>{shown.map(cardRow)}</tbody></table>
          {rest.length > 0 && <details className="ft-more">
            <summary>나머지 {rest.length}줄 펼치기</summary>
            <table className="ft-table">{cardHead}<tbody>{rest.map((c, i) => <Fragment key={c.key}>{cardRow(c, i + CARD_ROWS)}</Fragment>)}</tbody></table>
          </details>}
        </div> : <p className="ft-footnote">선수 기록이 있는 경기가 없습니다.</p>}
      </Panel>
    </section>
  </>;
}
