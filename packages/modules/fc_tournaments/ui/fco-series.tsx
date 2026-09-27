import { fcoSeriesScore, groupFcoSeries, type FcoGame } from "@soop-lol/core/lib/contract";

/**
 * 다전제 요약. 세트를 한 판으로 접어 **시리즈 기준 승패**를 보여준다.
 * 승패는 저장된 값이 아니라 세트에서 파생한다 — 규칙은 core 의 series.ts 하나다.
 *
 * ⚠ fc.css 의 클래스를 새로 만들지 않는다(다른 작업과 충돌한다). 기본 유틸리티만 쓴다.
 */
export function FcoSeriesSummary({ games }: { games: FcoGame[] }) {
  const blocks = groupFcoSeries(games).filter((b) => b.kind === "series");
  if (blocks.length === 0) {
    return (
      <p className="fc-desc">
        이 대회에서 확인된 다전제가 없습니다. 같은 두 사람이 연속 세트로 붙은 판을 조사에서
        시리즈로 묶으면 여기에 나옵니다 — 상대가 바뀌는 경기는 시리즈가 아닙니다.
      </p>
    );
  }

  return (
    <div className="grid gap-3">
      {blocks.map((block) => {
        const { standing, sets } = block;
        const winner = standing.leader_key
          ? standing.sides.find((s) => s.key === standing.leader_key)
          : null;
        return (
          <div key={block.series_id} className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <b className="text-[15px]">{standing.sides.map((s) => s.name).join(" vs ")}</b>
              <span className="text-xs opacity-60">
                {standing.best_of ? `${standing.best_of}판 ${Math.floor(standing.best_of / 2) + 1}선승` : "형식 미확인"}
                {` · ${sets.length}세트`}
              </span>
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-3">
              <span className="text-2xl font-semibold tabular-nums">{fcoSeriesScore(standing)}</span>
              <span className="text-sm opacity-80">
                {/* ⚠ 모르는 것을 단정하지 않는다 — best_of 가 없으면 「현재까지」다. */}
                {winner
                  ? `${winner.name} ${standing.clinched === true ? "승리" : "우세"}`
                  : "동률"}
                {standing.complete === false && " · 진행 중"}
                {standing.best_of == null && " (현재까지 · 형식 미확인)"}
              </span>
            </div>

            <ol className="mt-3 grid gap-1 text-[13px]">
              {sets.map((set) => (
                <li key={set.id} className="flex flex-wrap items-center gap-2 opacity-80">
                  <span className="w-12 shrink-0 opacity-60">{set.series_game_no ?? "?"}세트</span>
                  <span>
                    {set.participants.map((p, i) => (
                      <span key={p.ouid}>
                        {i > 0 && <span className="opacity-50"> : </span>}
                        {p.streamer_name ?? p.nickname} <b>{p.score_display ?? p.goals ?? "?"}</b>
                      </span>
                    ))}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        );
      })}
    </div>
  );
}
