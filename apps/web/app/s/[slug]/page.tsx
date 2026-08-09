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
} from "@soop-lol/core/lib/db/public";

import {
  EmptyLine, Kda, PageShell, PositionTag, QueueTag, RankChip, RecordBar,
  SectionTitle, SiteHeader, TierChart, WinPill, relativeDate,
} from "@/components/public";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const s = await getStreamerBySlug(slug);
  return { title: s ? s.display_name : "스트리머" };
}

export default async function StreamerProfile({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const streamer = await getStreamerBySlug(slug);
  if (!streamer) notFound();

  const [channels, accounts, series, champions, games, rivals] = await Promise.all([
    listPublicChannels(streamer.streamer_id),
    listProfileAccounts(streamer.streamer_id),
    getRankSeries(streamer.streamer_id),
    listChampions(streamer.streamer_id),
    listRecentGames(streamer.streamer_id),
    listRivals(streamer.streamer_id),
  ]);

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

        {/* ── 라이벌 — 이 사이트의 훅 ── */}
        <section className="mt-8">
          <SectionTitle hint="같은 경기에서 만난 스트리머">라이벌</SectionTitle>
          {rivals.length === 0 ? (
            <EmptyLine>아직 다른 스트리머와 만난 기록이 없습니다.</EmptyLine>
          ) : (
            <ul className="grid gap-2">
              {rivals.map((r) => (
                <li key={r.streamer_id} className="rounded-xl border border-ink-800 bg-ink-900/60 px-4 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <Link href={`/vs/${slug}/${r.slug}`} className="font-medium text-ink-200 hover:text-accent-400">
                      vs {r.display_name}
                    </Link>
                    <span className="text-[11px] text-ink-400">
                      {r.lane_games > 0 && `맞라인 ${r.lane_games}판 · `}
                      마지막 {relativeDate(r.last_met)}
                    </span>
                  </div>
                  <div className="mt-2 grid gap-3 sm:grid-cols-2">
                    <div>
                      <div className="mb-1 text-[11px] text-ink-400">상대전적</div>
                      <RecordBar record={{ wins: r.vs_wins, losses: r.vs_games - r.vs_wins }} label="상대" />
                    </div>
                    {r.ally_games > 0 && (
                      <div>
                        <div className="mb-1 text-[11px] text-ink-400">같은 팀</div>
                        <RecordBar record={{ wins: r.ally_wins, losses: r.ally_games - r.ally_wins }} label="같은 팀" />
                      </div>
                    )}
                  </div>
                </li>
              ))}
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
