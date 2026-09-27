import type { FcoGame } from "@soop-lol/core/lib/db/fconline";
import { fcoNumber } from "@soop-lol/core/lib/games/fconline/view";
import { fcoMetadata } from "@soop-lol/core/lib/games/fconline/meta";
import { FcoSquadUsageTable, type SquadUsageRow, type SquadWindow } from "./fco-squad-usage-table";

/** 전체 보기에서만 쓰는 최소 출전 수. 최근 N경기 보기는 범위 자체가 거르므로 한 번이라도 뛰면 보여준다. */
const MIN_GAMES_ALL = 5;
const RECENT = [5, 10, 20, 30] as const;

interface Tally { position: number; games: number; goals: number; assists: number; rating: number }

/**
 * 수집 경기의 실제 출전 선수 기록. 현재 보유 스쿼드와는 다르다(넥슨 API 에 보유 선수 목록이 없다).
 *
 * "출전" = 그 경기에서 실제로 뛴 것. API 에 출전 여부 값은 없지만, 교체 명단에만 있고 안 뛴 선수는
 * 평점이 0 으로 온다. 그래서 평점 > 0 인 경기만 출전으로 세고, 평균 평점도 그 경기들로만 낸다.
 * (예전엔 명단에만 있던 경기까지 세서 평균이 0.0, 1.0 처럼 깎였다.)
 */
function tally(games: FcoGame[], streamerId: string): Map<number, Tally> {
  const players = new Map<number, Tally>();
  // games 는 최근 순이다. 포지션은 가장 최근에 뛴 경기의 것을 쓴다(처음 만난 값).
  for (const game of games) for (const participant of game.participants.filter((p) => p.streamer_id === streamerId)) {
    const roster = participant.match_info.player;
    if (!Array.isArray(roster)) continue;
    for (const raw of roster) {
      if (!raw || typeof raw !== "object") continue;
      const player = raw as Record<string, unknown>;
      const id = fcoNumber(player.spId);
      const status = player.status && typeof player.status === "object" ? player.status as Record<string, unknown> : {};
      const rating = typeof status.spRating === "number" ? status.spRating : 0;
      if (!id || rating <= 0) continue;
      const item = players.get(id) ?? { position: fcoNumber(player.spPosition), games: 0, goals: 0, assists: 0, rating: 0 };
      item.games++;
      item.goals += fcoNumber(status.goal);
      item.assists += fcoNumber(status.assist);
      item.rating += rating;
      players.set(id, item);
    }
  }
  return players;
}

export async function FcoSquadUsage({ games, streamerId }: { games: FcoGame[]; streamerId: string }) {
  if (!games.length) return <>
    <h2 className="mb-3 text-sm font-semibold text-ink-200">스쿼드 분석</h2>
    <p className="personal-history-empty">스쿼드 분석을 위한 경기 기록이 없습니다.</p>
  </>;
  const { names, positions, seasons } = await fcoMetadata();

  const rowsOf = (slice: FcoGame[], minGames: number): SquadUsageRow[] => [...tally(slice, streamerId).entries()]
    .filter(([, stat]) => stat.games >= minGames)
    // 정렬은 브라우저에서 한다(헤더 클릭). 여기서는 원래 순서(출전 많은 순 → 골 많은 순)로 줄만 만든다.
    .sort((a, b) => b[1].games - a[1].games || b[1].goals - a[1].goals)
    .map(([id, stat]) => {
      // spid 앞 3자리가 시즌이다. 같은 선수도 시즌마다 다른 카드라 이름 앞에 시즌 아이콘을 둔다.
      const season = seasons.get(Math.floor(id / 1_000_000));
      return {
        id,
        name: names.get(id) ?? `선수 ${id}`,
        seasonIcon: season?.icon ?? null,
        seasonName: season?.name ?? null,
        position: positions.get(stat.position) ?? "—",
        positionId: stat.position,
        games: stat.games,
        usage: stat.games / slice.length,
        goals: stat.goals,
        assists: stat.assists,
        rating: stat.games ? stat.rating / stat.games : null,
      };
    });

  // games 는 최근 순(listFcoGamesForPerson ORDER BY game_creation DESC)이라 앞에서 자르면 최근 N경기다.
  // 기간·모드 필터를 걸면 그 안에서의 최근 N경기다. 경기가 N보다 적으면 그 범위는 만들지 않는다.
  const windows: SquadWindow[] = [
    { key: "all", label: "전체", games: games.length, minGames: MIN_GAMES_ALL, rows: rowsOf(games, MIN_GAMES_ALL) },
    ...RECENT.filter((n) => games.length > n).map((n) => ({
      key: `recent${n}`, label: `최근 ${n}`, games: n, minGames: 1, rows: rowsOf(games.slice(0, n), 1),
    })),
  ];
  return <FcoSquadUsageTable windows={windows} />;
}
