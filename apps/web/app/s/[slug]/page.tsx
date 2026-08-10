import Link from "next/link";
import { notFound } from "next/navigation";

import {
  getRankSeries,
  getStreamerBySlug,
  listChampions,
  listProfileAccounts,
  listPublicChannels,
  listRecentGames,
  listOpponents,
  listOpponentGames,
  listStreamerEvents,
  listStreamerYears,
  summarizePlacements,
} from "@soop-lol/core/lib/db/public";
import {
  DEFAULT_OPPONENT_SORT, isOpponentSort, sortOpponents, type OpponentSort,
} from "@soop-lol/core/lib/metrics/opponents";

import { EmptyLine, PageShell, RankChip, SectionTitle, SiteHeader } from "@/components/public";
import {
  AccountList, ChampionList, DEFAULT_PROFILE_TAB, EventList, GameList,
  isProfileTab, MoreLink, PlacementRibbon, OpponentCard, OpponentFilters, OpponentRowCompact,
  TabBar, TierSection, YearFilter, type HrefFor, type ProfileTab,
} from "@/components/profile";

export const dynamic = "force-dynamic";

/** 요약판에 몇 개씩 보여줄지. 전부 보여주면 요약이 아니다. */
const SUMMARY = { opponents: 5, events: 3, champions: 4, games: 5 } as const;

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const s = await getStreamerBySlug(slug);
  return { title: s ? s.display_name : "스트리머" };
}

export default async function StreamerProfile({
  params, searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ year?: string; sort?: string; tab?: string }>;
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
    const q = new URLSearchParams();
    if (t !== DEFAULT_PROFILE_TAB) q.set("tab", t);
    if (y) q.set("year", String(y));
    if (so !== DEFAULT_OPPONENT_SORT) q.set("sort", so);
    const qs = q.toString();
    return qs ? `/s/${slug}?${qs}` : `/s/${slug}`;
  };

  const id = streamer.streamer_id;

  // ★ 탭마다 필요한 것만 읽는다. 전에는 어느 섹션을 보든 열 개 질의가 다 나갔고,
  //   그중 `listOpponentGames` 는 조우한 **세트를 전부** 끌어온다. 요약판을 보려고
  //   그걸 읽을 이유가 없다.
  const needs = {
    events: tab === "summary" || tab === "events",
    opponents: tab === "summary" || tab === "opponents",
    opponentGames: tab === "opponents",
    champions: tab === "summary" || tab === "champions",
    games: tab === "summary" || tab === "games",
    series: tab === "summary",
  };

  const [channels, accounts, years, series, events, placements, opponents, opponentGames, champions, games] =
    await Promise.all([
      listPublicChannels(id),
      listProfileAccounts(id),
      listStreamerYears(id),
      needs.series ? getRankSeries(id) : [],
      needs.events ? listStreamerEvents(id, year) : [],
      // ★ 연도를 안 넘긴다. 수상 내역은 프로필 머리에 붙어 어느 탭에서도 같은 값이어야
      //   한다 — 연도를 누를 때마다 이름 옆 우승 횟수가 바뀌면 통산인지 그 해인지 모른다.
      summarizePlacements(id),
      needs.opponents ? listOpponents(id, { year }) : [],
      needs.opponentGames ? listOpponentGames(id, year) : [],
      needs.champions ? listChampions(id) : [],
      needs.games ? listRecentGames(id) : [],
    ]);

  // ★ 정렬은 TS 에서 한다. 승률 정렬이 베이지안 축소를 거쳐야 하고(§11-3),
  //   그 계산은 metrics/affinity.ts 한 곳에만 두기로 했다. SQL 은 세기만 한다.
  const sortedOpponents = sortOpponents(opponents, opponentSort);

  // 상대별로 갈라 둔다. 화면에서 상대마다 다시 훑지 않게 한 번만 접는다.
  const seriesByOpponent = new Map<string, typeof opponentGames>();
  for (const r of opponentGames) {
    const cur = seriesByOpponent.get(r.other_id) ?? [];
    cur.push(r);
    seriesByOpponent.set(r.other_id, cur);
  }

  const main = accounts[0];
  // 탭이 생기기 전 문구는 "대회 성적과 상대 전적에만 적용됩니다" 였는데, 이제 탭마다
  // 필터가 따로 있어 그 말이 안 맞는다. 대신 **맨 위 통산 수상 내역이 왜 안 바뀌는지**를
  // 적는다 — 그게 실제로 헷갈리는 지점이다.
  const yearNote = "이 목록에만 적용됩니다. 맨 위 수상 내역은 통산이라 연도와 무관합니다.";

  return (
    <>
      <SiteHeader />
      <PageShell>
        {/* ── 헤더 — 어느 탭에서도 보인다 ── */}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-semibold text-ink-200">{streamer.display_name}</h1>
              {streamer.is_pro && (
                <span className="rounded border border-ink-700 bg-ink-800 px-1.5 py-0.5 text-[11px] text-ink-400">
                  前프로
                </span>
              )}
            </div>
            {streamer.aliases.length > 0 && (
              <p className="mt-1 text-xs text-ink-400">별명 · {streamer.aliases.join(", ")}</p>
            )}
            <div className="mt-2 flex flex-wrap gap-2">
              {channels.map((c) => (
                <a
                  key={`${c.platform}:${c.channel_id}`}
                  href={c.channel_url ?? "#"}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="rounded-md border border-ink-700 bg-ink-800 px-2 py-0.5 text-[11px] text-ink-400 hover:text-ink-200"
                >
                  {c.platform} · {c.channel_id}
                </a>
              ))}
            </div>
            {/* 수상 내역 — 탭 안이 아니라 이름 바로 아래가 제자리다. 우승만 강조한다. */}
            <PlacementRibbon placements={placements} href={hrefFor({ tab: "events" })} />
          </div>
          {main && (
            <div className="text-right">
              <RankChip tier={main.tier} division={main.division} leaguePoints={main.league_points} />
              {main.wins !== null && (
                <p className="tabular mt-1 text-[11px] text-ink-400">
                  {main.wins}승 {main.losses}패
                </p>
              )}
            </div>
          )}
        </div>

        {/*
          탭 개수는 **지금 탭에서 읽은 것만** 적는다. 안 읽은 걸 0 으로 적으면
          "상대 0명" 이 사실처럼 보인다 — 모르는 건 안 적는 게 맞다.
        */}
        <TabBar
          active={tab}
          hrefFor={hrefFor}
          counts={{
            events: needs.events ? events.length : undefined,
            opponents: needs.opponents ? sortedOpponents.length : undefined,
            champions: needs.champions ? champions.length : undefined,
            games: needs.games ? games.length : undefined,
          }}
        />

        {/* ── 요약 ── */}
        {tab === "summary" && (
          <div className="mt-6 grid gap-8">
            <section>
              <SectionTitle hint="맞붙었을 때와 같은 팀이었을 때를 절대 섞지 않습니다">
                상대 전적
              </SectionTitle>
              {sortedOpponents.length === 0 ? (
                <EmptyLine>아직 다른 스트리머와 만난 기록이 없습니다.</EmptyLine>
              ) : (
                <>
                  <ul className="grid gap-2">
                    {sortedOpponents.slice(0, SUMMARY.opponents).map((r) => (
                      <OpponentRowCompact key={r.streamer_id} r={r} slug={slug} />
                    ))}
                  </ul>
                  <MoreLink href={hrefFor({ tab: "opponents" })}>
                    상대 {sortedOpponents.length}명 전부 보기
                  </MoreLink>
                </>
              )}
            </section>

            <section>
              <SectionTitle hint="주최측이 발표한 기록">대회 성적</SectionTitle>
              <EventList events={events.slice(0, SUMMARY.events)} year={year} />
              {events.length > SUMMARY.events && (
                <MoreLink href={hrefFor({ tab: "events" })}>대회 {events.length}개 전부 보기</MoreLink>
              )}
            </section>

            <TierSection points={series} />

            <section>
              <SectionTitle hint="전체 기간">모스트 챔피언</SectionTitle>
              <ChampionList champions={champions.slice(0, SUMMARY.champions)} />
              {champions.length > SUMMARY.champions && (
                <MoreLink href={hrefFor({ tab: "champions" })}>
                  챔피언 {champions.length}개 전부 보기
                </MoreLink>
              )}
            </section>

            <section>
              <SectionTitle hint="공개 큐만">최근 경기</SectionTitle>
              <GameList games={games.slice(0, SUMMARY.games)} />
              {games.length > SUMMARY.games && (
                <MoreLink href={hrefFor({ tab: "games" })}>경기 {games.length}건 전부 보기</MoreLink>
              )}
            </section>

            <AccountList accounts={accounts} />
          </div>
        )}

        {/* ── 대회 ── */}
        {tab === "events" && (
          <section className="mt-6">
            <SectionTitle hint="주최측이 발표한 기록">대회 성적</SectionTitle>
            <YearFilter years={years} year={year} hrefFor={hrefFor} note={yearNote} />
            <EventList events={events} year={year} />
          </section>
        )}

        {/* ── 상대 전적 — 이 사이트의 훅 ── */}
        {tab === "opponents" && (
          <section className="mt-6">
            <SectionTitle hint="맞붙었을 때와 같은 팀이었을 때를 절대 섞지 않습니다">
              상대 전적
            </SectionTitle>
            {/* 상대가 0명이어도 필터는 남긴다 — 연도를 잘못 걸어 0명이 됐을 때
                필터가 사라지면 되돌릴 방법이 없다. */}
            {(sortedOpponents.length > 0 || year !== undefined) && (
              <OpponentFilters
                sort={opponentSort}
                years={years}
                year={year}
                hrefFor={hrefFor}
                total={sortedOpponents.length}
              />
            )}
            {sortedOpponents.length === 0 ? (
              <EmptyLine>
                {year ? `${year}년에 만난 스트리머가 없습니다.` : "아직 다른 스트리머와 만난 기록이 없습니다."}
              </EmptyLine>
            ) : (
              <ul className="grid gap-2">
                {sortedOpponents.map((r) => {
                  const mine = seriesByOpponent.get(r.streamer_id) ?? [];
                  return (
                    <OpponentCard
                      key={r.streamer_id}
                      r={r}
                      slug={slug}
                      streamerName={streamer.display_name}
                      vsRows={mine.filter((x) => x.relation === "opponent")}
                      allyRows={mine.filter((x) => x.relation === "ally")}
                    />
                  );
                })}
              </ul>
            )}
          </section>
        )}

        {/* ── 챔피언 ── */}
        {tab === "champions" && (
          <section className="mt-6">
            <SectionTitle hint="전체 기간 · 연도 필터가 걸리지 않습니다">모스트 챔피언</SectionTitle>
            <ChampionList champions={champions} />
          </section>
        )}

        {/* ── 경기 ── */}
        {tab === "games" && (
          <section className="mt-6">
            <SectionTitle hint="공개 큐만">최근 경기</SectionTitle>
            <GameList games={games} />
          </section>
        )}

        {/* 탭을 옮겨도 다른 스트리머로 새로 들어온 사람은 여기서 돌아간다. */}
        <div className="mt-10 text-[11px] text-ink-500">
          <Link href="/streamers" className="hover:text-ink-300">
            ← 스트리머 목록
          </Link>
        </div>
      </PageShell>
    </>
  );
}
