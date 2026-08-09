import Link from "next/link";

import { listStreamerCards } from "@soop-lol/core/lib/db/public";

import { EmptyLine, PageShell, RankChip, SiteHeader } from "@/components/public";

export const metadata = { title: "스트리머" };
export const dynamic = "force-dynamic";

export default async function StreamersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const cards = await listStreamerCards({ q });

  return (
    <>
      <SiteHeader />
      <PageShell>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-ink-200">스트리머</h1>
            <p className="mt-1 text-sm text-ink-400">
              {cards.length}명 · 티어 높은 순. 계정이 여러 개면 가장 높은 계정으로 표시합니다.
            </p>
          </div>

          {/* 검색은 서버 렌더로 충분하다 — 40명 규모에 클라이언트 상태를 둘 이유가 없다. */}
          <form className="flex gap-2" action="/streamers">
            <input
              type="search"
              name="q"
              defaultValue={q ?? ""}
              placeholder="이름 · 별명 · 채널 아이디"
              aria-label="스트리머 검색"
              className="w-56 rounded-lg border border-ink-700 bg-ink-900 px-3 py-1.5 text-sm text-ink-200 placeholder:text-ink-400 focus:border-accent-600 focus:outline-none"
            />
            <button className="rounded-lg border border-ink-700 bg-ink-800 px-3 py-1.5 text-sm text-ink-200 hover:border-ink-600">
              검색
            </button>
          </form>
        </div>

        {cards.length === 0 ? (
          <div className="mt-8">
            <EmptyLine>
              {q ? `"${q}" 에 해당하는 스트리머가 없습니다.` : "아직 등록된 스트리머가 없습니다."}
            </EmptyLine>
          </div>
        ) : (
          <ul className="mt-6 grid gap-2 sm:grid-cols-2">
            {cards.map((c) => (
              <li key={c.streamer_id}>
                <Link
                  href={`/s/${c.slug}`}
                  className="flex items-center gap-3 rounded-xl border border-ink-800 bg-ink-900/60 px-4 py-3 transition hover:border-ink-600"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium text-ink-200">{c.display_name}</span>
                      {c.is_pro && (
                        <span className="shrink-0 rounded border border-ink-700 bg-ink-800 px-1.5 py-0.5 text-[10px] text-ink-400">
                          前프로
                        </span>
                      )}
                    </div>
                    <div className="tabular mt-0.5 text-[11px] text-ink-400">
                      {c.channel_id ? `${c.platform ?? "soop"} · ${c.channel_id}` : "채널 미등록"}
                      {c.encounters > 0 && ` · 조우 ${c.encounters}`}
                    </div>
                  </div>
                  <RankChip tier={c.tier} division={c.division} leaguePoints={c.league_points} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </PageShell>
    </>
  );
}
