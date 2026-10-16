import Link from "next/link";
import { recordCursor } from "@soop-lol/core/lib/metrics/record-cursor";
import { notFound } from "next/navigation";
import { profileHref } from "@soop-lol/core/lib/site-paths";
import { getFcoPerson, getFcoPersonalSummary, listFcoPersonalEvents, listFcoGamesForPerson, listFcoModesForPerson, listFcoPeople, listFcoStreamerGamesForPerson } from "@soop-lol/core/lib/db/fconline";
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
import { ProfileSidebar } from "@/components/profile-sidebar";
import { RecordLayout } from "../../../../../../packages/ui/record-layout";
import { LinkedRecordFilters } from "../../../../../../packages/ui/record-filters";
import { RecordPeriodFilters } from "@/components/record-period-filters";
import { recordPeriodLabel, resolveRecordPeriod } from "@soop-lol/core/lib/metrics/record-period";
import { FCO_MODE_LABEL } from "@soop-lol/core/lib/games/fconline/view";

export const dynamic = "force-dynamic";
export const metadata = { title: { absolute: "FC 온라인 개인기록 · SOOP SEEK" } };

const TABS = ["games", "opponents", "events", "squad"] as const;
type ProfileTab = typeof TABS[number];

const FC_PROFILE_PAGE_SIZE = 20;

export default async function FcProfile({ params, searchParams }: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ tab?: string; sort?: string; mode?: string; cursor?: string; period?: string; from?: string; to?: string }>;
}) {
  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  const [person, people] = await Promise.all([getFcoPerson(slug), listFcoPeople()]);
  if (!person) notFound();
  const tab: ProfileTab = TABS.includes(sp.tab as ProfileTab) ? sp.tab as ProfileTab : "games";
  const modeKeys = await listFcoModesForPerson(person.id);
  const mode = sp.mode && modeKeys.includes(sp.mode) ? sp.mode : "all";
  const period = resolveRecordPeriod({ period: sp.period, from: sp.from, to: sp.to });
  const filter = { mode: mode === "all" ? undefined : mode, from: period.from, to: period.to };
  const [games, streamerGames, summary, scopedEvents, careerEvents] = await Promise.all([
    !period.error && tab === "squad" ? listFcoGamesForPerson(person.id, null, filter) : [],
    !period.error && (tab === "games" || tab === "opponents")
      ? listFcoStreamerGamesForPerson(person.id, tab === "opponents" ? null : FC_PROFILE_PAGE_SIZE + 1, filter, tab === "games" ? sp.cursor : undefined) : [],
    !period.error ? getFcoPersonalSummary(person.id, filter) : null,
    !period.error && tab === "events" ? listFcoPersonalEvents(person.id, filter) : [],
    listFcoPersonalEvents(person.id),
  ]);
  const groups = [...new Set(streamerGames.map(g => g.series_id ?? g.id))];
  const visibleGroups = new Set(groups.slice(0, FC_PROFILE_PAGE_SIZE));
  const visibleGames = streamerGames.filter(g => visibleGroups.has(g.series_id ?? g.id));
  const lastGroup = groups[FC_PROFILE_PAGE_SIZE - 1];
  const lastGroupAt = streamerGames.filter(g => (g.series_id ?? g.id) === lastGroup).map(g => new Date(g.played_at)).sort((a,b) => +a - +b)[0];
  const nextCursor = groups.length > FC_PROFILE_PAGE_SIZE ? recordCursor(lastGroupAt, lastGroup) : null;
  const periodLabel = recordPeriodLabel(period);
  const modeLabel = mode === "all" ? "전체 경기" : FCO_MODE_LABEL[mode] ?? `모드 ${mode}`;

  const opponents = new Map<string, FcoOpponentRow>();
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
  const opponentSort = isOpponentSort(sp.sort) ? sp.sort : DEFAULT_OPPONENT_SORT;
  const sortedOpponents = sortOpponents([...opponents.values()], opponentSort);
  // Postgres timestamptz는 드라이버에서 Date로 올 수도 있어 문자열 메서드를 쓰지 않는다.
  const sortedEvents = scopedEvents;

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
    return profileHref("fconline", person.slug, query);
  };
  const tabs: { key: ProfileTab; label: string; href: string }[] = [
    { key: "games", label: "매치 히스토리", href: hrefFor({ tab: "games" }) },
    { key: "opponents", label: "상대 전적", href: hrefFor({ tab: "opponents" }) },
    { key: "events", label: "CK · 대회", href: hrefFor({ tab: "events" }) },
    { key: "squad", label: "스쿼드", href: hrefFor({ tab: "squad" }) },
  ];

  return <RecordLayout sidebar={<ProfileSidebar slug={person.slug} game="fconline" />}>
    <FcRecordSearch people={people} a={person.slug} versusPath={fcVersusIndexHref()} />
    <LinkedRecordFilters category={mode} categoryLabel="경기 모드" year="all" years={[]}
      categories={[{ value: "all", label: "전체 경기", href: hrefFor({ mode: "all" }) }, ...modeKeys.map((key) => ({
        value: key, label: FCO_MODE_LABEL[key] ?? `모드 ${key}`, href: hrefFor({ mode: key }),
      }))]}
      trailing={<RecordPeriodFilters key={`${period.key}:${period.from ?? ""}:${period.to ?? ""}`} href={hrefFor()} period={period} />} />
    <FcoPersonalOverview person={person} stats={summary} careerEvents={careerEvents}
      scopeLabel={`${modeLabel} · ${periodLabel}`} eventHref={fcTournamentsIndexHref() ? (slug) => fcTournamentHref(slug)! : undefined} />
    <div id="record-content"><RecordSectionTabs items={tabs} active={tab} /></div>
    {tab === "games" && <RecordContentPanel className="fc-tab-panel">
        <h2>스트리머 간 경기</h2>
        <FcoMatchList games={visibleGames} perspectiveStreamerId={person.id} />
        <nav className="personal-pagination" aria-label="경기 이어 보기">
          {sp.cursor && <Link href={hrefFor()}>처음으로</Link>}
          {nextCursor && <Link href={`${hrefFor()}${hrefFor().includes("?") ? "&" : "?"}cursor=${encodeURIComponent(nextCursor)}`}>이전 기록 더 보기 →</Link>}
        </nav>
    </RecordContentPanel>}
    {tab === "opponents" && <RecordContentPanel className="arena-records">
        <OpponentHistoryHeading href={hrefFor({ tab: "opponents" })} period={period}
          categoryLabel={mode === "all" ? undefined : modeLabel} count={sortedOpponents.length} sort={opponentSort} />
        <FcoOpponentHistory rows={sortedOpponents} people={people} streamerId={person.id} streamerSlug={person.slug} streamerName={person.name} />
    </RecordContentPanel>}
    {tab === "events" && <RecordContentPanel>
        <SectionTitle hint={`${modeLabel} · ${periodLabel} · 확인 경기만 집계`}>CK · 대회 성적</SectionTitle>
        <FcoProfileEventList rows={sortedEvents} />
    </RecordContentPanel>}
    {tab === "squad" && <RecordContentPanel>
        <FcoSquadUsage games={games} streamerId={person.id} />
    </RecordContentPanel>}
  </RecordLayout>;
}
