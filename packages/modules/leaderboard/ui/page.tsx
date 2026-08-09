import { formatRank } from "@soop-lol/core/lib/contract";

import { listStandings } from "../server/index.ts";

/**
 * 모듈 UI. core 웹의 `/m/[module]` 라우트가 등록부를 보고 이걸 렌더한다.
 * 모듈 디렉터리를 지우면 등록부에서 빠지고, 라우트도 404 가 된다 — core 는 무변경.
 */
export default async function LeaderboardPage() {
  const rows = await listStandings();

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="text-2xl font-bold">리더보드</h1>
      <p className="mt-1 text-sm text-neutral-500">
        솔로랭크 기준. 계정이 여러 개면 가장 높은 계정으로 대표합니다.
      </p>

      {rows.length === 0 ? (
        <p className="mt-8 text-sm text-neutral-500">
          아직 순위가 없습니다. 랭크 스냅샷을 쌓은 뒤 <code>recompute</code> 를 돌리면 채워집니다.
        </p>
      ) : (
        <ol className="mt-6 divide-y divide-neutral-200 dark:divide-neutral-800">
          {rows.map((r) => (
            <li key={r.streamer_id} className="flex items-center gap-4 py-3">
              <span className="w-8 text-right tabular-nums text-neutral-400">{r.rank_no}</span>
              <a href={`/s/${r.slug}`} className="flex-1 font-medium hover:underline">
                {r.display_name}
              </a>
              <span className="tabular-nums text-sm text-neutral-500">
                {formatRank({ tier: r.tier, division: r.division, leaguePoints: r.league_points })}
              </span>
            </li>
          ))}
        </ol>
      )}
    </main>
  );
}
