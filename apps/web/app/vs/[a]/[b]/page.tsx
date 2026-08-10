import Link from "next/link";
import { notFound } from "next/navigation";

import { getStreamerBySlug, getVersus, type VersusGame } from "@soop-lol/core/lib/db/public";
import { POSITION_LABEL, QUEUE_LABEL, type Position } from "@soop-lol/core/lib/riot/types";

import {
  DualRecord, EmptyLine, Kda, PageShell, SectionTitle, SiteHeader, WinPill, relativeDate,
} from "@/components/public";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ a: string; b: string }> }) {
  const { a, b } = await params;
  const [x, y] = await Promise.all([getStreamerBySlug(a), getStreamerBySlug(b)]);
  return { title: x && y ? `${x.display_name} vs ${y.display_name}` : "상대전적" };
}

/** 저장된 a/b 를 요청한 x/y 관점으로 뒤집는다. 화면은 "내가 x" 로만 생각한다. */
function asSeen(g: VersusGame, flip: boolean) {
  return flip
    ? {
        xWin: g.b_win, yWin: g.a_win,
        xPos: g.b_position, yPos: g.a_position,
        xChampion: g.b_champion_id, yChampion: g.a_champion_id,
        xK: g.b_kills, xD: g.b_deaths, xA: g.b_assists, xCs: g.b_cs,
        yK: g.a_kills, yD: g.a_deaths, yA: g.a_assists, yCs: g.a_cs,
      }
    : {
        xWin: g.a_win, yWin: g.b_win,
        xPos: g.a_position, yPos: g.b_position,
        xChampion: g.a_champion_id, yChampion: g.b_champion_id,
        xK: g.a_kills, xD: g.a_deaths, xA: g.a_assists, xCs: g.a_cs,
        yK: g.b_kills, yD: g.b_deaths, yA: g.b_assists, yCs: g.b_cs,
      };
}

export default async function VersusPage({ params }: { params: Promise<{ a: string; b: string }> }) {
  const { a: slugX, b: slugY } = await params;
  const [x, y] = await Promise.all([getStreamerBySlug(slugX), getStreamerBySlug(slugY)]);
  if (!x || !y) notFound();
  if (x.streamer_id === y.streamer_id) notFound();

  const { flip, games } = await getVersus(x.streamer_id, y.streamer_id);
  const seen = games.map((g) => ({ g, v: asSeen(g, flip) }));

  const opponents = seen.filter(({ g }) => g.relation === "opponent");
  const allies = seen.filter(({ g }) => g.relation === "ally");
  const lanes = seen.filter(({ g }) => g.is_lane_matchup);

  /** 세트(판) 단위 전적 */
  const rec = (rows: typeof seen) => ({
    wins: rows.filter(({ v }) => v.xWin).length,
    losses: rows.filter(({ v }) => !v.xWin).length,
  });

  /**
   * 경기(매치) 단위 전적. 같은 시리즈의 세트를 묶고 **세트 과반**을 이긴 쪽이 그 경기의 승자다.
   * 다전제 2:1 은 세트로 2승 1패지만 경기로는 1승 0패다. 단판은 시리즈가 곧 자기 자신이라
   * 그대로 1경기로 잡힌다.
   */
  const recByMatch = (rows: typeof seen) => {
    const bySeries = new Map<string, { won: number; lost: number }>();
    for (const { g, v } of rows) {
      const cur = bySeries.get(g.series_key) ?? { won: 0, lost: 0 };
      if (v.xWin) cur.won++;
      else cur.lost++;
      bySeries.set(g.series_key, cur);
    }
    let wins = 0;
    let losses = 0;
    for (const s of bySeries.values()) (s.won > s.lost ? wins++ : losses++);
    return { wins, losses };
  };

  const seriesCount = new Set(seen.map(({ g }) => g.series_key)).size;
  const tournamentSets = seen.filter(({ g }) => g.source === "manual").length;

  return (
    <>
      <SiteHeader />
      <PageShell>
        <p className="text-xs text-ink-400">상대전적</p>
        <h1 className="mt-1 text-2xl font-semibold text-ink-200">
          <Link href={`/s/${x.slug}`} className="hover:text-accent-400">{x.display_name}</Link>
          <span className="mx-2 text-ink-400">vs</span>
          <Link href={`/s/${y.slug}`} className="hover:text-accent-400">{y.display_name}</Link>
        </h1>
        <p className="mt-1 text-sm text-ink-400">
          같은 경기에 있었던 {seriesCount}경기 · {games.length}세트
          {tournamentSets > 0 && ` · 이 중 대회 ${tournamentSets}세트`}
        </p>

        {games.length === 0 ? (
          <div className="mt-8">
            <EmptyLine>
              아직 두 사람이 같은 경기에서 만난 기록이 없습니다.
              <br />
              <span className="text-[11px]">
                과거 경기를 더 수집하면 나타날 수 있습니다.
              </span>
            </EmptyLine>
          </div>
        ) : (
          <>
            {/* ── 요약 ── */}
            <section className="mt-8 grid gap-3 sm:grid-cols-3">
              <div className="rounded-xl border border-ink-800 bg-ink-900/60 p-4">
                <div className="mb-2 text-xs text-ink-400">
                  상대편으로 만났을 때 · {x.display_name} 기준
                </div>
                <DualRecord match={recByMatch(opponents)} set={rec(opponents)} label="상대전적" />
              </div>
              <div className="rounded-xl border border-ink-800 bg-ink-900/60 p-4">
                <div className="mb-2 text-xs text-ink-400">같은 팀이었을 때</div>
                <DualRecord match={recByMatch(allies)} set={rec(allies)} label="같은 팀" />
              </div>
              <div className="rounded-xl border border-ink-800 bg-ink-900/60 p-4">
                <div className="mb-2 text-xs text-ink-400">
                  맞라인 <span className="text-ink-400">(같은 포지션 · 반대 팀)</span>
                </div>
                <DualRecord match={recByMatch(lanes)} set={rec(lanes)} label="맞라인" />
              </div>
            </section>

            <p className="mt-3 text-[11px] leading-relaxed text-ink-400">
              상대편 전적과 같은 팀 전적을 섞지 않습니다 — 같은 팀 승리를 상대전적에 넣으면
              &ldquo;이겼다&rdquo;의 뜻이 달라집니다. 포지션 추론이 어긋난 경기는 맞라인에서 제외합니다.
            </p>

            {/* ── 경기 목록 ── */}
            <section className="mt-8">
              <SectionTitle hint={`${games.length}판`}>만난 경기</SectionTitle>
              <ul className="divide-y divide-ink-800 rounded-xl border border-ink-800 bg-ink-900/60">
                {seen.map(({ g, v }) => (
                  <li key={g.match_id} className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`rounded px-1.5 py-0.5 text-[11px] ${
                        g.relation === "opponent"
                          ? "bg-accent-600/15 text-accent-400"
                          : "border border-ink-700 bg-ink-800 text-ink-400"
                      }`}>
                        {g.relation === "opponent" ? "상대편" : "같은 팀"}
                      </span>
                      {g.is_lane_matchup && (
                        <span className="rounded bg-amber-400/15 px-1.5 py-0.5 text-[11px] text-amber-300">
                          맞라인 {POSITION_LABEL[v.xPos as Position] ?? v.xPos}
                        </span>
                      )}
                      <span className="rounded border border-ink-700 bg-ink-800 px-1.5 py-0.5 text-[11px] text-ink-400">
                        {QUEUE_LABEL[g.queue_id] ?? `큐 ${g.queue_id}`}
                      </span>
                      <span className="ml-auto text-[11px] text-ink-400">{relativeDate(g.game_creation)}</span>
                    </div>

                    <div className="mt-2 grid gap-2 sm:grid-cols-2">
                      <div className="flex items-center gap-2">
                        <WinPill win={v.xWin} />
                        <span className="min-w-0 flex-1 truncate text-sm text-ink-200">{x.display_name}</span>
                        <Kda k={v.xK ?? 0} d={v.xD ?? 0} a={v.xA ?? 0} />
                      </div>
                      <div className="flex items-center gap-2">
                        <WinPill win={v.yWin} />
                        <span className="min-w-0 flex-1 truncate text-sm text-ink-200">{y.display_name}</span>
                        <Kda k={v.yK ?? 0} d={v.yD ?? 0} a={v.yA ?? 0} />
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          </>
        )}
      </PageShell>
    </>
  );
}
