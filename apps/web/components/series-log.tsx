/**
 * 상대 카드를 펼쳤을 때 나오는 경기 목록.
 *
 * 한 줄이 **경기(다전제) 하나**다. `2:1` 처럼 세트 스코어를 같이 적는다.
 *
 * ★ 세트를 한 줄씩 늘어놓는 화면은 일부러 두지 않는다.
 *   출처(나무위키 결과표)가 주는 건 시리즈 스코어뿐이고 **세트별 승패는 없다**.
 *   그래서 적재할 때 승자 세트를 앞에 몰아 넣는다 — 2:1 이면 전부 승·승·패다.
 *   합계는 맞지만 순서는 우리가 만든 것이다. 이걸 '1세트 승, 2세트 승, 3세트 패'로
 *   보여주면 모르는 걸 아는 척하게 된다. 게다가 `2:1` 이 이미 같은 정보를 담고 있어
 *   길이만 세 배가 된다.
 *
 *   나중에 세트별 승패를 실제로 긁어오면(나무위키 본문에 WIN/LOSE 가 있는 회차가 있다)
 *   그때는 뜻이 생기므로 다시 넣을 수 있다.
 */

export interface LogGame {
  match_id: string;
  series_key: string;
  series_game_no: number | null;
  played_at: Date | string;
  event_name: string | null;
  source: string;
  me_win: boolean;
  is_lane_matchup: boolean;
}

function ymd(v: Date | string) {
  const d = new Date(v);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
}

/** 세트 줄들을 경기(시리즈) 단위로 접는다. */
function foldToMatches(games: LogGame[]) {
  const by = new Map<string, LogGame[]>();
  for (const g of games) {
    const cur = by.get(g.series_key) ?? [];
    cur.push(g);
    by.set(g.series_key, cur);
  }
  return [...by.entries()]
    .map(([key, rows]) => {
      const wins = rows.filter((r) => r.me_win).length;
      return {
        key,
        wins,
        losses: rows.length - wins,
        // 2세트제 조별리그(2014~2017)는 1:1 무승부가 있다. 진 게 아니므로 따로 표시한다.
        drawn: wins * 2 === rows.length,
        won: wins * 2 > rows.length,
        // 시리즈 안에서 가장 이른 시각이 그 경기의 날짜다
        played_at: rows.reduce((a, b) => (new Date(a.played_at) < new Date(b.played_at) ? a : b)).played_at,
        event_name: rows[0].event_name,
        source: rows[0].source,
        all_lane: rows.every((r) => r.is_lane_matchup),
        multiSet: rows.length > 1,
      };
    })
    .sort((a, b) => +new Date(b.played_at) - +new Date(a.played_at));
}

export function SeriesLog({ games, label }: { games: LogGame[]; label: string }) {
  if (games.length === 0) return null;
  const matches = foldToMatches(games);

  return (
    <details className="mt-3 border-t border-ink-800 pt-2">
      <summary className="cursor-pointer text-[11px] text-ink-400 hover:text-ink-200">
        {label} {matches.length}경기 — 언제였는지 보기
      </summary>
      <ul className="mt-2 grid gap-1">
        {matches.map((m) => (
          <li key={m.key} className="flex flex-wrap items-baseline gap-x-2 text-[11px]">
            <span
              className={`tabular w-7 shrink-0 font-medium ${
                m.drawn ? "text-ink-400" : m.won ? "text-win" : "text-lose"
              }`}
            >
              {m.drawn ? "무" : m.won ? "승" : "패"}
            </span>
            <span className="tabular w-20 shrink-0 text-ink-400">{ymd(m.played_at)}</span>
            <span className="tabular w-9 shrink-0 text-ink-300">
              {m.multiSet ? `${m.wins}:${m.losses}` : ""}
            </span>
            <span className="min-w-0 flex-1 truncate text-ink-400">
              {m.event_name ?? (m.source === "public_queue" ? "공개 큐" : "-")}
            </span>
            {m.all_lane && (
              <span className="shrink-0 rounded border border-ink-700 px-1 text-[10px] text-ink-400">
                맞라인
              </span>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
