"use client";
import Link from "next/link";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowRight,
  ChevronRight,
  Trophy,
  Sparkles,
  X,
  Users,
} from "lucide-react";
import {
  laneDuels,
  tournamentHighlights,
  tournamentPlayerRecords,
  type TournamentDetail,
  type TournamentSeries,
  type TournamentTeam,
} from "../server/tournament.ts";
import {
  championById,
  championIconPath,
  kstPlayedAt,
  placementRank,
  profileHref,
} from "@soop-lol/core/lib/contract/client";
import { tournamentsIndexHref } from "./paths.ts";
import { Avatar } from "../../../ui/avatar.tsx";
import { TeamLogo } from "./team-logo.tsx";
import { MatchDetails } from "../../../ui/match-details.tsx";
import { BracketBoard } from "../../../ui/bracket/bracket-board.tsx";
import {
  TournamentHero,
  SectionHeading,
  SafeExternal,
  tournamentHref,
  period,
  positions,
  dotted,
  FEATURED_SLUG,
} from "./tournament-shared.tsx";

const tabs = [
  ["overview", "개요"],
  ["bracket", "대진표"],
  ["teams", "참가 팀"],
  ["records", "기록실"],
];
const score = (n: number | null) => n ?? "—";
const stageLabel = (placement: string | null | undefined) => {
  if (!placement) return null;
  if (placement === "우승" || placement === "1위") return "우승";
  if (placement === "준우승" || placement === "2위") return "준우승";
  if (/^(3위|4위|3[–-]4위|4강)$/.test(placement)) return "4강";
  if (placement.includes("예선")) return "예선";
  if (placement.includes("본선") || /^[5-9]/.test(placement)) return "본선";
  return placement;
};
const rankedTeams = (data: TournamentDetail) =>
  [...data.teams].sort((a, b) => {
    const rank = (t: TournamentTeam) => t.rank ?? placementRank(t.placement) ?? 99;
    return rank(a) - rank(b);
  });
/**
 * 대회 안내 사실(수기, core event_fact)은 구역으로 나뉜다. 아래 셋은 각 탭이 제자리에 끼워 그리고,
 * 나머지 구역은 [대회 안내] 탭이 구역마다 표 하나로 그린다.
 */
const BRACKET_NOTE = "대진표 메모";
const ROSTER_NOTE = "참가 팀 메모";
const PLACED_SECTIONS = new Set([BRACKET_NOTE, ROSTER_NOTE]);
const multiline = (value: string): ReactNode =>
  value.split("\n").map((line, i) => <Fragment key={i}>{i > 0 && <br />}{line}</Fragment>);
function DataNotes({ data, section }: { data: TournamentDetail; section: string }) {
  return data.facts.filter((f) => f.section === section).map((f) => (
    <p className="tp-data-note" key={f.label}>{f.label} · {multiline(f.value)}</p>
  ));
}
function Panel({
  title,
  children,
  className = "",
  id,
}: {
  title: string;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section className={`tp-panel ${className}`} id={id}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}
function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="tp-facts">
      {rows.map(([name, value]) => (
        <div key={name}>
          <dt>{name}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
type OpenMatch = (match: TournamentSeries, index?: number) => void;

export function TournamentDetailView({
  data,
  tab,
}: {
  data: TournamentDetail;
  tab: string;
}) {
  const active = tabs.some(([key]) => key === tab) ? tab : "overview";
  const [selected, setSelected] = useState<{
    id: string;
    index: number;
  } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const match = data.series.find((s) => s.id === selected?.id);
  const current = match?.sets[selected?.index ?? 0];
  const open: OpenMatch = (s, index = 0) => setSelected({ id: s.id, index });
  useEffect(() => {
    if (selected && !dialog.current?.open) dialog.current?.showModal();
  }, [selected]);
  useEffect(() => {
    dialog.current?.close();
    setSelected(null);
  }, [active, data.event.slug]);
  return (
    <>
      <div className="tp-breadcrumb">
        <Link href={tournamentsIndexHref()}>대회</Link>
        <ChevronRight size={12} />
        <span>{data.event.name}</span>
      </div>
      <TournamentHero event={data.event} links={data.links} />
      <nav className="tp-detail-tabs" aria-label="대회 상세 메뉴">
        {tabs.map(([key, label]) => (
          <Link
            key={key}
            href={tournamentHref(data.event.slug, key)}
            scroll={false}
            aria-current={active === key ? "page" : undefined}
          >
            {label}
            {key === "teams" && <small>{data.teams.length}</small>}
          </Link>
        ))}
      </nav>
      <div className="tp-content">
        {active === "bracket" ? (
          <Bracket data={data} open={open} />
        ) : active === "teams" ? (
          <Teams data={data} />
        ) : active === "records" ? (
          <Records data={data} open={open} />
        ) : (
          <Overview data={data} open={open} />
        )}
      </div>
      <dialog
        className="tp-dialog"
        ref={dialog}
        onClose={() => setSelected(null)}
        onClick={(e) => {
          if (e.target !== dialog.current) return;
          const r = e.currentTarget.getBoundingClientRect();
          if (
            e.clientX < r.left ||
            e.clientX > r.right ||
            e.clientY < r.top ||
            e.clientY > r.bottom
          )
            e.currentTarget.close();
        }}
        aria-labelledby="tp-dialog-title"
      >
        {match && current && (
          <>
            <div className="tp-dialog-heading">
              <div>
                <p className="tp-eyebrow">
                  {match.round} · {dotted(match.date)}
                </p>
                <h2 id="tp-dialog-title">
                  {match.a}{" "}
                  <span>
                    {score(match.scoreA)} : {score(match.scoreB)}
                  </span>{" "}
                  {match.b}
                </h2>
              </div>
              <button
                type="button"
                className="tp-close"
                aria-label="경기 상세 닫기"
                onClick={() => dialog.current?.close()}
              >
                <X size={20} />
              </button>
            </div>
            <div className="tp-set-tabs" aria-label="세트 선택">
              {match.sets.map((s, index) => (
                <button
                  key={s.id}
                  type="button"
                  aria-pressed={current.id === s.id}
                  onClick={() => setSelected({ id: match.id, index })}
                >
                  {s.label}
                  {s.label === "세트" && <small> · 기록 {index + 1}</small>}
                </button>
              ))}
            </div>
            <div className="tp-set-meta">
              <span className="tp-chip">수기</span>
              <b>
                {current.winningSide === 100
                  ? current.blueName
                  : current.winningSide === 200
                    ? current.redName
                    : "승자 미확인"}
                {[100, 200].includes(current.winningSide ?? 0) ? " 승리" : ""}
              </b>
              <span>
                {current.duration != null
                  ? `${Math.floor(current.duration / 60)}:${String(current.duration % 60).padStart(2, "0")}`
                  : "시간 미수집"}
              </span>
            </div>
            <p className="tp-dialog-note">
              {kstPlayedAt(new Date(current.playedAt), current.precision)} · K /
              D / A{!match.orderKnown && " · 세트 순서 미확인"}
            </p>
            <MatchDetails
              key={current.id}
              sets={[
                {
                  matchId: current.id,
                  label: current.label,
                  players: current.players,
                },
              ]}
              streamerId=""
            />
            {current.players.some(
              (p) => p.kills == null || p.deaths == null || p.assists == null,
            ) && (
              <p className="tp-data-note">
                확인되지 않은 K/D/A는 — 로 표시하며 집계에서 제외합니다.
              </p>
            )}
            <div className="tp-dialog-footer">
              <SafeExternal href={current.sourceUrl ?? data.event.sourceUrl}>
                경기 결과 출처
              </SafeExternal>
              {data.links[0] && (
                <SafeExternal href={data.links[0].url}>{data.links[0].label}</SafeExternal>
              )}
            </div>
          </>
        )}
      </dialog>
    </>
  );
}
function EventFacts({ data }: { data: TournamentDetail }) {
  const e = data.event;
  return (
    <Panel title="대회 한눈에">
      <Facts
        rows={[
          ["기간", period(e)],
          ["주최", e.organizer ?? "미확인"],
          ["참가", `${e.teamCount}팀 기록`],
          ["수집 기록", `${e.seriesCount}경기 · ${e.setCount}세트`],
        ]}
      />
      {hasEventInfo(data) && (
        <a className="tp-panel-link" href="#tp-info">
          대회 정보 자세히
          <ArrowRight size={14} />
        </a>
      )}
    </Panel>
  );
}
function Sources({ data }: { data: TournamentDetail }) {
  return (
    <Panel title="공식 채널 & 출처" className="tp-sources">
      <SafeExternal href={data.event.sourceUrl}>대회 기록 출처</SafeExternal>
      {data.links.map((l) => (
        <SafeExternal key={l.url} href={l.url}>{l.label}</SafeExternal>
      ))}
      <p className="tp-footnote">
        수기 수집 기록 · 확인되지 않은 값은 표시하지 않습니다.
      </p>
    </Panel>
  );
}
/**
 * 개요 사이드바의 참가 팀. 본선 팀만 기본으로 보이고 예선 팀은 펼친다(예선 팀은 투표 순위순).
 * 카드는 링크가 아니다 — 팀 개별 화면이 없고 전부 같은 [참가 팀] 탭으로 가서, 잘못 누르기만 쉬웠다.
 * 전체 명단으로 가는 길은 머리글의 링크 하나다.
 */
function TeamResults({ data }: { data: TournamentDetail }) {
  const ranked = rankedTeams(data);
  // 순위 표기가 하나도 없는 대회는 본선/예선을 가를 수 없다 — 전부 보인다
  const known = ranked.some((t) => t.placement);
  const isQualifier = (t: TournamentTeam) => known && (!t.placement || stageLabel(t.placement) === "예선");
  const finals = ranked.filter((t) => !isQualifier(t));
  const qualifiers = ranked.filter(isQualifier)
    .sort((a, b) => (a.voteRank ?? 999) - (b.voteRank ?? 999) || a.name.localeCompare(b.name, "ko"));
  const voted = qualifiers.some((t) => t.voteRank != null);
  const [more, setMore] = useState(false);
  const row = (t: TournamentTeam, showVote: boolean) => {
    const placement = t.placement;
    const chip = placement === "우승" || placement === "1위"
      ? "우승"
      : placement === "준우승" || placement === "2위"
        ? "준우승"
        : null;
    return (
      <div className="tp-team-results-row" key={t.id}>
        <TeamLogo eventSlug={data.event.slug} name={t.name} />
        <span className="tp-team-result-details">
          <strong>
            <span>{t.name}</span>
            {chip && <em className={chip === "우승" ? "tp-team-result-winner" : "tp-team-result-runnerup"}>{chip}</em>}
            {showVote && t.voteRank != null && <em className="tp-team-result-vote">투표 {t.voteRank}위</em>}
          </strong>
          <small>{[...t.members.map((m) => m.name), ...t.listed.map((l) => l.name)].join(" · ") || "등록 로스터 미수집"}</small>
        </span>
      </div>
    );
  };
  return (
    <section className="tp-section tp-team-results">
      <SectionHeading
        title="참가 팀"
        subtitle={known && qualifiers.length ? `본선 ${finals.length}팀 · 전체 ${ranked.length}팀` : `총 ${ranked.length}팀`}
        action={
          <Link className="tp-text-link" href={tournamentHref(data.event.slug, "teams")}>
            전체 참가 명단 자세히 <ArrowRight size={14} />
          </Link>
        }
      />
      <div className="tp-team-results-list">
        {finals.map((t) => row(t, false))}
        {more && qualifiers.map((t) => row(t, true))}
      </div>
      {/* 버튼은 늘 목록 끝 — 펼치면 예선 팀(투표 순위순)이 이어 붙고 버튼은 그 아래로 간다 */}
      {qualifiers.length > 0 && (
        <button type="button" className="tp-team-results-more" aria-expanded={more}
          title={voted ? "예선 팀 · 투표 순위순" : "예선 팀"} onClick={() => setMore(!more)}>
          {more ? "접기" : `더보기 ${qualifiers.length}`}
        </button>
      )}
    </section>
  );
}
function FinalCard({
  data,
  match,
  open,
}: {
  data: TournamentDetail;
  match: TournamentSeries;
  open: OpenMatch;
}) {
  const winner = data.event.winner;
  const sides = [
    { name: match.a, id: match.aId, score: match.scoreA },
    { name: match.b, id: match.bId, score: match.scoreB },
  ].sort((a, b) => Number(b.name === winner) - Number(a.name === winner));
  return (
    <div className="tp-final">
      <div className="tp-final-top">
        <span>
          <Trophy size={15} /> GRAND FINAL
        </span>
        <span>
          {match.bestOf ? `BO${match.bestOf}` : "결승"}{" "}
          · 수집 기록
        </span>
      </div>
      <div className="tp-final-score">
        {sides.map((side, i) => {
          const team = data.teams.find((t) => t.id === side.id);
          const captain = team?.members.find((m) => m.isCaptain);
          return (
            <div className="tp-final-side" key={side.id ?? i}>
              <TeamLogo eventSlug={data.event.slug} name={side.name} className="tp-final-team-logo" />
              <strong>{side.name}</strong>
              <small>
                {captain ? (
                  <>
                    <span className="tp-final-captain-label">주장</span>{" "}
                    <Link href={profileHref("lol", captain.slug)}>{captain.name}</Link>
                  </>
                ) : (
                  "주장 미수집"
                )}
              </small>
            </div>
          );
        })}
        <div className="tp-final-numbers">
          <small>{winner ? "WINNER" : "FINAL SCORE"}</small>
          <b>
            {score(sides[0].score)}
            <em>:</em>
            {score(sides[1].score)}
          </b>
          <span>FINAL SCORE</span>
        </div>
      </div>
      <div className="tp-final-sets">
        {match.sets.map((s, i) => (
          <button key={s.id} onClick={() => open(match, i)}>
            <span>
              {s.label}
              {s.label === "세트" ? ` · 기록 ${i + 1}` : ""}
            </span>
            {s.winningSide === 100
              ? s.blueName
              : s.winningSide === 200
                ? s.redName
                : "승자 미확인"}{" "}
            <b>{[100, 200].includes(s.winningSide ?? 0) ? "W" : ""}</b>
          </button>
        ))}
      </div>
    </div>
  );
}
function ChampionJourney({
  data,
  winnerTeam,
  open,
}: {
  data: TournamentDetail;
  winnerTeam: TournamentTeam;
  open: OpenMatch;
}) {
  const path = data.series
    .filter((s) => [s.aId, s.bId].includes(winnerTeam.id))
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  return (
    <section className="tp-journey-panel" aria-labelledby="tp-journey-heading">
      <header className="tp-journey-heading">
        <h2 id="tp-journey-heading">매치 히스토리</h2>
        <small>{path.length}경기</small>
      </header>
      <ol className="tp-journey-list">
        {path.map((s, i) => {
          const ownScore = s.aId === winnerTeam.id ? s.scoreA : s.scoreB;
          const rivalScore = s.aId === winnerTeam.id ? s.scoreB : s.scoreA;
          const rival = s.aId === winnerTeam.id ? s.b : s.a;
          const result = ownScore == null || rivalScore == null
            ? "미확인"
            : ownScore > rivalScore ? "승" : "패";
          return (
            <li key={s.id}>
              <button
                className={[
                  "tp-journey-row",
                  result === "패" ? "tp-journey-loss" : "",
                  i === path.length - 1 ? "tp-journey-final" : "",
                ].filter(Boolean).join(" ")}
                type="button"
                onClick={() => open(s)}
                aria-label={s.round + ", " + winnerTeam.name + " " + score(ownScore) + " 대 " + score(rivalScore) + " " + rival + ", 세트 상세"}
              >
                <time dateTime={s.date}>{s.date.slice(5, 7)} / {s.date.slice(8, 10)}</time>
                <span className="tp-journey-track" aria-hidden="true" />
                <span className="tp-journey-round">{s.round.split(" · ")[0]}</span>
                <span className="tp-journey-opponent"><span>vs</span> {rival}</span>
                <span className="tp-journey-result">
                  <strong>{score(ownScore)} <i>:</i> {score(rivalScore)}</strong>
                  <small>{result}</small>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
function Overview({ data, open }: { data: TournamentDetail; open: OpenMatch }) {
  const final = data.series.find(
    (s) => s.round === "결승" || s.round === "결승전",
  );
  const winnerTeam = data.teams.find((t) => t.name === data.event.winner);
  const mvp = data.teams.flatMap((t) => t.members).find((m) => m.award);
  // 우승팀 선수별로 이 대회에서 가장 많이 쓴 챔피언 3개(판수 → 챔피언 번호 순)
  const topChampions = useMemo(() => {
    const counts = new Map<string, Map<number, number>>();
    for (const sr of data.series) for (const set of sr.sets) for (const p of set.players) {
      if (!p.streamer_id || !p.champion_id) continue;
      const m = counts.get(p.streamer_id) ?? new Map<number, number>();
      m.set(p.champion_id, (m.get(p.champion_id) ?? 0) + 1);
      counts.set(p.streamer_id, m);
    }
    return new Map([...counts].map(([id, m]) => [id,
      [...m].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 3).map(([cid, games]) => ({ id: cid, games }))]));
  }, [data.series]);
  const journeyCount = winnerTeam
    ? data.series.filter((s) => [s.aId, s.bId].includes(winnerTeam.id)).length
    : 0;
  return (
    <div className="tp-overview-grid">
      <div className="tp-overview-main">
        {!final && (
          <SectionHeading
            title="경기 기록"
            subtitle="확인된 경기와 세트의 기록입니다."
            action={
              <Link className="tp-text-link" href={tournamentHref(data.event.slug, "bracket")}>
                대진표 보기 <ArrowRight size={14} />
              </Link>
            }
          />
        )}
        {final ? (
          <FinalCard data={data} match={final} open={open} />
        ) : (
          <div className="tp-round-cards">
            {data.series.slice(-4).map((s) => <MatchCard key={s.id} eventSlug={data.event.slug} match={s} open={open} />)}
          </div>
        )}
        {(winnerTeam || journeyCount > 0) && <div className="tp-overview-main-lower">
        {winnerTeam && (
            <section className="tp-champion-panel">
              <div className="tp-champion-heading">
                <span><Trophy size={15} /> CHAMPIONS</span>
                <h2>{winnerTeam.name}</h2>
              </div>
              <div className="tp-champion-roster">
                {[...winnerTeam.members]
                  .sort(
                    (a, b) =>
                      positions.findIndex((p) => p[0] === a.position) -
                      positions.findIndex((p) => p[0] === b.position),
                  )
                  .map((m) => (
                    <Link
                      href={profileHref("lol", m.slug)}
                      key={m.id}
                      className={m.id === mvp?.id ? "tp-champion-mvp" : undefined}
                    >
                      <Avatar name={m.name} src={m.imageUrl} channelId={m.channelId} />
                      <span>
                        <b>
                          {m.name}
                          {m.id === mvp?.id && <em><Sparkles size={12} /> {m.award}</em>}
                        </b>
                        <small>
                          {positions.find((p) => p[0] === m.position)?.[1] ?? "—"}
                        </small>
                      </span>
                      <span className="tp-champion-picks" aria-label="이 대회에서 많이 쓴 챔피언">
                        {(topChampions.get(m.id) ?? []).map((c) => {
                          const champ = championById(c.id);
                          return champ ? (
                            <img key={c.id} src={championIconPath(champ)} alt={champ.name} title={`${champ.name} · ${c.games}판`} loading="lazy" />
                          ) : null;
                        })}
                      </span>
                      <ChevronRight size={14} />
                    </Link>
                  ))}
              </div>
            </section>
        )}
        {winnerTeam && journeyCount > 0 && (
            <div className="tp-overview-journey">
              <ChampionJourney data={data} winnerTeam={winnerTeam} open={open} />
            </div>
        )}
        </div>}
        <EventInfo data={data} />
      </div>
      <aside className="tp-overview-sidebar">
        {data.teams.length > 0 ? (
          <TeamResults data={data} />
        ) : (
          <p className="tp-footnote">등록 로스터가 없습니다. 경기별 출전 명단은 대진표에서 확인할 수 있습니다.</p>
        )}
        <EventFacts data={data} />
        <Sources data={data} />
      </aside>
    </div>
  );
}
function MatchCard({
  eventSlug,
  match,
  open,
}: {
  eventSlug: string;
  match: TournamentSeries;
  open: OpenMatch;
}) {
  return (
    <button
      className="tp-match-card"
      onClick={() => open(match)}
    >
      <small>
        {dotted(match.date)} ·{" "}
        {match.bestOf ? `BO${match.bestOf}` : `${match.sets.length}세트 기록`}
      </small>
      {[
        [match.a, match.scoreA],
        [match.b, match.scoreB],
      ].map(([name, n], i) => (
        <span
          key={i}
          className={
            typeof n === "number" && n > Number(i ? match.scoreA : match.scoreB)
              ? "tp-match-winner"
              : ""
          }
        >
          <TeamLogo eventSlug={eventSlug} name={String(name)} />
          <b>{name}</b>
          <strong>{score(n as number | null)}</strong>
        </span>
      ))}
      {match.scoreA == null && <em>팀별 세트 합계 미확인</em>}
    </button>
  );
}
function Bracket({ data, open }: { data: TournamentDetail; open: OpenMatch }) {
  const [round, setRound] = useState("all"),
    [team, setTeam] = useState("all");
  const bracket = data.bracket ?? null;
  const rounds = [...new Set(data.series.map((s) => s.round.split(" · ")[0]))];
  const matches = (s: TournamentSeries) =>
    (round === "all" || s.round.split(" · ")[0] === round) &&
    (team === "all" || [s.aId, s.bId].includes(team));
  const count = data.series.filter(matches);
  return (
    <>
      {!bracket && <div className="tp-bracket-filters">
        <label>
          라운드
          <select
            aria-label="라운드"
            value={round}
            onChange={(e) => setRound(e.target.value)}
          >
            <option value="all">전체 라운드</option>
            {rounds.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </label>
        <label>
          팀
          <select
            aria-label="팀"
            value={team}
            onChange={(e) => setTeam(e.target.value)}
          >
            <option value="all">전체 팀</option>
            {data.teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <span aria-live="polite">
          선택한 경기 {count.length}개 ·{" "}
          {count.reduce((n, s) => n + s.sets.length, 0)}세트
        </span>
        {(round !== "all" || team !== "all") && (
          <button
            onClick={() => {
              setRound("all");
              setTeam("all");
            }}
          >
            초기화
          </button>
        )}
      </div>}
      <DataNotes data={data} section={BRACKET_NOTE} />
      {!bracket && <p className="tp-footnote tp-bracket-hint">
        경기를 누르면 세트 상세를 볼 수 있습니다. 필터와 일치하는 경기를
        강조하며, 모바일에서는 좌우로 밀어 볼 수 있습니다.
      </p>}
      <div>
        {bracket ? (
          <>
            {/* 공통 대진: 칸·화살표는 데이터(core 0061)다. 대회마다 연결선 코드를 짜지 않는다. */}
            <BracketBoard
              model={bracket}
              onSelect={(slot) => {
                const series = data.series.find((x) => x.sets.some((set) => slot.matchIds.includes(set.id)));
                if (series) open(series);
              }}
            />
          </>
        ) : (
          <div className="tp-generic-bracket">
            {rounds.map((r) => {
              const items = data.series.filter(
                (s) => s.round.split(" · ")[0] === r && matches(s),
              );
              return items.length ? (
                <section key={r}>
                  <h3>{r}</h3>
                  <div className="tp-round-cards">
                    {items.map((s) => (
                      <MatchCard key={s.id} eventSlug={data.event.slug} match={s} open={open} />
                    ))}
                  </div>
                </section>
              ) : null;
            })}
            {count.length === 0 && (
              <div className="tp-empty">
                선택한 조건에 해당하는 경기가 없습니다.
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
/**
 * 참가 팀 — 팀별 카드. 왼쪽에 순위·팀, 오른쪽에 탑·정글·미드·원딜·서폿 다섯 칸(팀장·대회 티어·연결 안 된 이름까지).
 * 본선 팀은 성적순, 예선 팀은 투표 순위순(사이드바와 같은 규칙). 본선 팀만 있는 대회(투표로 본선을 뽑은 대회)는 투표순.
 */
function Teams({ data }: { data: TournamentDetail }) {
  const voted = data.teams.some((t) => t.voteRank != null);
  const rated = data.teams.some((t) => t.members.some((m) => m.rating));
  const ranked = rankedTeams(data);
  const known = ranked.some((x) => x.placement);
  const qualifier = (t: TournamentTeam) => known && (!t.placement || stageLabel(t.placement) === "예선");
  const byVote = (a: TournamentTeam, b: TournamentTeam) => (a.voteRank ?? 999) - (b.voteRank ?? 999) || a.name.localeCompare(b.name, "ko");
  const finals = ranked.filter((t) => !qualifier(t));
  const qualifiers = ranked.filter(qualifier).sort(byVote);
  const groups: { title: string | null; teams: TournamentTeam[] }[] = qualifiers.length
    ? [{ title: `본선 ${finals.length}팀`, teams: finals }, { title: `예선 ${qualifiers.length}팀${qualifiers.some((t) => t.voteRank != null) ? " · 투표 순위순" : ""}`, teams: qualifiers }]
    : [{ title: null, teams: voted ? [...data.teams].sort(byVote) : ranked }];
  /** label = 포지션 라벨(이름 위). 포지션 미확인 줄에서는 라벨이 없다 */
  const person = (m: TournamentTeam["members"][number], label?: string) => (
    <Link key={m.id} href={profileHref("lol", m.slug)} className="tp-team-slot-person">
      <Avatar name={m.name} src={m.imageUrl} channelId={m.channelId} />
      <span className="tp-team-slot-text">
        {label && <span className="tp-team-slot-pos">{label}</span>}
        <b>{m.name}{m.isCaptain && <i className="tp-captain" title="팀장">C</i>}</b>
        {(m.rating || m.award) && (
          <small>
            {m.award && <em className="tp-team-slot-award"><Sparkles size={10} /> {m.award}</em>}
            {m.rating && <span className="tp-team-slot-rating">{m.rating.label}{m.rating.points != null && <strong>{m.rating.points}점</strong>}</span>}
          </small>
        )}
      </span>
    </Link>
  );

  const card = (t: TournamentTeam, index: number, isQualifier: boolean) => {
    const stage = stageLabel(t.placement ?? undefined);
    const badge = isQualifier ? (t.voteRank != null ? `투표 ${t.voteRank}위` : "예선")
      : t.placement ?? (voted && t.voteRank != null ? `투표 ${t.voteRank}위` : `${index + 1}`);
    const unplaced = t.members.filter((m) => !m.position);
    return (
      <li key={t.id} className="tp-team-card">
        <div className="tp-team-card-team">
          <span className="tp-team-card-badge" data-stage={isQualifier ? "예선" : stage ?? undefined}>{badge}</span>
          <TeamLogo eventSlug={data.event.slug} name={t.name} />
          <strong>{t.name}</strong>
        </div>
        <div className="tp-team-card-slots">
          {positions.map(([key, label]) => {
            const members = t.members.filter((m) => m.position === key);
            const listed = t.listed.find((l) => l.position === key);
            return (
              <div className="tp-team-slot" key={key}>
                {members.map((m) => person(m, label))}
                {!members.length && (listed ? (
                  <span className="tp-listed" title={`스트리머로 연결되지 않은 이름 · 출처 ${listed.sourceUrl}`}>
                    <span className="tp-listed-face" aria-hidden="true">{listed.name.slice(0, 1)}</span>
                    <span className="tp-team-slot-text">
                      <span className="tp-team-slot-pos">{label}</span>
                      <b>{listed.name}</b><small><em>미연결</em></small>
                    </span>
                  </span>
                ) : (
                  <span className="tp-listed tp-team-slot-missing">
                    <span className="tp-listed-face" aria-hidden="true" />
                    <span className="tp-team-slot-text"><span className="tp-team-slot-pos">{label}</span><span className="tp-missing">미수집</span></span>
                  </span>
                ))}
              </div>
            );
          })}
        </div>
        {unplaced.length > 0 && (
          <div className="tp-team-card-unplaced">
            <span className="tp-team-card-unplaced-label">포지션 미확인</span>
            {unplaced.map((m) => person(m))}
          </div>
        )}
      </li>
    );
  };

  return (
    <>
      <SectionHeading
        title="참가 팀"
        subtitle={[
          `${data.teams.length}팀`,
          voted ? (qualifiers.length ? "본선 성적순 · 예선 투표 순위순" : "투표 순위순") : null,
          rated ? "티어와 포인트는 대회 참가 당시 기준 · 수기" : null,
        ].filter(Boolean).join(" · ")}
      />
      {data.teams.length ? (
        groups.map((g) => (
          <section key={g.title ?? "all"} className="tp-team-group">
            {g.title && <h3>{g.title}</h3>}
            <ul className="tp-team-cards">{g.teams.map((t, i) => card(t, i, g.teams === qualifiers))}</ul>
          </section>
        ))
      ) : (
        <div className="tp-empty">
          <Users />
          <h2>등록 로스터를 아직 수집하지 않았어요</h2>
          <p>경기별 출전 명단은 대진표의 세트 상세에서 확인할 수 있습니다.</p>
          <Link href={tournamentHref(data.event.slug, "bracket")}>
            대진표 보기
          </Link>
        </div>
      )}
      <DataNotes data={data} section={ROSTER_NOTE} />
    </>
  );
}
const POSITION_TABS: [string, string][] = [["TOP", "탑"], ["JUNGLE", "정글"], ["MIDDLE", "미드"], ["BOTTOM", "원딜"], ["UTILITY", "서폿"]];
const minutes = (sec: number) => `${Math.floor(sec / 60)}분 ${String(sec % 60).padStart(2, "0")}초`;
const kda = (x: { kills: number | null; deaths: number | null; assists: number | null }) =>
  x.kills == null || x.deaths == null || x.assists == null ? "— / — / —" : `${x.kills} / ${x.deaths} / ${x.assists}`;

function ChampIcon({ id, name }: { id: number; name: string | null }) {
  const c = championById(id);
  return c ? <img className="tp-duel-champ" src={championIconPath(c)} alt={c.name} title={c.name} loading="lazy" />
    : <span className="tp-duel-champ tp-duel-champ-empty" title={name ?? ""}>?</span>;
}

/** 명기록 3장. 기록마다 그 세트(상세 팝업)로 이어진다. */
function RecordHighlights({ data, open }: { data: TournamentDetail; open: OpenMatch }) {
  const h = useMemo(() => tournamentHighlights(data.series), [data.series]);
  const go = (ref: { seriesId: string; setIndex: number }) => {
    const s = data.series.find((x) => x.id === ref.seriesId);
    if (s) open(s, ref.setIndex);
  };
  return (
    <div className="tp-hl-grid">
      {h.longest && (
        <button type="button" className="tp-hl" onClick={() => go(h.longest!)}>
          <span className="tp-hl-label">최장 경기</span>
          <strong>{minutes(h.longest.seconds)}</strong>
          <small>{h.longest.blue} vs {h.longest.red} · {h.longest.round.split(" · ")[0]}</small>
          <em>경기 시간이 확인된 {h.longest.known}세트 기준{h.longest.known < h.longest.total ? ` (전체 ${h.longest.total}세트)` : ""}</em>
        </button>
      )}
      {h.mostKills && (
        <button type="button" className="tp-hl" onClick={() => go(h.mostKills!)}>
          <span className="tp-hl-label">한 세트 최다 킬</span>
          <strong className="tp-hl-with-icon"><ChampIcon id={h.mostKills.championId} name={h.mostKills.champion} />{h.mostKills.kills}킬</strong>
          <small>{h.mostKills.name} · {kda(h.mostKills)} · {h.mostKills.round.split(" · ")[0]}</small>
          <em>{h.mostKills.ties ? `같은 킬 수 ${h.mostKills.ties}건 더 있음 · ` : ""}킬이 확인된 기록 기준</em>
        </button>
      )}
      {h.champions && (
        <a className="tp-hl" href="#tp-champions">
          <span className="tp-hl-label">챔피언 다양성</span>
          <strong>{h.champions.kinds}종</strong>
          <small>{h.champions.picks}픽 중 한 번만 나온 챔피언 {h.champions.once}종</small>
          <em>출전 명단 기준 · 밴 기록은 없음</em>
        </a>
      )}
    </div>
  );
}

/** 포지션별 맞라인 대결 — 같은 포지션으로 출전한 세트의 팀 승패. 펼치면 세트별 챔피언·KDA. */
function LaneDuels({ data, open }: { data: TournamentDetail; open: OpenMatch }) {
  const duels = useMemo(() => laneDuels(data.series), [data.series]);
  const faces = useMemo(() => new Map(data.teams.flatMap((t) => t.members).map((m) => [m.id, m])), [data.teams]);
  const [position, setPosition] = useState(POSITION_TABS.find(([key]) => duels.some((d) => d.position === key))?.[0] ?? "TOP");
  const [openKey, setOpenKey] = useState<string | null>(null);
  if (!duels.length) return <p className="tp-footnote">양쪽 모두 등록된 스트리머이고 포지션이 확인된 맞대결이 없습니다.</p>;
  const shown = duels.filter((d) => d.position === position);
  const person = (p: { id: string; slug: string | null; name: string }) => {
    const m = faces.get(p.id);
    return (
      <span className="tp-duel-person">
        <Avatar name={p.name} src={m?.imageUrl ?? null} channelId={m?.channelId ?? null} />
        {p.slug ? <Link href={profileHref("lol", p.slug)} onClick={(e) => e.stopPropagation()}>{p.name}</Link> : <b>{p.name}</b>}
      </span>
    );
  };
  return (
    <>
      <nav className="tp-duel-tabs" aria-label="포지션">
        {POSITION_TABS.map(([key, label]) => {
          const n = duels.filter((d) => d.position === key).length;
          return (
            <button key={key} type="button" aria-pressed={position === key} disabled={!n} onClick={() => { setPosition(key); setOpenKey(null); }}>
              {label}<small>{n}</small>
            </button>
          );
        })}
      </nav>
      <ul className="tp-duel-list">
        {shown.map((d) => {
          const key = `${d.position}:${d.a.id}:${d.b.id}`;
          const expanded = openKey === key;
          return (
            <li key={key} className={expanded ? "tp-duel-open" : undefined}>
              <button type="button" className="tp-duel-row" aria-expanded={expanded} onClick={() => setOpenKey(expanded ? null : key)}>
                {person(d.a)}
                <span className="tp-duel-score">
                  <b className={d.aWins > d.bWins ? "tp-duel-lead" : undefined}>{d.aWins}</b>
                  <i>:</i>
                  <b className={d.bWins > d.aWins ? "tp-duel-lead" : undefined}>{d.bWins}</b>
                  <small>맞대결 {d.sets.length}세트</small>
                </span>
                {person(d.b)}
                <ChevronRight size={14} className="tp-duel-caret" />
              </button>
              {expanded && (
                <ol className="tp-duel-sets">
                  {d.sets.map((x) => (
                    <li key={`${x.seriesId}:${x.setIndex}`}>
                      <button type="button" onClick={() => { const s = data.series.find((y) => y.id === x.seriesId); if (s) open(s, x.setIndex); }}>
                        <span className={`tp-duel-side ${x.winner === "a" ? "tp-duel-win" : ""}`}>
                          <ChampIcon id={x.a.championId} name={x.a.championName} /><span>{kda(x.a)}</span>{x.winner === "a" && <em>승</em>}
                        </span>
                        <span className="tp-duel-round">{x.round.split(" · ")[0]}<small>{x.label === "세트" ? "" : x.label} · {dotted(x.date)}</small></span>
                        <span className={`tp-duel-side tp-duel-side-b ${x.winner === "b" ? "tp-duel-win" : ""}`}>
                          {x.winner === "b" && <em>승</em>}<span>{kda(x.b)}</span><ChampIcon id={x.b.championId} name={x.b.championName} />
                        </span>
                      </button>
                    </li>
                  ))}
                </ol>
              )}
            </li>
          );
        })}
      </ul>
      <p className="tp-data-note">같은 포지션으로 출전한 세트의 <b>팀 승패</b> 기준입니다(라인전 결과가 아닙니다). 양쪽 모두 등록된 스트리머인 세트만 셉니다. 세트를 누르면 경기 상세를 봅니다.</p>
    </>
  );
}

/** 본선 선발 투표 순위와 최종 성적. 투표는 전력 예상이 아니라 선발 절차라 상승·하락 폭이나 이변을 계산하지 않는다. */
function VoteVsResult({ data }: { data: TournamentDetail }) {
  const teams = data.teams.filter((t) => t.voteRank != null).sort((a, b) => a.voteRank! - b.voteRank!);
  if (!teams.length) return null;
  const how = data.facts.find((f) => f.label === "본선 선발")?.value;
  return (
    <section className="tp-section">
      <SectionHeading title="투표 순위와 최종 성적" subtitle={`본선 선발 투표${how ? `(${how})` : ""} 순위 → 대회 최종 성적`} />
      <ol className="tp-vote-list">
        {teams.map((t) => (
          <li key={t.id}>
            <span className="tp-vote-rank">투표 {t.voteRank}위</span>
            <span className="tp-vote-team"><TeamLogo eventSlug={data.event.slug} name={t.name} /><b>{t.name}</b></span>
            <span className="tp-vote-arrow" aria-hidden="true">→</span>
            <span className="tp-vote-result" data-stage={stageLabel(t.placement) ?? undefined}>{t.placement ?? "미확인"}</span>
          </li>
        ))}
      </ol>
      <p className="tp-data-note">투표는 본선 진출팀을 고르는 절차라 전력 예상과 같지 않습니다. 공동 순위(5–6위 등)는 그대로 둡니다.</p>
    </section>
  );
}

function Records({ data, open }: { data: TournamentDetail; open: OpenMatch }) {
  const stats = useMemo(
    () => tournamentPlayerRecords(data.series),
    [data.series],
  );
  return (
    <>
      <SectionHeading title="대회 기록실" subtitle="이 대회에서 스트리머끼리 어떻게 맞붙었는가" />
      <RecordHighlights data={data} open={open} />
      <section className="tp-section">
        <SectionHeading title="맞라인 대결" subtitle="같은 포지션으로 맞붙은 두 스트리머의 세트 승패" />
        <LaneDuels data={data} open={open} />
      </section>
      <VoteVsResult data={data} />
      <section className="tp-section">
      <SectionHeading
        title="선수 기록"
        subtitle="확인된 출전과 챔피언 기록 · 세트 승수순"
      />
      <p className="tp-data-note">
        K/D/A는 값이 모두 확인된 세트만 평균에 포함합니다. 미등록 참가자의
        이름을 동일인으로 추정해 합산하지 않으며, 챔피언 기록은 공개된 출전 명단
        기준입니다.
      </p>
      <div className="tp-columns">
        <Panel title="선수 기록">
          <div className="tp-table-scroll">
            <table className="tp-record-table">
              <thead>
                <tr>
                  <th>선수</th>
                  <th>출전</th>
                  <th>승 / 패</th>
                  <th>평균 K / D / A</th>
                  <th>확인 세트</th>
                </tr>
              </thead>
              <tbody>
                {stats.players.map((p) => (
                  <tr key={p.id}>
                    <td>
                      {p.slug ? (
                        <Link href={profileHref("lol", p.slug)}>{p.name}</Link>
                      ) : (
                        p.name
                      )}
                    </td>
                    <td>{p.games}</td>
                    <td>
                      {p.wins} / {p.losses}
                    </td>
                    <td>
                      {p.known
                        ? [p.kills, p.deaths, p.assists]
                            .map((n) => (n / p.known).toFixed(1))
                            .join(" / ")
                        : "미수집"}
                    </td>
                    <td>
                      {p.known} / {p.games}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!stats.players.length && (
              <p className="tp-footnote">확인된 선수 기록이 없습니다.</p>
            )}
          </div>
        </Panel>
        <Panel title="많이 선택한 챔피언" className="tp-champions-panel" id="tp-champions">
          {stats.champions.slice(0, 15).map((c, i) => {
            const champion = championById(c.id);
            return (
              <div className="tp-champion-row" key={c.id}>
                <span>{String(i + 1).padStart(2, "0")}</span>
                {champion && (
                  <img src={championIconPath(champion)} alt="" loading="lazy" />
                )}
                <b>{champion?.name ?? c.name}</b>
                <div>
                  {c.picks}픽
                  <small>
                    {c.wins}승 {c.losses}패
                  </small>
                </div>
              </div>
            );
          })}
          <p className="tp-footnote">
            밴 기록은 미수집이며, 픽 수를 밴픽률로 표시하지 않습니다.
          </p>
        </Panel>
      </div>
      </section>
    </>
  );
}
/**
 * 대회 정보(예전 [대회 안내] 탭) — 개요 아래 카드 한 장. 대회 사실은 여기 한 곳에서 관리한다
 * (사이드바 「대회 한눈에」는 기간·주최·참가·수집 기록 — 데이터에서 저절로 나오는 값).
 *
 * ── 위계 ──
 *   1. 맨 위 요약 한 줄(구역 '요약') — 10초 안에 이 대회를 이해하게 하는 문장. 가장 강하게.
 *   2. 분류(구역 이름)별 줄 — 왼쪽 분류명, 오른쪽 항목. 분류는 정보 종류다(시간 순서의 단계가 아니다).
 *   3. 항목 = 라벨 위, 값 아래. 값이 가장 밝다.
 * ── 격자 ──
 *   오른쪽은 공통 4열(휴대폰 2열). 항목 시작점을 맞춰 훑을 때 시선이 재탐색하지 않게 한다.
 *   값이 길면 2칸·전체 폭을 쓴다(spanOf) — 긴 값을 좁은 칸에 가두지도, 폭을 내용에 맡기지도 않는다.
 * ── 값 적는 규칙(데이터) ──
 *   줄바꿈 = **동등한 여러 값**(본선 장소 / 결승 장소) — 같은 무게로 쌓는다.
 *   괄호로 감싼 줄 '(두 번 지면 탈락)' = **보조 설명** — 작고 흐리게. 줄 위치가 아니라 의미로 구분한다.
 * 상금·시상 분류에서 금액은 「상금」 한 항목(총액 + 순위별 보조 설명)으로 접고, 개인상을 그 옆 한 항목으로 붙인다.
 * 그 분류가 없는데 개인상·팀 상금이 있으면 「상금·시상」 분류를 만든다.
 */
const SUMMARY_SECTION = "요약";
const isPrize = (section: string) => /상금|시상/.test(section);
const isAmount = (v: string) => /^[\d,.]+\s*(만|억)?\s*원$/.test(v.trim());
type InfoItem = { label: string; lines: string[]; notes: string[]; body?: ReactNode };
const parseValue = (label: string, value: string): InfoItem => {
  // 'A · B' 의 점은 앞 단어에 붙인다 — 줄이 바뀔 때 다음 줄이 '· B' 로 시작하지 않게
  const all = value.split("\n").map((l) => l.trim().replace(/ · /g, "\u00a0· ")).filter(Boolean);
  const isNote = (l: string) => /^\(.*\)$/.test(l);
  return { label, lines: all.filter((l) => !isNote(l)), notes: all.filter(isNote).map((l) => l.slice(1, -1)) };
};
/** 글자 폭 어림 — 한글은 1, 영문·숫자·기호는 0.6 */
const textWidth = (t: string) => [...t].reduce((n, ch) => n + (/[가-힣]/.test(ch) ? 1 : 0.6), 0);
/** 칸 수 — 가장 긴 줄의 폭으로 정한다. 값 12px 기준 데스크톱 4열(한 칸 ≈ 14자), 휴대폰 2열(한 칸 ≈ 12자) */
const spanOf = (item: InfoItem) => {
  const w = Math.max(textWidth(item.label), ...item.lines.map(textWidth), ...item.notes.map((l) => textWidth(l) * 0.9));
  return { desktop: w > 30 ? 4 : w > 14 ? 2 : 1, mobile: w > 12 ? 2 : 1 };
};
const infoSections = (data: TournamentDetail) => [...new Set(data.facts.map((f) => f.section))]
  .filter((sec) => !PLACED_SECTIONS.has(sec) && sec !== SUMMARY_SECTION);
const eventAwards = (data: TournamentDetail) => data.teams.flatMap((t) =>
  t.members.filter((m) => m.award).map((m) => ({ ...m, award: m.award!, team: t.name })));
function hasEventInfo(data: TournamentDetail) {
  return infoSections(data).length > 0 || eventAwards(data).length > 0 || data.teams.some((t) => t.prize);
}
function EventInfo({ data }: { data: TournamentDetail }) {
  if (!hasEventInfo(data)) return null;
  const summary = data.facts.find((f) => f.section === SUMMARY_SECTION)?.value;
  const sections = infoSections(data);
  const prizeItems = (facts: TournamentDetail["facts"]): InfoItem[] => {
    const pool = facts.find((f) => f.label === "총 상금");
    // 상금 안내가 없으면 팀별 상금으로 만든다
    const split = facts.length
      ? facts.filter((f) => f !== pool && isAmount(f.value)).map((f) => `${f.label} ${f.value.replace(/\s*원$/, "")}`)
      : data.teams.filter((t) => t.prize).sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))
        .map((t) => `${`${t.placement ?? ""} ${t.name}`.trim()} ${t.prize}`);
    const items: InfoItem[] = [];
    if (pool || split.length) {
      items.push(pool ? { label: "상금", lines: [pool.value], notes: split.length ? [split.join(" · ")] : [] }
        : { label: "팀 상금", lines: split, notes: [] });
    }
    const awards = eventAwards(data);
    if (awards.length) {
      items.push({
        label: "개인상",
        lines: awards.map((m) => `${m.award} ${m.name}`),
        notes: [],
        body: awards.map((m) => (
          <Fragment key={m.id}>
            <span className="tp-info-line">{m.award} <Link className="tp-info-link" href={profileHref("lol", m.slug)}>{m.name}</Link></span>
            <small>{m.team}</small>
          </Fragment>
        )),
      });
    }
    return [...items, ...facts.filter((f) => f !== pool && !isAmount(f.value)).map((f) => parseValue(f.label, f.value))];
  };
  const groups = sections.map((section) => {
    const facts = data.facts.filter((f) => f.section === section);
    return { title: section, items: isPrize(section) ? prizeItems(facts) : facts.map((f) => parseValue(f.label, f.value)) };
  });
  if (!sections.some(isPrize)) {
    const items = prizeItems([]);
    if (items.length) groups.push({ title: "상금·시상", items });
  }
  return (
    <section className="tp-section" id="tp-info">
      <SectionHeading title="대회 정보" />
      <div className="tp-info-card">
        {summary && <p className="tp-info-summary">{summary}</p>}
        {groups.map((g) => (
          <section className="tp-info-row" key={g.title}>
            <h3>{g.title}</h3>
            <dl>
              {g.items.map((item) => (
                <div key={item.label} data-span={spanOf(item).desktop} data-span-m={spanOf(item).mobile}>
                  <dt>{item.label}</dt>
                  <dd>
                    {item.body ?? item.lines.map((l, i) => <span className="tp-info-line" key={i}>{l}</span>)}
                    {item.notes.map((n, i) => <small key={i}>{n}</small>)}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
      <p className="tp-footnote">
        출처 링크의 문서에서 옮긴 수기 기록입니다.
        {data.event.slug === FEATURED_SLUG && " 사진 © SOOP."}
      </p>
    </section>
  );
}
