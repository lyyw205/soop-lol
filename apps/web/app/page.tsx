import Link from "next/link";

import { countPublic, listRecentEncounters } from "@soop-lol/core/lib/db/public";

import { EmptyLine, PageShell, QueueTag, SectionTitle, SiteHeader, WinPill, relativeDate } from "@/components/public";

export const dynamic = "force-dynamic";

export default async function Home() {
  const [counts, recent] = await Promise.all([countPublic(), listRecentEncounters(12)]);

  return (
    <>
      <SiteHeader />
      <PageShell>
        <h1 className="text-3xl font-semibold text-ink-200">
          스트리머끼리 <span className="text-accent-500">누가 누구를 이겼나</span>
        </h1>
        <p className="mt-3 max-w-2xl leading-relaxed text-ink-400">
          개인 전적은 이미 여러 곳이 합니다. 여기는 SOOP 스트리머들이
          <b className="text-ink-200"> 같은 경기에서 만난 순간</b>만 모읍니다 —
          상대전적, 맞라인, 상성.
        </p>

        <div className="tabular mt-6 flex flex-wrap gap-2 text-sm">
          <span className="rounded-lg border border-ink-800 bg-ink-900/60 px-3 py-1.5 text-ink-400">
            스트리머 <b className="text-ink-200">{counts.streamers}</b>
          </span>
          <span className="rounded-lg border border-ink-800 bg-ink-900/60 px-3 py-1.5 text-ink-400">
            수집 경기 <b className="text-ink-200">{counts.matches.toLocaleString()}</b>
          </span>
          <span className="rounded-lg border border-ink-800 bg-ink-900/60 px-3 py-1.5 text-ink-400">
            조우 <b className="text-ink-200">{counts.encounters.toLocaleString()}</b>
          </span>
        </div>

        <div className="mt-6 flex gap-3 text-sm">
          <Link href="/streamers" className="rounded-lg border border-ink-700 bg-ink-800 px-4 py-2 text-ink-200 hover:border-ink-600">
            스트리머 보기
          </Link>
          <Link href="/m/leaderboard" className="rounded-lg border border-ink-700 bg-ink-800 px-4 py-2 text-ink-200 hover:border-ink-600">
            리더보드
          </Link>
        </div>

        <section className="mt-12">
          <SectionTitle hint="공개 큐만">최근 조우</SectionTitle>
          {recent.length === 0 ? (
            <EmptyLine>
              아직 조우 기록이 없습니다. 과거 경기를 수집하면 채워집니다.
            </EmptyLine>
          ) : (
            <ul className="divide-y divide-ink-800 rounded-xl border border-ink-800 bg-ink-900/60">
              {recent.map((e) => (
                <li key={`${e.match_id}-${e.a_slug}-${e.b_slug}`} className="flex flex-wrap items-center gap-2 px-4 py-3">
                  <Link href={`/vs/${e.a_slug}/${e.b_slug}`} className="min-w-0 flex-1 text-sm text-ink-200 hover:text-accent-400">
                    <span className={e.a_win ? "text-ink-200" : "text-ink-400"}>{e.a_name}</span>
                    <span className="mx-1.5 text-ink-400">{e.relation === "opponent" ? "vs" : "&"}</span>
                    <span className={e.b_win ? "text-ink-200" : "text-ink-400"}>{e.b_name}</span>
                  </Link>
                  {e.relation === "opponent" ? (
                    <WinPill win={e.a_win} />
                  ) : (
                    <span className="rounded border border-ink-700 bg-ink-800 px-1.5 py-0.5 text-[11px] text-ink-400">
                      같은 팀
                    </span>
                  )}
                  {e.is_lane_matchup && (
                    <span className="rounded bg-amber-400/15 px-1.5 py-0.5 text-[11px] text-amber-300">맞라인</span>
                  )}
                  <QueueTag queueId={e.queue_id} />
                  <span className="text-[11px] text-ink-400">{relativeDate(e.game_creation)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </PageShell>
    </>
  );
}
