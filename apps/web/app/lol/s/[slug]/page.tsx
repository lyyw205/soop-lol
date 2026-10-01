import Link from "next/link";
import { profileHref } from "@soop-lol/core/lib/site-paths";
import { OpponentHistoryHeading } from "@/components/opponent-history-filters";
import { OpponentModeToggle } from "@/components/record-period-filters";
import { OpponentHistoryList } from "@/components/opponent-history";
import { buildOpponentHistory } from "@soop-lol/core/lib/metrics/opponent-history";
import { recordPeriodLabel, resolveRecordPeriod } from "@soop-lol/core/lib/metrics/record-period";
import { Avatar } from "@/components/avatar";
import { notFound } from "next/navigation";
import { UpcomingSchedule } from "@/components/upcoming-schedule";
import { RecordLayout } from "../../../../../../packages/ui/record-layout";
import { RecordContentPanel } from "@/components/record-structure";
import { PersonalProfileInfo } from "@/components/personal-profile-info";
import { championById, championIconPath, formatRank } from "@soop-lol/core/lib/contract";
import { RecordSearch } from "../../../../../../packages/ui/record-search";
import { listPublicStreamerOptions, listPublicStreamers, listMatchRosters } from "@soop-lol/core/lib/contract";
import { listPersonalRecords, listPersonalMatches } from "@soop-lol/core/lib/db/personal";
import { CATEGORY_LABEL, isMatchCategoryFilter } from "@soop-lol/core/lib/metrics/category";
import { PersonalRecordFilters, PersonalRecordSummary, PersonalMatchHistory } from "@/components/personal-records";
import { versusIndexHref } from "@/lib/module-links";

import {
  getStreamerBySlug,
  listChampions,
  listChampionRecords,
  listOpponentGames,
  listProfileAccounts,
  listPublicChannels,
  listStreamerEvents,
  summarizePlacements,
} from "@soop-lol/core/lib/db/public";
import {
  DEFAULT_OPPONENT_SORT, isOpponentSort, sortOpponents, type OpponentSort,
} from "@soop-lol/core/lib/metrics/opponents";

import { PageShell, SectionTitle } from "@/components/public";
import { kstYear } from "@soop-lol/core/lib/time";
import {
  DEFAULT_PROFILE_TAB, EventList,
  isProfileTab,
  TabBar, type HrefFor, type ProfileTab,
} from "@/components/profile";
import { ChampionList } from "@/components/champion-table";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const s = await getStreamerBySlug(slug);
  return { title: s ? s.display_name : "스트리머" };
}

export default async function StreamerProfile({
  params, searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ year?: string; sort?: string; tab?: string; category?: string; page?: string; opponent?: string; period?: string; from?: string; to?: string; duel?: string }>;
}) {
  const { slug } = await params;
  const streamer = await getStreamerBySlug(slug);
  if (!streamer) notFound();

  // 값이 이상하면 무시하고 기본값으로 간다 —
  // 주소창에 아무거나 넣어도 화면이 깨지지 않아야 한다.
  const sp = await searchParams;
  const year = sp.year && /^\d{4}$/.test(sp.year) ? Number(sp.year) : undefined;
  const opponentSort: OpponentSort = isOpponentSort(sp.sort) ? sp.sort : DEFAULT_OPPONENT_SORT;
  const tab: ProfileTab = isProfileTab(sp.tab) ? sp.tab : DEFAULT_PROFILE_TAB;
  const category = sp.category && isMatchCategoryFilter(sp.category) ? sp.category : "all";
  const page = sp.page && /^\d{1,5}$/.test(sp.page) ? Math.max(1, Number(sp.page)) : 1;
  const matchPageSize = 20;
  // 기간은 상대 전적 전용이 아니다 — 매치 히스토리·챔피언 탭도 같은 값을 쓴다.
  const recordPeriod = resolveRecordPeriod({...sp, year});
  // 형식이 틀리면(`2026-13-01` 등) 필터가 에러를 띄우고 목록은 비운다. 잘못된 범위로
  // 질의하느니 아무것도 안 보여 주는 편이 낫다 — 걸러진 척하는 목록이 가장 나쁘다.
  const periodOk = !recordPeriod.error;
  const periodRange = periodOk ? { from: recordPeriod.from, to: recordPeriod.to } : {};
  const laneOnly = sp.duel === "lane";

  // 탭을 옮겨도 연도·정렬 선택이 살아 있어야 한다.
  //
  // ★ 이 주소로 가는 링크에는 전부 `scroll={false}` 를 단다.
  //   <Link> 는 기본이 scroll={true} 이고, 이동 시점에 Page 요소가 화면 밖이면
  //   **맨 위로 올려 버린다**(next/dist/docs .../components/link.md 의 `scroll` 항목).
  //   필터는 지금 보고 있는 자리를 지켜야 한다.
  const hrefFor: HrefFor = (next) => {
    const t = next.tab ?? tab;
    const y = next.year === undefined ? year : (next.year ?? undefined);
    const so = next.sort === undefined ? opponentSort : (next.sort ?? DEFAULT_OPPONENT_SORT);
    const c = next.category ?? category;
    const p = next.page ?? (next.tab !== undefined || next.category !== undefined || next.year !== undefined ? 1 : page);
    const q = new URLSearchParams();
    if (c !== "all") q.set("category", c);
    if (t === "games" && p > 1) q.set("page", String(p));
    if (sp.opponent) q.set("opponent", sp.opponent);
    if (t !== DEFAULT_PROFILE_TAB) q.set("tab", t);
    if (y) q.set("year", String(y));
    if (next.year === undefined) {
      if (sp.period) q.set("period", sp.period);
      if (sp.from) q.set("from", sp.from);
      if (sp.to) q.set("to", sp.to);
    }
    if (laneOnly) q.set("duel", "lane");
    if (so !== DEFAULT_OPPONENT_SORT) q.set("sort", so);
    return profileHref("lol", slug, q);
  };

  const id = streamer.streamer_id;

  // 탭별 본문만 읽고, 상단 통산 프로필은 모든 탭에서 공유한다.
  // ⚠ 기간이 틀린 채로 질의하면 **거르지 않은 목록**이 에러 문구와 함께 뜬다.
  //   상대 전적은 withinRecordPeriod 가 전부 false 를 내 자연히 비는데, 나머지 둘은
  //   SQL 이라 여기서 막아야 같은 동작이 된다.
  const needs = {
    events: tab === "events",
    opponents: tab === "opponents",
    opponentGames: tab === "opponents",
    champions: tab === "champions" && periodOk,
    games: tab === "games" && periodOk,
  };

  const allEventsPromise = listStreamerEvents(id);
  const allChampionsPromise = listChampions(id, 10);
  const [channels, accounts, events, placements, opponentPeople, opponentGames, champions, games, records, searchOptions, allEvents, allChampions] =
    await Promise.all([
      listPublicChannels(id),
      listProfileAccounts(id),
      needs.events ? (tab === "events" && year ? listStreamerEvents(id, year) : allEventsPromise) : [],
      // ★ 연도를 안 넘긴다. 수상 내역은 프로필 머리에 붙어 어느 탭에서도 같은 값이어야
      //   한다 — 연도를 누를 때마다 이름 옆 우승 횟수가 바뀌면 통산인지 그 해인지 모른다.
      summarizePlacements(id),
      needs.opponents ? listPublicStreamers() : [],
      needs.opponentGames ? listOpponentGames(id, undefined, category) : [],
      needs.champions ? listChampionRecords(id, 20, {category, ...periodRange}) : [],
      needs.games ? listPersonalMatches(id, {category, year, ...periodRange, limit: matchPageSize + 1, offset: (page-1)*matchPageSize}) : [],
      listPersonalRecords(id, {year}),
      listPublicStreamerOptions(),
      allEventsPromise,
      allChampionsPromise,
    ]);

  const sortedOpponents = sortOpponents(buildOpponentHistory(opponentGames, recordPeriod, laneOnly), opponentSort);

  const visibleGames = games.slice(0, matchPageSize);
  const matchRosters = await listMatchRosters(visibleGames.flatMap((game) => game.match_ids));

  const periodKey = `${recordPeriod.key}-${recordPeriod.from}-${recordPeriod.to}-${laneOnly}-${opponentSort}`;
  const periodLabel = recordPeriodLabel(recordPeriod);

  const topChampions = allChampions.slice(0, 5);
  /**
   * 카드 배경 = **모스트 1~3 중 하나.** 고정 그림(Thresh)이던 자리다.
   *
   * ★ 왜 무작위가 아닌가
   *   `Math.random()` 을 쓰면 서버와 클라이언트가 다른 그림을 골라 하이드레이션이 깨지고,
   *   새로고침마다 배경이 튄다. slug 의 글자 합으로 고르면 **사람마다 다르고 언제나 같다.**
   * ⚠ `champion_id = 0`(챔피언 미상)은 그림이 없으므로 후보에서 뺀다.
   */
  const artPool = topChampions.slice(0, 3).map((c) => championById(c.champion_id)?.en).filter((en): en is string => !!en);
  const profileArt = artPool.length
    ? artPool[[...slug].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % artPool.length]
    : undefined;

  /** 이름 위에 서는 게임 계정. 티어는 화면에 자리가 없어 툴팁으로 남긴다. */
  const accountNames = accounts.map((a) => ({
    key: a.puuid,
    name: a.game_name ?? "이름 미확인",
    title: `${a.game_name ?? "이름 미확인"}${a.tag_line ? `#${a.tag_line}` : ""} · ${a.label ?? (a.is_main ? "본계" : "부계")} · ${formatRank({ tier: a.tier, division: a.division, leaguePoints: a.league_points })}`,
  }));

  /** 이름 아래에 서는 방송 채널. `방송국명 | 주소` 한 줄. */
  const profileChannels = channels.map((channel) => {
    const url = channel.channel_url ?? (channel.platform === "soop" ? `https://ch.sooplive.co.kr/${encodeURIComponent(channel.channel_id)}` : null);
    const linkable = url && /^https?:\/\//i.test(url) ? url : null;
    return {
      key: `${channel.platform}:${channel.channel_id}`,
      platform: channel.platform,
      label: channel.platform === "soop" ? streamer.display_name
        : (channel.label && !["본채널", "부채널"].includes(channel.label) ? channel.label : streamer.display_name),
      // 주소는 `https://` 를 떼고 보여 준다 — 한 줄에 둘 이상 서면 스킴이 자리만 먹는다.
      shown: linkable ? linkable.replace(/^https?:\/\//i, "") : channel.channel_id,
      url: linkable,
    };
  });


  return (
    <>
      <PageShell>
        <RecordLayout
          // 개인 기록의 우측 컬럼 — 다가오는 일정(편성표). 없으면 빈 칸으로 본문 폭과 시선 축만 유지한다.
          sidebar={<UpcomingSchedule slug={slug} />}
        >
        <RecordSearch key={`${slug}-${sp.opponent ?? ""}`} options={searchOptions} a={slug} b={sp.opponent} mode="personal" versusPath={versusIndexHref()} category={category} year={year} />
        <PersonalRecordFilters key={periodKey} category={category} year={year} period={recordPeriod} hrefFor={hrefFor} />
        <PersonalRecordSummary records={records} category={category} art={profileArt}
          portrait={<Avatar name={streamer.display_name} src={streamer.profile_image_url} channelId={channels.find((c) => c.platform === "soop")?.channel_id} />}
          identity={<>
            {/* 이름 **위** 는 게임 계정, **아래** 는 방송 채널. 둘 다 예전엔 카드 아래쪽
                별도 칸이었는데, 한 사람의 신원이라 이름 옆에 붙는 편이 읽기 쉽다. */}
            {accountNames.length > 0 && <p className="personal-profile-accounts">{accountNames.map((a) => (
              <span key={a.key} title={a.title}>{a.name}</span>
            ))}</p>}
            <h2>{streamer.display_name}{streamer.is_pro && <small>前프로</small>}</h2>
            {profileChannels.length > 0 && <p className="personal-profile-channels">{profileChannels.map((c) => {
              /* 플랫폼 표식. 글리프가 확실한 글자만 쓴다 — 아이콘 폰트를 끌어오면
                 없는 글리프가 빈 네모로 나온다(Pretendard 서브셋에서 실제로 겪었다). */
              const mark = <i className="personal-profile-platform" data-platform={c.platform} aria-hidden="true">
                {c.platform === "youtube" ? "▶" : c.platform === "soop" ? "S" : "↗"}
              </i>;
              const body = <><b>{mark}{c.label}</b><span>{c.shown}</span></>;
              return c.url
                ? <a key={c.key} href={c.url} target="_blank" rel="noreferrer noopener" title={`${c.label} · ${c.platform}`}>{body}</a>
                : <span key={c.key} title={`${c.label} · ${c.platform}`}>{body}</span>;
            })}</p>}
          </>}
          details={<PersonalProfileInfo slug={slug} placements={placements}
            awards={allEvents.filter((e) => e.counts_toward_titles && (e.placement_rank === 1 || e.placement_rank === 2)).slice(0, 3).map((e) => ({id:e.event_slug, title:e.event_name, placement:e.placement, year:kstYear(new Date(e.starts_at)), team:e.team_name}))}
            champions={topChampions.map((c) => {
              const champion = championById(c.champion_id);
              return {id:c.champion_id, name:champion?.name ?? c.champion_name ?? "챔피언 미상", image:champion ? championIconPath(champion) : undefined, games:c.games};
            })} />}
        />

        {/* 탭 이름 옆에 개수를 적지 않는다 — 각 탭의 머리글이 이미 세고 있고, 탭은
            지금 탭의 것만 읽을 수 있어서 나머지는 빈칸이라 오히려 들쭉날쭉했다. */}
        <div id="record-content"><TabBar active={tab} hrefFor={hrefFor} /></div>

        {/* ── 대회 ── */}
        {tab === "events" && (
          <RecordContentPanel>
            <SectionTitle hint={`${year ? `${year}년` : "전체 기간"} · 카테고리 필터 제외`}>대회 성적</SectionTitle>
            <EventList events={events} year={year} />
          </RecordContentPanel>
        )}

        {/* ── 상대 전적 ── */}
        {tab === "opponents" && (
          <RecordContentPanel className="arena-records">
            {/* 제목 · 요약 · 조작을 한 줄에 둔다. 예전엔 세 줄이었는데 '상대' 라는 말이
                토글·요약·탭 이름에 세 번 나왔다. */}
            <OpponentHistoryHeading href={hrefFor({})} period={recordPeriod}
              categoryLabel={category === "all" ? undefined : CATEGORY_LABEL[category]} count={sortedOpponents.length} sort={opponentSort}
              laneToggle={<OpponentModeToggle href={hrefFor({})} laneOnly={laneOnly} />} />
            <OpponentHistoryList rows={sortedOpponents} people={opponentPeople} slug={slug} streamerName={streamer.display_name} category={category} period={recordPeriod} laneOnly={laneOnly} />
          </RecordContentPanel>
        )}

        {/* ── 챔피언 ── */}
        {tab === "champions" && (
          <RecordContentPanel>
            <SectionTitle hint={`${CATEGORY_LABEL[category]} · ${periodLabel}`}>모스트 챔피언</SectionTitle>
            <ChampionList champions={champions} />
          </RecordContentPanel>
        )}

        {/* ── 경기 ── */}
        {tab === "games" && (
          <RecordContentPanel className="arena-records" id="match-records">
            <SectionTitle hint={`${CATEGORY_LABEL[category]} · ${periodLabel} · 최신순`}>매치 히스토리</SectionTitle>
            <PersonalMatchHistory matches={visibleGames} rosters={matchRosters} streamerId={id} streamerName={streamer.display_name} />
            <nav className="personal-pagination" aria-label="매치 페이지">
              {page > 1 && <Link href={hrefFor({page:page-1})} scroll={false}>← 이전</Link>}
              <span>{page}페이지</span>
              {games.length > matchPageSize && <Link href={hrefFor({page:page+1})} scroll={false}>다음 →</Link>}
            </nav>
          </RecordContentPanel>
        )}
        </RecordLayout>
      </PageShell>
    </>
  );
}
