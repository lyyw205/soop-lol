import { topPairs } from "../server/index.ts";

const dateOf = (d: Date) =>
  new Date(d).toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "long", day: "numeric" });

/** 많이 붙은 쌍. 정렬 기준은 **맞대결 세트**다 — 서버 주석 참조. */
export async function TopPairs() {
  const pairs = await topPairs(20);
  return (
    <section className="mt-10">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[15px] font-semibold text-ink-200">많이 붙은 쌍</h2>
        <span className="text-[11px] text-ink-400">맞대결 세트 기준</span>
      </div>
      {pairs.length === 0 ? (
        <p className="mt-3 rounded-xl border border-dashed border-ink-700 px-4 py-6 text-center text-[13px] text-ink-400">
          아직 맞대결 기록이 없습니다. 경기를 수집하면 채워집니다.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-ink-800 rounded-xl border border-ink-800 bg-ink-900/60">
          {pairs.map((p) => (
            <li key={`${p.a_slug}-${p.b_slug}`}>
              <a
                href={`/m/versus?a=${encodeURIComponent(p.a_slug)}&b=${encodeURIComponent(p.b_slug)}`}
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
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
