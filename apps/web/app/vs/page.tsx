/**
 * 상대전적 첫 화면 — 두 사람을 고르는 곳.
 *
 * ★ 왜 페이지가 따로 필요한가
 *   실제 상대전적은 `/vs/<a>/<b>` 라 **두 slug 가 경로에 박혀 있다.** 상단 nav 는
 *   링크 하나뿐이라 거기로 곧장 갈 수가 없다. 여기서 고르게 하고 넘긴다.
 *
 * ★ 클라이언트 JS 를 쓰지 않는다
 *   폼은 GET 으로 이 페이지에 되돌아오고, 서버가 `/vs/a/b` 로 redirect 한다.
 *   선택기 두 개에 라우터를 붙일 이유가 없다 — 네이티브 select 는 타이핑 검색도 된다.
 *
 * ★ 빈 선택기만 두지 않는다
 *   nav 를 눌러 들어왔는데 고를 것만 있으면 볼 게 없다. **많이 붙은 쌍**을 같이
 *   보여준다. 이 사이트가 무엇을 세는 곳인지를 첫 화면이 그대로 말해 준다.
 */

import Link from "next/link";
import { redirect } from "next/navigation";

import { listStreamerOptions, listTopPairs } from "@soop-lol/core/lib/db/public";

import { EmptyLine, PageShell, SectionTitle, SiteHeader } from "../../components/public";

export const metadata = { title: "상대전적 — SOOP LOL" };

const dateOf = (d: Date) =>
  new Date(d).toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "long", day: "numeric" });

export default async function VersusIndexPage(
  { searchParams }: { searchParams: Promise<{ a?: string; b?: string }> },
) {
  const { a, b } = await searchParams;
  // 둘 다 골랐으면 진짜 상대전적으로 보낸다. 같은 사람이면 보낼 곳이 없다.
  if (a && b && a !== b) redirect(`/vs/${encodeURIComponent(a)}/${encodeURIComponent(b)}`);

  const [options, pairs] = await Promise.all([listStreamerOptions(), listTopPairs(20)]);
  const sameChosen = Boolean(a && b && a === b);

  return (
    <>
      <SiteHeader />
      <PageShell>
        <h1 className="text-2xl font-semibold text-ink-100">상대전적</h1>
        <p className="mt-2 text-sm text-ink-400">
          두 사람을 고르면 <strong className="text-ink-200">맞붙었을 때</strong>와{" "}
          <strong className="text-ink-200">같은 팀이었을 때</strong>를 나눠서 보여줍니다.
          같은 라인에서 1:1로 만난 판은 따로 셉니다.
        </p>

        <form method="get" action="/vs" className="mt-6 flex flex-wrap items-end gap-3">
          {(["a", "b"] as const).map((side) => (
            <label key={side} className="flex flex-col gap-1">
              <span className="text-[11px] text-ink-400">{side === "a" ? "누가" : "누구와"}</span>
              <select
                name={side}
                defaultValue={(side === "a" ? a : b) ?? ""}
                className="min-w-[190px] rounded-lg border border-ink-700 bg-ink-800 px-3 py-2 text-sm text-ink-200"
              >
                <option value="">— 스트리머 선택 —</option>
                {options.map((o) => (
                  <option key={o.slug} value={o.slug}>{o.display_name}</option>
                ))}
              </select>
            </label>
          ))}
          <button
            type="submit"
            className="rounded-lg border border-ink-700 bg-ink-800 px-4 py-2 text-sm text-ink-200 hover:border-ink-600"
          >
            보기
          </button>
        </form>
        {sameChosen && (
          <p className="mt-2 text-[11px] text-amber-300">같은 사람 둘을 고를 수는 없습니다.</p>
        )}

        <section className="mt-10">
          <SectionTitle hint="맞대결 세트 기준">많이 붙은 쌍</SectionTitle>
          {pairs.length === 0 ? (
            <EmptyLine>아직 맞대결 기록이 없습니다. 경기를 수집하면 채워집니다.</EmptyLine>
          ) : (
            <ul className="divide-y divide-ink-800 rounded-xl border border-ink-800 bg-ink-900/60">
              {pairs.map((p) => (
                <li key={`${p.a_slug}-${p.b_slug}`}>
                  <Link
                    href={`/vs/${p.a_slug}/${p.b_slug}`}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 hover:bg-ink-800/40"
                  >
                    <span className="min-w-0 flex-1 truncate text-sm text-ink-200">
                      {p.a_name} <span className="mx-1 text-ink-400">vs</span> {p.b_name}
                    </span>
                    <span className="text-[11px] text-ink-400">맞대결 {p.vs_sets}세트</span>
                    {p.lane_sets > 0 && (
                      <span className="rounded bg-amber-400/15 px-1.5 py-0.5 text-[11px] text-amber-300">
                        맞라인 {p.lane_sets}
                      </span>
                    )}
                    <span className="text-[11px] text-ink-400">{dateOf(p.last_met)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </PageShell>
    </>
  );
}
