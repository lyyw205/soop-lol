import { formatRank } from "@soop-lol/core/lib/contract";

import { listStandings } from "../server/index.ts";

/**
 * 모듈 UI. core 웹의 `/m/[module]` 라우트가 등록부를 보고 이걸 렌더한다.
 * 모듈 디렉터리를 지우면 등록부에서 빠지고, 라우트도 404 가 된다 — core 는 무변경.
 *
 * ★ 머리말·본문 폭은 그리지 않는다
 *   그건 `/m/[module]` 라우트가 씌운다. 모듈이 제 틀을 그리면 이 화면만 nav 가 없어
 *   길을 잃고(실제로 그랬다), 사이트 여백을 고칠 때마다 모듈을 따라 고쳐야 한다.
 *
 * ★ 색은 사이트 토큰(`ink-*`)을 쓴다
 *   apps/web 컴포넌트를 import 하는 건 경계 위반이지만, **디자인 토큰은 CSS 쪽
 *   약속**이라 코드 의존이 아니다. 예전엔 여기만 `neutral-*` 을 써서 톤이 달랐고,
 *   더 나쁘게는 그 클래스들이 CSS 에 아예 생성되지도 않았다 — Tailwind 가
 *   apps/web 안만 훑고 있었다(globals.css 의 `@source` 로 고쳤다).
 */
export default async function LeaderboardPage() {
  const rows = await listStandings();

  return (
    <>
      <h1 className="text-2xl font-semibold text-ink-100">리더보드</h1>
      <p className="mt-2 text-sm text-ink-400">
        솔로랭크 기준. 계정이 여러 개면 가장 높은 계정으로 대표합니다.
      </p>

      {rows.length === 0 ? (
        <p className="mt-8 rounded-xl border border-dashed border-ink-800 px-4 py-6 text-center text-sm text-ink-400">
          아직 순위가 없습니다. 랭크 스냅샷을 쌓은 뒤 <code className="text-ink-200">recompute</code> 를 돌리면 채워집니다.
        </p>
      ) : (
        <ol className="mt-6 divide-y divide-ink-800 rounded-xl border border-ink-800 bg-ink-900/60">
          {rows.map((r) => (
            <li key={r.streamer_id}>
              <a
                href={`/s/${r.slug}`}
                className="flex items-center gap-4 px-4 py-3 transition hover:bg-ink-800/40"
              >
                {/* 순위는 자리를 고정한다 — 자릿수가 늘 때 이름이 밀리면 훑기 어렵다 */}
                <span className="w-7 shrink-0 text-right text-sm tabular-nums text-ink-400">{r.rank_no}</span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink-200">
                  {r.display_name}
                </span>
                <span className="shrink-0 rounded border border-ink-700 bg-ink-800 px-2 py-0.5 text-[11px] tabular-nums text-ink-200">
                  {formatRank({ tier: r.tier, division: r.division, leaguePoints: r.league_points })}
                </span>
              </a>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}
