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
} from "@soop-lol/core/lib/contract";
import { tournamentsIndexHref } from "./paths.ts";
import { Avatar } from "../../../ui/avatar.tsx";
import { MatchDetails } from "../../../ui/match-details.tsx";
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
  ["info", "대회 안내"],
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
const SUMMARY_SECTION = "대회 한눈에";
const BRACKET_NOTE = "대진표 메모";
const ROSTER_NOTE = "참가 팀 메모";
const PLACED_SECTIONS = new Set([SUMMARY_SECTION, BRACKET_NOTE, ROSTER_NOTE]);
const multiline = (value: string): ReactNode =>
  value.split("\n").map((line, i) => <Fragment key={i}>{i > 0 && <br />}{line}</Fragment>);
const factRows = (data: TournamentDetail, section: string): [string, ReactNode][] =>
  data.facts.filter((f) => f.section === section).map((f) => [f.label, multiline(f.value)]);
function DataNotes({ data, section }: { data: TournamentDetail; section: string }) {
  return data.facts.filter((f) => f.section === section).map((f) => (
    <p className="tp-data-note" key={f.label}>{f.label} · {multiline(f.value)}</p>
  ));
}
const teamInitial = (name: string) => name.replace(/^TEAM\s*/, "").slice(0, 1);
function Badge({ name }: { name: string }) {
  return (
    <span className="tp-team-badge" aria-hidden="true">
      {teamInitial(name)}
    </span>
  );
}
function Panel({
  title,
  children,
  className = "",
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`tp-panel ${className}`}>
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
        {active === "overview" ? (
          <Overview data={data} open={open} />
        ) : active === "bracket" ? (
          <Bracket data={data} open={open} />
        ) : active === "teams" ? (
          <Teams data={data} />
        ) : active === "records" ? (
          <Records data={data} />
        ) : (
          <Info data={data} />
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
          ...factRows(data, SUMMARY_SECTION),
        ]}
      />
      <Link className="tp-panel-link" href={tournamentHref(e.slug, "info")}>
        대회 안내 자세히
        <ArrowRight size={14} />
      </Link>
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
function TeamResults({ data }: { data: TournamentDetail }) {
  return (
    <section className="tp-section tp-team-results">
      <SectionHeading
        title="참가 팀"
        subtitle={`총 ${data.teams.length}팀`}
        action={
          <Link className="tp-text-link" href={tournamentHref(data.event.slug, "teams")}>
            전체 보기 <ArrowRight size={14} />
          </Link>
        }
      />
      <div className="tp-team-results-list">
        {rankedTeams(data).map((t) => {
          const placement = t.placement;
          const chip = placement === "우승" || placement === "1위"
            ? "우승"
            : placement === "준우승" || placement === "2위"
              ? "준우승"
              : null;
          return (
            <Link className="tp-team-results-row" key={t.id} href={tournamentHref(data.event.slug, "teams")}>
              <Badge name={t.name} />
              <span className="tp-team-result-details">
                <strong>
                  <span>{t.name}</span>
                  {chip && <em className={chip === "우승" ? "tp-team-result-winner" : "tp-team-result-runnerup"}>{chip}</em>}
                </strong>
                <small>{t.members.map((m) => m.name).join(" · ") || "등록 로스터 미수집"}</small>
              </span>
              <ChevronRight size={14} />
            </Link>
          );
        })}
      </div>
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
              <span className="tp-final-team-logo" aria-hidden="true" />
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
            {data.series.slice(-4).map((s) => <MatchCard key={s.id} match={s} open={open} />)}
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
  match,
  open,
  muted = false,
}: {
  match: TournamentSeries;
  open: OpenMatch;
  muted?: boolean;
}) {
  return (
    <button
      className={`tp-match-card ${muted ? "tp-match-muted" : ""}`}
      data-match-id={match.id}
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
          <Badge name={String(name)} />
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
  const board = useRef<HTMLDivElement>(null);
  const featured = data.event.slug === FEATURED_SLUG;
  const rounds = [...new Set(data.series.map((s) => s.round.split(" · ")[0]))];
  const matches = (s: TournamentSeries) =>
    (round === "all" || s.round.split(" · ")[0] === round) &&
    (team === "all" || [s.aId, s.bId].includes(team));
  const count = data.series.filter(matches);
  const find = (id: string) =>
    data.series.find((s) => s.id === `${data.event.slug}:${id}`);
  useEffect(() => {
    if (!board.current || !featured) return;
    function draw() {
      const root = board.current;
      if (!root) return;
      root.querySelectorAll(".tp-bracket-grid").forEach((grid) => {
        grid.querySelector("svg.tp-connectors")?.remove();
        const rect = grid.getBoundingClientRect();
        const svg = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "svg",
        );
        svg.classList.add("tp-connectors");
        svg.setAttribute("viewBox", `0 0 ${rect.width} ${rect.height}`);
        svg.setAttribute("aria-hidden", "true");
        for (const [a, b] of [
          ["g01", "g05"],
          ["g02", "g05"],
          ["g03", "g07"],
          ["g04", "g07"],
          ["g05", "g11"],
          ["g07", "g11"],
          ["g11", "g14"],
          ["g06", "g09"],
          ["g08", "g10"],
          ["g09", "g12"],
          ["g10", "g12"],
          ["g12", "g13"],
        ]) {
          const first = grid.querySelector(
              `[data-match-id="${data.event.slug}:${a}"]`,
            ),
            second = grid.querySelector(
              `[data-match-id="${data.event.slug}:${b}"]`,
            );
          if (!first || !second) continue;
          const x = first.getBoundingClientRect(),
            y = second.getBoundingClientRect();
          const x1 = x.right - rect.left,
            x2 = y.left - rect.left,
            y1 = x.top + x.height / 2 - rect.top,
            y2 = y.top + y.height / 2 - rect.top;
          const path = document.createElementNS(svg.namespaceURI, "path");
          path.setAttribute(
            "d",
            `M${x1},${y1} H${(x1 + x2) / 2} V${y2} H${x2}`,
          );
          svg.append(path);
        }
        grid.prepend(svg);
      });
    }
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(board.current);
    return () => observer.disconnect();
  }, [data.event.slug, featured]);
  const columns = (groups: [string, string[]][]) => (
    <div
      className="tp-bracket-scroll"
      role="region"
      aria-label="대회 대진"
      tabIndex={0}
    >
      <div className="tp-bracket-grid">
        {groups.map(([label, ids]) => (
          <section key={label}>
            <h3>{label}</h3>
            <div>
              {ids.map((id) => {
                const s = find(id);
                return s ? (
                  <MatchCard
                    key={id}
                    match={s}
                    open={open}
                    muted={!matches(s)}
                  />
                ) : (
                  <div key={id} className="tp-uncollected">
                    경기 미수집
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
  return (
    <>
      <div className="tp-bracket-filters">
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
      </div>
      <DataNotes data={data} section={BRACKET_NOTE} />
      <p className="tp-footnote tp-bracket-hint">
        경기를 누르면 세트 상세를 볼 수 있습니다. 필터와 일치하는 경기를
        강조하며, 모바일에서는 좌우로 밀어 볼 수 있습니다.
      </p>
      <div ref={board}>
        {featured ? (
          <>
            {columns([
              ["승자조 1라운드", ["g01", "g02", "g03", "g04"]],
              ["승자조 2라운드", ["g05", "g07"]],
              ["승자조 결승", ["g11"]],
              ["최종 결승", ["g14"]],
            ])}
            {columns([
              ["패자조 1라운드", ["g06", "g08"]],
              ["패자조 2라운드", ["g09", "g10"]],
              ["패자조 3라운드", ["g12"]],
              ["패자조 결승", ["g13"]],
            ])}
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
                      <MatchCard key={s.id} match={s} open={open} />
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
function Teams({ data }: { data: TournamentDetail }) {
  // 투표 순위·등급은 주최측이 발표한 대회에서만 있다(수기). 있으면 그 순서로 세운다.
  const voted = data.teams.some((t) => t.voteRank != null);
  const rated = data.teams.some((t) => t.members.some((m) => m.rating));
  const teams = voted
    ? [...data.teams].sort((a, b) => (a.voteRank ?? 99) - (b.voteRank ?? 99))
    : data.teams;
  return (
    <>
      <SectionHeading
        title="참가 팀"
        subtitle={[
          `${data.teams.length}팀`,
          voted ? "투표 순위순" : "등록된 로스터를 포지션별로 확인하세요.",
          rated ? "티어와 포인트는 대회 참가 당시 기준 · 수기" : null,
        ].filter(Boolean).join(" · ")}
      />
      {teams.length ? (
        <div
          className="tp-table-scroll tp-roster-wrap"
          role="region"
          tabIndex={0}
          aria-label="참가 팀 포지션별 로스터"
        >
          <table className="tp-roster-table">
            <thead>
              <tr>
                <th>{voted ? "투표" : "번호"}</th>
                <th>팀</th>
                {positions.map(([key, label]) => (
                  <th key={key}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {teams.map((t, i) => {
                const stage = stageLabel(t.placement ?? undefined);
                return (
                <tr key={t.id}>
                  <td>
                    {voted ? (t.voteRank ?? "—") : i + 1}
                  </td>
                  <th scope="row">
                    <div className="tp-roster-team">
                      <Badge name={t.name} />
                      <span className="tp-roster-team-name">
                        <strong>{t.name}</strong>
                        {stage && <em data-stage={stage}>{stage}</em>}
                      </span>
                    </div>
                  </th>
                  {positions.map(([key]) => (
                    <td key={key}>
                      {t.members
                        .filter((m) => m.position === key)
                        .map((m) => {
                          const rating = m.rating;
                          return (
                            <div className="tp-roster-person" key={m.id}>
                              <Link href={profileHref("lol", m.slug)}>
                                <span className="tp-roster-person-photo">
                                  <Avatar
                                    name={m.name}
                                    src={m.imageUrl}
                                    channelId={m.channelId}
                                  />
                                </span>
                                <span className="tp-roster-person-name">
                                  <b>{m.name}</b>
                                  {m.isCaptain && (
                                    <i className="tp-captain" title="주장">
                                      C
                                    </i>
                                  )}
                                </span>
                                {rating && (
                                  <>
                                    <span className="tp-roster-person-tier">{rating.label}</span>
                                    {rating.points != null && (
                                      <strong className="tp-roster-person-points">{rating.points}점</strong>
                                    )}
                                  </>
                                )}
                              </Link>
                            </div>
                          );
                        })}
                      {!t.members.some((m) => m.position === key) && (
                        <span className="tp-missing">미수집</span>
                      )}
                    </td>
                  ))}
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
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
      {teams.some((t) => t.members.some((m) => !m.position)) && (
        <Panel title="포지션 미확인">
          {teams.flatMap((t) =>
            t.members
              .filter((m) => !m.position)
              .map((m) => (
                <p key={`${t.id}:${m.id}`}>
                  {t.name} · <Link href={profileHref("lol", m.slug)}>{m.name}</Link>
                </p>
              )),
          )}
        </Panel>
      )}
      <DataNotes data={data} section={ROSTER_NOTE} />
    </>
  );
}
function Records({ data }: { data: TournamentDetail }) {
  const stats = useMemo(
    () => tournamentPlayerRecords(data.series),
    [data.series],
  );
  return (
    <>
      <SectionHeading
        title="대회 기록실"
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
        <Panel title="많이 선택한 챔피언">
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
    </>
  );
}
function Info({ data }: { data: TournamentDetail }) {
  const sections = [...new Set(data.facts.map((f) => f.section))].filter((sec) => !PLACED_SECTIONS.has(sec));
  const awards = data.teams.flatMap((t) =>
    t.members.filter((m) => m.award).map((m) => ({ ...m, award: m.award!, team: t.name })));
  if (sections.length === 0 && awards.length === 0)
    return (
      <div className="tp-columns">
        <EventFacts data={data} />
        <Sources data={data} />
      </div>
    );
  return (
    <>
      <SectionHeading
        title="대회 안내"
        subtitle="대회의 방식부터 시상까지, 알아두면 좋은 정보 · 수기 기록"
      />
      <div className="tp-info-grid">
        <EventFacts data={data} />
        {sections.map((section) => {
          const facts = data.facts.filter((f) => f.section === section);
          // '총 상금' 은 크게 보여준다 — 값은 데이터, 강조는 화면 규칙이다.
          const pool = facts.find((f) => f.label === "총 상금");
          const [amount, unit] = pool ? [pool.value.replace(/[^\d,.].*$/, ""), pool.value.replace(/^[\d,.]+\s*/, "")] : [];
          return (
            <Panel title={section} key={section}>
              {pool && (
                <div className="tp-prize">
                  <span>TOTAL PRIZE POOL</span>
                  <strong>{amount || pool.value}{amount && unit && <small>{unit}</small>}</strong>
                </div>
              )}
              <Facts rows={facts.filter((f) => f !== pool).map((f) => [f.label, multiline(f.value)])} />
            </Panel>
          );
        })}
        {awards.length > 0 && (
          <Panel title="개인상">
            <Facts
              rows={awards.map((m) => [m.award, <>{<Link href={profileHref("lol", m.slug)}>{m.name}</Link>} · {m.team}</>])}
            />
          </Panel>
        )}
      </div>
      <section className="tp-section">
        <Sources data={data} />
        <p className="tp-footnote">
          대회 안내는 출처 링크의 문서에서 옮긴 수기 기록입니다.
          {data.event.slug === FEATURED_SLUG && " 사진 © SOOP."}
        </p>
      </section>
    </>
  );
}
