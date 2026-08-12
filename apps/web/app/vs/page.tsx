/**
 * 상대전적 첫 화면 — 두 사람을 고르는 곳.
 *
 * ★ 왜 페이지가 따로 필요한가
 *   실제 상대전적은 `/vs/<a>/<b>` 라 **두 slug 가 경로에 박혀 있다.** 상단 nav 는
 *   링크 하나뿐이라 거기로 곧장 갈 수가 없다. 여기서 고르게 하고 넘긴다.
 *
 * ★ 고르는 건 클라이언트, 넘기는 건 서버
 *   419명을 드롭다운에 넣으면 이름을 아는 사람도 못 찾는다. 그래서 입력칸에 치면
 *   아래로 후보가 뜨는 선택기(VersusPicker)를 쓴다 — 필터는 브라우저가 한다.
 *   폼은 여전히 GET 으로 이 페이지에 돌아오고, 서버가 `/vs/a/b` 로 redirect 한다.
 *   라우터를 클라이언트에 붙이지 않으므로 주소를 직접 쳐도 같은 길로 흐른다.
 *
 * ★ 빈 선택기만 두지 않는다
 *   nav 를 눌러 들어왔는데 고를 것만 있으면 볼 게 없다. **많이 붙은 쌍**을 같이
 *   보여준다. 이 사이트가 무엇을 세는 곳인지를 첫 화면이 그대로 말해 준다.
 */

import Link from "next/link";
import { redirect } from "next/navigation";

import { listStreamerOptions, listTopPairs, resolveStreamerSlug } from "@soop-lol/core/lib/db/public";

import { EmptyLine, PageShell, SectionTitle, SiteHeader } from "../../components/public";
import { VersusPicker } from "../../components/versus-picker";

export const metadata = { title: "상대전적 — SOOP LOL" };

const dateOf = (d: Date) =>
  new Date(d).toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "long", day: "numeric" });

export default async function VersusIndexPage(
  { searchParams }: { searchParams: Promise<{ a?: string; b?: string }> },
) {
  const { a, b } = await searchParams;
  // ★ 선택기가 slug 를 실어 보내지만, 사람이 주소를 직접 치거나 JS 가 안 도는
  //   경우도 있다. 그때도 이름·별칭으로 한 번 더 해석해 준다 (정확히 일치할 때만).
  const [ra, rb] = await Promise.all([
    a ? resolveStreamerSlug(a) : null,
    b ? resolveStreamerSlug(b) : null,
  ]);
  // 둘 다 골랐으면 진짜 상대전적으로 보낸다. 같은 사람이면 보낼 곳이 없다.
  if (ra && rb && ra !== rb) redirect(`/vs/${encodeURIComponent(ra)}/${encodeURIComponent(rb)}`);

  const [options, pairs] = await Promise.all([listStreamerOptions(), listTopPairs(20)]);
  const sameChosen = Boolean(ra && rb && ra === rb);
  const notFound = [a && !ra ? a : null, b && !rb ? b : null].filter(Boolean) as string[];

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

        <VersusPicker options={options} a={ra ?? undefined} b={rb ?? undefined} />
        {sameChosen && (
          <p className="mt-2 text-[11px] text-amber-300">같은 사람 둘을 고를 수는 없습니다.</p>
        )}
        {notFound.length > 0 && (
          <p className="mt-2 text-[11px] text-amber-300">
            찾지 못했습니다: {notFound.join(", ")} — 목록에서 골라 주세요.
          </p>
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
