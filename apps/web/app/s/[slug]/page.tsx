import Link from "next/link";
import { notFound } from "next/navigation";

import {
  getRankSeries,
  getStreamerBySlug,
  listChampions,
  listProfileAccounts,
  listPublicChannels,
  listRecentGames,
  listRivals,
  listRivalGames,
  listStreamerEvents,
  listStreamerYears,
  summarizePlacements,
} from "@soop-lol/core/lib/db/public";
import {
  DEFAULT_RIVAL_SORT, isRivalSort, RIVAL_SORTS, sortRivals,
} from "@soop-lol/core/lib/metrics/rivals";
import { POSITION_LABEL, type Position } from "@soop-lol/core/lib/riot/types";

import {
  DualRecord,
  EmptyLine, Kda, PageShell, PositionTag, QueueTag, RankChip, RecordBar,
  SectionTitle, SiteHeader, TierChart, WinPill, relativeDate,
} from "@/components/public";
import { SeriesLog } from "@/components/series-log";

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
  searchParams: Promise<{ year?: string; sort?: string }>;
}) {
  const { slug } = await params;
  const streamer = await getStreamerBySlug(slug);
  if (!streamer) notFound();

  // 연도 필터와 집계 단위. 값이 이상하면 무시하고 기본값으로 간다 —
  // 주소창에 아무거나 넣어도 화면이 깨지지 않아야 한다.
  const sp = await searchParams;
  const year = sp.year && /^\d{4}$/.test(sp.year) ? Number(sp.year) : undefined;
  const rivalSort = isRivalSort(sp.sort) ? sp.sort : DEFAULT_RIVAL_SORT;
  // 한쪽 필터를 눌러도 다른 쪽 선택이 살아 있어야 한다.
  const linkTo = (next: { year?: number | null; sort?: string | null } = {}) => {
    const y = next.year === undefined ? year : (next.year ?? undefined);
    const so = next.sort === undefined ? rivalSort : (next.sort ?? DEFAULT_RIVAL_SORT);
    const q = new URLSearchParams();
    if (y) q.set("year", String(y));
    if (so !== DEFAULT_RIVAL_SORT) q.set("sort", so);
    const qs = q.toString();
    return qs ? `/s/${slug}?${qs}` : `/s/${slug}`;
  };

  const [channels, accounts, series, champions, games, rivals, events, years, rivalGames, placements] =
    await Promise.all([
    listPublicChannels(streamer.streamer_id),
    listProfileAccounts(streamer.streamer_id),
    getRankSeries(streamer.streamer_id),
    listChampions(streamer.streamer_id),
    listRecentGames(streamer.streamer_id),
    listRivals(streamer.streamer_id, { year }),
    listStreamerEvents(streamer.streamer_id, year),
    listStreamerYears(streamer.streamer_id),
    listRivalGames(streamer.streamer_id, year),
    summarizePlacements(streamer.streamer_id, year),
  ]);

  // 상대별로 갈라 둔다. 화면에서 라이벌마다 다시 훑지 않게 한 번만 접는다.
  const seriesByRival = new Map<string, typeof rivalGames>();
  for (const r of rivalGames) {
    const cur = seriesByRival.get(r.other_id) ?? [];
    cur.push(r);
    seriesByRival.set(r.other_id, cur);
  }

  // ★ 정렬은 TS 에서 한다. 승률 정렬이 베이지안 축소를 거쳐야 하고(§11-3),
  //   그 계산은 metrics/affinity.ts 한 곳에만 두기로 했다. SQL 은 세기만 한다.
  const sortedRivals = sortRivals(rivals, rivalSort);

  const main = accounts[0];

  return (
    <>
      <SiteHeader />
      <PageShell>
        {/* ── 헤더 ── */}
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

        {/* ── 계정 ── */}
        {/* ── 대회 성적 요약 — 이 사람이 뭘 했는지 한 줄로 ── */}
        {placements.total > 0 && (
          <section className="mt-8 rounded-xl border border-ink-800 bg-ink-900/60 px-4 py-4">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-sm font-medium text-ink-200">
                대회 {placements.total}회 참가
                {year && <span className="ml-1 text-[11px] text-ink-400">· {year}년</span>}
              </span>
              {placements.unknown > 0 && (
                <span className="text-[11px] text-ink-500">
                  순위를 확인하지 못한 대회 {placements.unknown}회는 세지 않았습니다
                </span>
              )}
            </div>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
              {placements.buckets.map((b) => (
                <div
                  key={b.key}
                  className={`rounded-lg border px-3 py-2 text-center ${
                    b.count > 0 && b.key === "champion"
                      ? "border-amber-400/40 bg-amber-400/10"
                      : b.count > 0
                        ? "border-ink-700 bg-ink-800/40"
                        : "border-ink-800/60"
                  }`}
                >
                  <div className={`tabular text-lg font-semibold ${
                    b.count === 0 ? "text-ink-600" : b.key === "champion" ? "text-amber-300" : "text-ink-200"
                  }`}>
                    {b.count}
                  </div>
                  <div className="text-[11px] text-ink-400">{b.label}</div>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="mt-8">
          <SectionTitle hint="본인이 공개한 근거가 있는 계정만 표시합니다">계정</SectionTitle>
          <ul className="grid gap-2 sm:grid-cols-2">
            {accounts.map((a) => (
              <li key={a.puuid} className="flex items-center justify-between gap-3 rounded-xl border border-ink-800 bg-ink-900/60 px-4 py-3">
                <div className="min-w-0">
                  <div className="truncate text-sm text-ink-200">
                    {a.game_name}<span className="text-ink-400">#{a.tag_line}</span>
                  </div>
                  <div className="text-[11px] text-ink-400">{a.label ?? (a.is_main ? "본계" : "부계")}</div>
                </div>
                <RankChip tier={a.tier} division={a.division} leaguePoints={a.league_points} />
              </li>
            ))}
          </ul>
        </section>

        {/* ── 티어 추이 ── */}
        <section className="mt-8">
          <SectionTitle hint="매일 09:00 KST 스냅샷">티어 추이</SectionTitle>
          <div className="rounded-xl border border-ink-800 bg-ink-900/60 p-4">
            <TierChart points={series} />
          </div>
        </section>

        {/* ── 연도 필터 ── */}
        {years.length > 1 && (
          <section className="mt-8 rounded-xl border border-ink-800 bg-ink-900/40 px-4 py-3">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] text-ink-400">연도</span>
                <Link
                  href={linkTo({ year: null })}
                  className={`rounded-full border px-3 py-1 text-xs ${
                    year === undefined
                      ? "border-accent-400/50 bg-accent-400/10 text-accent-300"
                      : "border-ink-800 text-ink-400 hover:text-ink-200"
                  }`}
                >
                  전체
                </Link>
                {years.map((y) => (
                  <Link
                    key={y}
                    href={linkTo({ year: y })}
                    className={`rounded-full border px-3 py-1 text-xs ${
                      year === y
                        ? "border-accent-400/50 bg-accent-400/10 text-accent-300"
                        : "border-ink-800 text-ink-400 hover:text-ink-200"
                    }`}
                  >
                    {y}
                  </Link>
                ))}
              </div>
              <p className="mt-2 text-[11px] text-ink-400">
                대회 성적과 라이벌에만 적용됩니다. 티어 추이·모스트 챔피언은 전체 기간입니다.
                라이벌 아래에도 같은 필터가 있습니다 — 둘은 같은 값을 씁니다.
              </p>
            </div>
          </section>
        )}

        {/* ── 대회 성적 ── */}
        <section className="mt-8">
          <SectionTitle hint="주최측이 발표한 기록">대회 성적</SectionTitle>
          {events.length === 0 ? (
            <EmptyLine>
              {year ? `${year}년에 나간 대회가 없습니다.` : "아직 대회 기록이 없습니다."}
            </EmptyLine>
          ) : (
            <ul className="grid gap-2">
              {events.map((e) => (
                <li key={e.event_slug} className="rounded-xl border border-ink-800 bg-ink-900/60 px-4 py-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <span className="font-medium text-ink-200">{e.event_name}</span>
                    <span className="text-[11px] text-ink-400">
                      {e.placement && (
                        <span
                          className={`mr-2 rounded px-1.5 py-0.5 ${
                            e.placement_rank === 1
                              ? "border border-amber-400/40 bg-amber-400/10 text-amber-300"
                              : "border border-ink-700 text-ink-300"
                          }`}
                        >
                          {e.placement}
                        </span>
                      )}
                      {e.team_name && <span className="text-ink-300">{e.team_name}</span>}
                      {e.position && <span className="ml-1">· {POSITION_LABEL[e.position as Position] ?? e.position}</span>}
                      <span className="ml-2">{new Date(e.starts_at).getFullYear()}</span>
                    </span>
                  </div>
                  {/*
                    경기가 0건인 이유는 세 가지고, 셋은 전혀 다른 말이다.
                      · 예선 탈락(99)      — 본선에 못 올라갔다. 기록이 없는 게 아니라 **없는 게 기록**이다.
                      · 본선 순위가 있는데 0 — 올라갔는데 우리가 경기를 못 붙였다. 우리 쪽 구멍이다.
                      · 순위 자체를 모름    — 둘 중 뭔지 우리도 모른다. 모른다고 적는다.
                    한 문장으로 뭉뚱그리면 예선에서 떨어진 사람이 데이터 결함처럼 보인다.
                  */}
                  {e.matches === 0 ? (
                    <p className="tabular mt-2 text-[11px] text-ink-400">
                      {e.placement_rank === 99
                        ? "예선에서 탈락해 본선 경기가 없습니다."
                        : e.placement_rank == null
                          ? "본선 경기 기록이 없습니다 — 예선에서 탈락했는지, 우리가 경기를 못 붙였는지는 확인하지 못했습니다."
                          : "명단에는 있으나 경기 기록을 붙이지 못했습니다 — 라이엇 계정을 확인하지 못한 참가자입니다."}
                    </p>
                  ) : (
                    <p className="tabular mt-2 text-sm text-ink-300">
                      매치 {e.match_wins}승
                      {e.match_draws > 0 && ` ${e.match_draws}무`}
                      {" "}{e.matches - e.match_wins - e.match_draws}패
                      <span className="ml-3 text-[11px] text-ink-500">
                        세트로는 {e.set_wins}승 {e.sets - e.set_wins}패
                      </span>
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ── 라이벌 — 이 사이트의 훅 ── */}
        <section className="mt-8">
          <SectionTitle hint="맞붙었을 때와 같은 팀이었을 때를 절대 섞지 않습니다">라이벌</SectionTitle>

          {/*
            정렬·연도를 여기에 같이 둔다. 위로 올라가 필터를 고치고 다시 내려오는 게
            제일 번거롭다. 연도는 위 필터와 **같은 값**을 쓴다 — 두 개를 따로 두면
            어느 쪽이 맞는지 알 수 없게 된다.
          */}
          {rivals.length > 0 && (
            <div className="mb-3 rounded-xl border border-ink-800 bg-ink-900/40 px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-8 shrink-0 text-[11px] text-ink-400">정렬</span>
                {RIVAL_SORTS.map((o) => (
                  <Link
                    key={o.key}
                    href={linkTo({ sort: o.key })}
                    title={o.hint}
                    className={`rounded-full border px-3 py-1 text-xs ${
                      rivalSort === o.key
                        ? "border-accent-400/50 bg-accent-400/10 text-accent-300"
                        : "border-ink-800 text-ink-400 hover:text-ink-200"
                    }`}
                  >
                    {o.label}
                  </Link>
                ))}
              </div>
              {years.length > 1 && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <span className="w-8 shrink-0 text-[11px] text-ink-400">연도</span>
                  <Link
                    href={linkTo({ year: null })}
                    className={`rounded-full border px-3 py-1 text-xs ${
                      year === undefined
                        ? "border-accent-400/50 bg-accent-400/10 text-accent-300"
                        : "border-ink-800 text-ink-400 hover:text-ink-200"
                    }`}
                  >
                    전체
                  </Link>
                  {years.map((y) => (
                    <Link
                      key={y}
                      href={linkTo({ year: y })}
                      className={`rounded-full border px-3 py-1 text-xs ${
                        year === y
                          ? "border-accent-400/50 bg-accent-400/10 text-accent-300"
                          : "border-ink-800 text-ink-400 hover:text-ink-200"
                      }`}
                    >
                      {y}
                    </Link>
                  ))}
                </div>
              )}
              <p className="mt-2 text-[11px] text-ink-500">
                {RIVAL_SORTS.find((o) => o.key === rivalSort)?.hint} · 상대 {sortedRivals.length}명
              </p>
            </div>
          )}

          {rivals.length === 0 ? (
            <EmptyLine>
              {year ? `${year}년에 만난 스트리머가 없습니다.` : "아직 다른 스트리머와 만난 기록이 없습니다."}
            </EmptyLine>
          ) : (
            <ul className="grid gap-2">
              {sortedRivals.map((r) => {
                const mine = seriesByRival.get(r.streamer_id) ?? [];
                const vsRows = mine.filter((x) => x.relation === "opponent");
                const allyRows = mine.filter((x) => x.relation === "ally");
                return (
                <li key={r.streamer_id} className="rounded-xl border border-ink-800 bg-ink-900/60">
                  {/*
                    ★ 접어 둔다. 상대가 수십 명이면 다 펴 놓은 목록은 못 읽는다.
                      대신 접힌 줄만 보고도 "누구를, 몇 승 몇 패로" 가 보여야 접는 뜻이 있다.
                      요약 줄에는 링크를 넣지 않는다 — 누르면 펼침과 이동이 겹친다.
                  */}
                  <details className="group">
                    <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 hover:bg-ink-800/30">
                      <span className="text-ink-500 transition-transform group-open:rotate-90">›</span>
                      <span className="font-medium text-ink-200">vs {r.display_name}</span>
                      <span className="tabular text-[11px] text-ink-400">
                        {r.vs_matches > 0 ? (
                          <>
                            맞대결 {r.vs_match_wins}승
                            {r.vs_match_draws > 0 && ` ${r.vs_match_draws}무`}
                            {" "}{r.vs_matches - r.vs_match_wins - r.vs_match_draws}패
                          </>
                        ) : (
                          "맞대결 없음"
                        )}
                        {r.ally_matches > 0 && (
                          <span className="ml-2 text-ink-500">
                            · 같은 팀 {r.ally_match_wins}승{" "}
                            {r.ally_matches - r.ally_match_wins - r.ally_match_draws}패
                          </span>
                        )}
                      </span>
                      <span className="ml-auto text-[11px] text-ink-400">
                        마지막 {relativeDate(r.last_met)}
                      </span>
                    </summary>

                    <div className="px-4 pb-3">
                      <Link
                        href={`/vs/${slug}/${r.slug}`}
                        className="text-[11px] text-ink-400 hover:text-accent-400"
                      >
                        {streamer.display_name} vs {r.display_name} 상대전적 페이지 →
                      </Link>

                  {/*
                    ★ 두 블록을 시각적으로 가른다. 같은 팀 승리를 상대전적에 섞으면
                      '이겼다' 의 뜻이 달라진다 — 하나는 그 사람을 이긴 것이고
                      다른 하나는 그 사람과 같이 이긴 것이다.
                  */}
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <div className="rounded-lg border border-rose-500/25 bg-rose-500/[0.04] p-3">
                      <div className="mb-2 text-[11px] font-medium text-rose-300/90">맞붙었을 때</div>
                      {r.vs_matches === 0 ? (
                        <p className="text-[11px] text-ink-400">상대편으로 만난 적이 없습니다.</p>
                      ) : (
                        <>
                          <div className="mb-1 text-[11px] text-ink-400">
                            팀 상대전적 <span className="text-ink-500">· 상대편에 있었던 전부</span>
                          </div>
                          <DualRecord
                            label="상대"
                            match={{
                          wins: r.vs_match_wins,
                          draws: r.vs_match_draws,
                          losses: r.vs_matches - r.vs_match_wins - r.vs_match_draws,
                        }}
                            set={{ wins: r.vs_set_wins, losses: r.vs_sets - r.vs_set_wins }}
                          />
                          {r.lane_matches > 0 && (
                            <div className="mt-3 border-t border-ink-800 pt-3">
                              <div className="mb-1 text-[11px] text-ink-400">
                                1:1 맞라인 <span className="text-ink-500">· 같은 라인끼리만</span>
                              </div>
                              <DualRecord
                                label="맞라인"
                                match={{
                                  wins: r.lane_match_wins,
                                  draws: r.lane_match_draws,
                                  losses: r.lane_matches - r.lane_match_wins - r.lane_match_draws,
                                }}
                                set={{ wins: r.lane_set_wins, losses: r.lane_sets - r.lane_set_wins }}
                              />
                            </div>
                          )}
                          <SeriesLog games={vsRows} label="맞붙은" />
                        </>
                      )}
                    </div>

                    <div className="rounded-lg border border-sky-500/25 bg-sky-500/[0.04] p-3">
                      <div className="mb-2 text-[11px] font-medium text-sky-300/90">같은 팀이었을 때</div>
                      {r.ally_matches === 0 ? (
                        <p className="text-[11px] text-ink-400">같은 팀이었던 적이 없습니다.</p>
                      ) : (
                        <>
                          <div className="mb-1 text-[11px] text-ink-400">
                            함께 뛴 승률 <span className="text-ink-500">· 같이 이긴 것</span>
                          </div>
                          <DualRecord
                            label="같은 팀"
                            match={{
                              wins: r.ally_match_wins,
                              draws: r.ally_match_draws,
                              losses: r.ally_matches - r.ally_match_wins - r.ally_match_draws,
                            }}
                            set={{ wins: r.ally_set_wins, losses: r.ally_sets - r.ally_set_wins }}
                          />
                          <SeriesLog games={allyRows} label="같은 팀으로" />
                        </>
                      )}
                    </div>
                  </div>
                    </div>
                  </details>
                </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* ── 모스트 챔피언 ── */}
        <section className="mt-8">
          <SectionTitle hint="전체 기간">모스트 챔피언</SectionTitle>
          {champions.length === 0 ? (
            <EmptyLine>아직 집계된 챔피언이 없습니다.</EmptyLine>
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2">
              {champions.map((c) => {
                const losses = c.games - c.wins;
                return (
                  <li key={c.champion_id} className="rounded-xl border border-ink-800 bg-ink-900/60 px-4 py-3">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-sm text-ink-200">{c.champion_name ?? `챔피언 ${c.champion_id}`}</span>
                      <Kda k={Math.round(c.kills / c.games)} d={Math.round(c.deaths / c.games)} a={Math.round(c.assists / c.games)} />
                    </div>
                    <div className="mt-2">
                      <RecordBar record={{ wins: c.wins, losses }} />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* ── 최근 경기 ── */}
        <section className="mt-8">
          <SectionTitle hint="공개 큐만">최근 경기</SectionTitle>
          {games.length === 0 ? (
            <EmptyLine>아직 수집된 경기가 없습니다.</EmptyLine>
          ) : (
            <ul className="divide-y divide-ink-800 rounded-xl border border-ink-800 bg-ink-900/60">
              {games.map((g) => (
                <li key={g.match_id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                  <WinPill win={g.win} />
                  <span className="min-w-0 flex-1 truncate text-sm text-ink-200">
                    {g.champion_name ?? `챔피언 ${g.champion_id}`}
                  </span>
                  <PositionTag position={g.team_position} />
                  <Kda k={g.kills} d={g.deaths} a={g.assists} />
                  <span className="tabular text-[11px] text-ink-400">CS {g.cs ?? "—"}</span>
                  <QueueTag queueId={g.queue_id} />
                  <span className="text-[11px] text-ink-400">{relativeDate(g.game_creation)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </PageShell>
    </>
  );
}
