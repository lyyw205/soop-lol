import { notFound } from "next/navigation";
import { getFcoPerson, listFcoGamesForPerson, listFcoModesForPerson, listFcoPeople, listFcoStreamerGamesForPerson } from "@soop-lol/core/lib/db/fconline";
import { FcoMatchList } from "../../../../../../packages/ui/fc/fco-records";
import { FcRecordSearch } from "../../../../../../packages/ui/fc/fco-record-search";
import { FcoPersonalOverview } from "../../../../../../packages/ui/fc/fco-overview";
import { fcTournamentHref, fcTournamentsIndexHref, fcVersusIndexHref } from "@/lib/module-links";
import { RecordContentPanel, RecordSectionTabs } from "@/components/record-structure";
import { FcoOpponentHistory, FcoProfileEventList, type FcoOpponentRow, type FcoProfileEventRow } from "@/components/fco-profile-tabs";
import { OpponentHistoryHeading } from "@/components/opponent-history-filters";
import { SectionTitle } from "@/components/public";
import { FcoSquadUsage } from "@/components/fco-squad-usage";
import { DEFAULT_OPPONENT_SORT, isOpponentSort, sortOpponents } from "@soop-lol/core/lib/metrics/opponents";
import { RecordLayout } from "../../../../../../packages/ui/record-layout";
import { LinkedRecordFilters } from "../../../../../../packages/ui/record-filters";
import { RecordPeriodFilters } from "@/components/record-period-filters";
import { recordPeriodLabel, resolveRecordPeriod } from "@soop-lol/core/lib/metrics/record-period";
import { FCO_MODE_LABEL } from "@soop-lol/core/lib/games/fconline/view";

export const dynamic = "force-dynamic";
export const metadata = { title: { absolute: "개인기록 · SOOP FC 온라인" } };

const TABS = ["games", "opponents", "events", "squad"] as const;
type ProfileTab = typeof TABS[number];

/** 프로필이 한 번에 집계하는 경기 수의 상한. 넘으면 화면에 '잘렸다'고 표시한다. */
const FC_PROFILE_GAME_LIMIT = 1000;

export default async function FcProfile({ params, searchParams }: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ tab?: string; sort?: string; mode?: string; period?: string; from?: string; to?: string }>;
}) {
  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  const [person, people] = await Promise.all([getFcoPerson(slug), listFcoPeople()]);
  if (!person) notFound();
  const tab: ProfileTab = TABS.includes(sp.tab as ProfileTab) ? sp.tab as ProfileTab : "games";
  const modeKeys = await listFcoModesForPerson(person.id);
  const mode = sp.mode && modeKeys.includes(sp.mode) ? sp.mode : "all";
  const period = resolveRecordPeriod({ period: sp.period, from: sp.from, to: sp.to });
  const filter = { mode: mode === "all" ? undefined : mode, from: period.from, to: period.to };
  // ★ 개요·상대 전적·대회·스쿼드가 이 목록으로 집계된다. 상한에 걸리면 **오래된 경기부터 조용히 빠지므로** 걸렸다고 화면에 말한다
  //   (실측: 경기가 200건을 넘는 스트리머가 이미 여럿이다 — 김민교 500+, 도현 427, 클리드1 335).
  const [games, streamerGames] = period.error ? [[], []] : await Promise.all([
    listFcoGamesForPerson(person.id, FC_PROFILE_GAME_LIMIT, filter), listFcoStreamerGamesForPerson(person.id, FC_PROFILE_GAME_LIMIT, filter),
  ]);
  const gamesTruncated = games.length >= FC_PROFILE_GAME_LIMIT || streamerGames.length >= FC_PROFILE_GAME_LIMIT;
  const periodLabel = recordPeriodLabel(period);
  const modeLabel = mode === "all" ? "전체 경기" : FCO_MODE_LABEL[mode] ?? `모드 ${mode}`;

  const opponents = new Map<string, FcoOpponentRow>();
  const events = new Map<string, FcoProfileEventRow>();
  for (const game of streamerGames) {
    const mine = game.participants.find((participant) => participant.streamer_id === person.id);
    if (!mine) continue;
    const opponent = game.participants.find((participant) => participant.streamer_id && participant.streamer_id !== person.id);
    if (opponent?.streamer_slug) {
      const row = opponents.get(opponent.streamer_slug) ?? {
        id: opponent.streamer_id!, slug: opponent.streamer_slug, name: opponent.streamer_name ?? opponent.nickname,
        matches: [], vs_matches: 0, vs_match_wins: 0, vs_match_draws: 0, vs_match_unknown: 0,
        ally_matches: 0, last_met: game.played_at,
      };
      row.matches.push(game);
      row.vs_matches++;
      if (mine.outcome === "win") row.vs_match_wins++;
      if (mine.outcome === "draw") row.vs_match_draws++;
      if (mine.outcome === "unknown") row.vs_match_unknown++;
      if (game.played_at > row.last_met) row.last_met = game.played_at;
      opponents.set(row.slug, row);
    }
  }
  for (const game of games) {
    if (game.event_slug && game.event_name) {
      const row = events.get(game.event_slug) ?? {
        slug: game.event_slug, name: game.event_name, games: 0, wins: 0, draws: 0, losses: 0, unknown: 0,
        firstPlayed: game.played_at, lastPlayed: game.played_at,
      };
      const mine = game.participants.find((participant) => participant.streamer_id === person.id);
      if (!mine) continue;
      row.games++;
      if (mine.outcome === "win") row.wins++;
      if (mine.outcome === "draw") row.draws++;
      if (mine.outcome === "loss") row.losses++;
      if (mine.outcome === "unknown") row.unknown++;
      if (game.played_at < row.firstPlayed) row.firstPlayed = game.played_at;
      if (game.played_at > row.lastPlayed) row.lastPlayed = game.played_at;
      events.set(row.slug, row);
    }
  }
  const opponentSort = isOpponentSort(sp.sort) ? sp.sort : DEFAULT_OPPONENT_SORT;
  const sortedOpponents = sortOpponents([...opponents.values()], opponentSort);
  const sortedEvents = [...events.values()].sort((a, b) => b.lastPlayed.localeCompare(a.lastPlayed));

  const base = `/fc/s/${encodeURIComponent(person.slug)}`;
  const hrefFor = (next: { tab?: ProfileTab; mode?: string } = {}) => {
    const nextTab = next.tab ?? tab;
    const nextMode = next.mode ?? mode;
    const query = new URLSearchParams();
    if (nextTab !== "games") query.set("tab", nextTab);
    if (nextMode !== "all") query.set("mode", nextMode);
    if (sp.period) query.set("period", sp.period);
    if (sp.from) query.set("from", sp.from);
    if (sp.to) query.set("to", sp.to);
    if (nextTab === "opponents" && opponentSort !== DEFAULT_OPPONENT_SORT) query.set("sort", opponentSort);
    const params = query.toString();
    return params ? `${base}?${params}` : base;
  };
  const tabs: { key: ProfileTab; label: string; href: string }[] = [
    { key: "games", label: "매치 히스토리", href: hrefFor({ tab: "games" }) },
    { key: "opponents", label: "상대 전적", href: hrefFor({ tab: "opponents" }) },
    { key: "events", label: "대회", href: hrefFor({ tab: "events" }) },
    { key: "squad", label: "스쿼드", href: hrefFor({ tab: "squad" }) },
  ];

  return <RecordLayout sidebar={<aside className="record-sidebar record-sidebar-empty" aria-label="추가 정보" />}>
    <FcRecordSearch people={people} a={person.slug} versusPath={fcVersusIndexHref()} />
    <LinkedRecordFilters category={mode} categoryLabel="경기 모드" year="all" years={[]}
      categories={[{ value: "all", label: "전체 경기", href: hrefFor({ mode: "all" }) }, ...modeKeys.map((key) => ({
        value: key, label: FCO_MODE_LABEL[key] ?? `모드 ${key}`, href: hrefFor({ mode: key }),
      }))]}
      trailing={<RecordPeriodFilters key={`${period.key}:${period.from ?? ""}:${period.to ?? ""}`} href={hrefFor()} period={period} />} />
    <FcoPersonalOverview person={person} games={games} scopeLabel={`${modeLabel} · ${periodLabel} · 수집 경기 ${games.length}건 기준${gamesTruncated ? ` (최근 ${FC_PROFILE_GAME_LIMIT}건까지만 집계 — 더 오래된 경기는 빠져 있다)` : ""}`}
      eventHref={fcTournamentsIndexHref() ? (slug) => fcTournamentHref(slug)! : undefined} />
    <div id="record-content"><RecordSectionTabs items={tabs} active={tab} /></div>
    {tab === "games" && <RecordContentPanel className="fc-tab-panel">
        <h2>스트리머 간 경기 <small>{streamerGames.length}{streamerGames.length >= FC_PROFILE_GAME_LIMIT ? "+" : ""}경기</small></h2>
        <FcoMatchList games={streamerGames} perspectiveStreamerId={person.id} />
    </RecordContentPanel>}
    {tab === "opponents" && <RecordContentPanel className="arena-records">
        <OpponentHistoryHeading href={hrefFor({ tab: "opponents" })} period={period} laneOnly={false}
          categoryLabel={mode === "all" ? undefined : modeLabel} count={sortedOpponents.length} sort={opponentSort} />
        <FcoOpponentHistory rows={sortedOpponents} people={people} streamerId={person.id} streamerSlug={person.slug} streamerName={person.name} />
    </RecordContentPanel>}
    {tab === "events" && <RecordContentPanel>
        <SectionTitle hint={`${modeLabel} · ${periodLabel} · 확인 경기만 집계`}>대회 성적</SectionTitle>
        <FcoProfileEventList rows={sortedEvents} />
    </RecordContentPanel>}
    {tab === "squad" && <RecordContentPanel>
        <FcoSquadUsage games={games} streamerId={person.id} />
    </RecordContentPanel>}
  </RecordLayout>;
}
