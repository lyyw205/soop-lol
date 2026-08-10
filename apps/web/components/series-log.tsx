"use client";

import { useState } from "react";

/**
 * 라이벌 카드를 펼쳤을 때 나오는 경기 목록. **매치/세트 탭이 여기 붙어 있다.**
 *
 * 탭을 페이지 맨 위 필터에 두면, 목록을 보다가 단위를 바꾸려고 위로 올라갔다
 * 다시 내려와야 한다. 보는 자리에서 바로 바꾸는 게 맞다.
 *
 * 그래서 이 컴포넌트만 클라이언트다 — 페이지는 서버에서 그리고, 여기서만
 * 상태를 들고 있는다. 탭을 눌러도 주소가 바뀌지 않으니 펼친 상태도 유지된다.
 *
 * ★ 두 탭은 **다른 사실**을 보여준다.
 *   매치: 3판 2선승 한 판이 한 줄. `2:1` 처럼 세트 스코어가 붙는다.
 *   세트: 그 안의 판 하나가 한 줄. `2세트` 처럼 몇 번째인지 붙는다.
 *   같은 경기를 2:1 로 이겼으면 매치 탭엔 승 한 줄, 세트 탭엔 승·승·패 세 줄이다.
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

type Unit = "match" | "set";

function ymd(v: Date | string) {
  const d = new Date(v);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
}

/** 세트 줄들을 시리즈(매치) 단위로 접는다. */
function foldToMatches(games: LogGame[]) {
  const by = new Map<string, LogGame[]>();
  for (const g of games) {
    const cur = by.get(g.series_key) ?? [];
    cur.push(g);
    by.set(g.series_key, cur);
  }
  return [...by.entries()].map(([key, rows]) => {
    const wins = rows.filter((r) => r.me_win).length;
    return {
      key,
      wins,
      losses: rows.length - wins,
      won: wins * 2 > rows.length,
      // 시리즈 안에서 가장 이른 시각이 그 경기의 날짜다
      played_at: rows.reduce((a, b) => (new Date(a.played_at) < new Date(b.played_at) ? a : b)).played_at,
      event_name: rows[0].event_name,
      source: rows[0].source,
      all_lane: rows.every((r) => r.is_lane_matchup),
    };
  }).sort((a, b) => +new Date(b.played_at) - +new Date(a.played_at));
}

const TAB = "rounded-full px-2.5 py-0.5 text-[11px] transition-colors";

export function SeriesLog({ games, label }: { games: LogGame[]; label: string }) {
  const [unit, setUnit] = useState<Unit>("match");
  if (games.length === 0) return null;

  const matches = foldToMatches(games);
  const multiSet = games.length !== matches.length; // 전부 단판이면 탭이 의미 없다

  return (
    <details className="mt-3 border-t border-ink-800 pt-2">
      <summary className="cursor-pointer text-[11px] text-ink-400 hover:text-ink-200">
        {label} {matches.length}경기 — 언제였는지 보기
      </summary>

      {multiSet && (
        <div className="mt-2 flex items-center gap-1">
          {(["match", "set"] as const).map((u) => (
            <button
              key={u}
              type="button"
              onClick={() => setUnit(u)}
              className={`${TAB} ${
                unit === u
                  ? "bg-accent-400/15 text-accent-300"
                  : "text-ink-500 hover:text-ink-300"
              }`}
            >
              {u === "match" ? `매치 ${matches.length}` : `세트 ${games.length}`}
            </button>
          ))}
        </div>
      )}

      <ul className="mt-2 grid gap-1">
        {unit === "match"
          ? matches.map((m) => (
              <li key={m.key} className="flex flex-wrap items-baseline gap-x-2 text-[11px]">
                <span className={`tabular w-7 shrink-0 font-medium ${m.won ? "text-win" : "text-lose"}`}>
                  {m.won ? "승" : "패"}
                </span>
                <span className="tabular w-20 shrink-0 text-ink-400">{ymd(m.played_at)}</span>
                <span className="tabular w-9 shrink-0 text-ink-300">
                  {m.wins}:{m.losses}
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
            ))
          : games.map((g) => (
              <li key={g.match_id} className="flex flex-wrap items-baseline gap-x-2 text-[11px]">
                <span className={`tabular w-7 shrink-0 font-medium ${g.me_win ? "text-win" : "text-lose"}`}>
                  {g.me_win ? "승" : "패"}
                </span>
                <span className="tabular w-20 shrink-0 text-ink-400">{ymd(g.played_at)}</span>
                <span className="tabular w-9 shrink-0 text-ink-500">
                  {g.series_game_no ? `${g.series_game_no}세트` : "단판"}
                </span>
                <span className="min-w-0 flex-1 truncate text-ink-400">
                  {g.event_name ?? (g.source === "public_queue" ? "공개 큐" : "-")}
                </span>
                {g.is_lane_matchup && (
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
