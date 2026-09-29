/**
 * 대회 모듈의 해석 — 분류·시리즈 점수·선수 기록. core 에는 사실만 있고 이건 여기 것이다.
 * 순수 함수라 화면(클라이언트 컴포넌트)도 그대로 import 한다.
 */
import {
  kstDateString, setLabel, type PublicRosterEntry, type PublicTournamentMatchRow,
} from "@soop-lol/core/lib/contract";

export type TournamentCategory = "meljang" | "event" | "ck";
export function tournamentCategory(slug: string, kind: string): TournamentCategory {
  if (kind === "ck") return "ck";
  return slug.startsWith("meljang-") && !slug.includes("allstar")
    ? "meljang"
    : "event";
}
export interface TournamentSummary {
  id: string;
  slug: string;
  name: string;
  kind: string;
  category: TournamentCategory;
  start: string | null;
  end: string | null;
  dateFromMatches: boolean;
  organizer: string | null;
  sourceUrl: string | null;
  teamCount: number;
  seriesCount: number;
  setCount: number;
  winner: string | null;
  searchNames: string[];
}
export interface TournamentMember {
  id: string;
  slug: string;
  name: string;
  imageUrl: string | null;
  channelId: string | null;
  position: string | null;
  /** 주최측 발표 팀장. 모르면 false 와 구분하지 않는다 — 화면은 true 일 때만 표시한다. */
  isCaptain: boolean;
  /** 주최측 등급(수기). 등급제가 없던 대회면 null. */
  rating: { label: string; points: number | null } | null;
  /** 그 대회 개인상(수기). 예: FINAL MVP. */
  award: string | null;
}
export interface TournamentTeam {
  id: string;
  name: string;
  placement: string | null;
  rank: number | null;
  /** 상금 표기 그대로(수기). 모르면 null. */
  prize: string | null;
  /** 출처가 발표한 팀 투표 순위(수기). 그런 절차가 없으면 null. */
  voteRank: number | null;
  members: TournamentMember[];
}
export type TournamentMatchRow = PublicTournamentMatchRow;
export interface TournamentSet {
  id: string;
  label: string;
  number: number | null;
  date: string;
  playedAt: string;
  precision: "date" | "datetime";
  duration: number | null;
  winningSide: number | null;
  blueTeamId: string | null;
  redTeamId: string | null;
  blueName: string;
  redName: string;
  sourceUrl: string | null;
  players: PublicRosterEntry[];
}
export interface TournamentSeries {
  id: string;
  round: string;
  date: string;
  bestOf: number | null;
  orderKnown: boolean;
  aId: string | null;
  bId: string | null;
  a: string;
  b: string;
  scoreA: number | null;
  scoreB: number | null;
  sets: TournamentSet[];
}
export interface TournamentDetail {
  event: TournamentSummary;
  teams: TournamentTeam[];
  series: TournamentSeries[];
  /** event.sourceUrl 밖의 출처·공식 링크. */
  links: { label: string; url: string }[];
  /** 대회 안내 사실(수기) — 구역별로 화면이 묶는다. */
  facts: { section: string; label: string; value: string }[];
}

/** Team IDs, never blue/red slots, identify opponents across a series. */
export function tournamentSeries(
  rows: TournamentMatchRow[],
  roster: PublicRosterEntry[],
): TournamentSeries[] {
  const players = new Map<string, PublicRosterEntry[]>();
  for (const p of roster) {
    const list = players.get(p.match_id) ?? [];
    list.push(p);
    players.set(p.match_id, list);
  }
  const groups = new Map<string, TournamentMatchRow[]>();
  for (const row of rows) {
    const id = row.series_id ?? row.match_id;
    const group = groups.get(id) ?? [];
    group.push(row);
    groups.set(id, group);
  }
  return [...groups].map(([id, group]) => {
    group.sort(
      (a, b) =>
        a.game_creation.getTime() - b.game_creation.getTime() ||
        (a.series_game_no ?? 0) - (b.series_game_no ?? 0),
    );
    const first = group[0];
    const aId = first.blue_team_id,
      bId = first.red_team_id;
    const stableTeams =
      aId != null &&
      bId != null &&
      aId !== bId &&
      group.every(
        (g) =>
          (g.blue_team_id === aId && g.red_team_id === bId) ||
          (g.blue_team_id === bId && g.red_team_id === aId),
      );
    const knownWinners = group.every(
      (g) => g.winning_team === 100 || g.winning_team === 200,
    );
    const countable = knownWinners && (stableTeams || group.length === 1);
    const wins = (teamId: string | null, side: number) =>
      group.filter((g) =>
        stableTeams
          ? (g.winning_team === 100 ? g.blue_team_id : g.red_team_id) === teamId
          : g.winning_team === side,
      ).length;
    return {
      id,
      round: first.round_label ?? "경기",
      date: kstDateString(first.game_creation),
      bestOf: first.best_of,
      orderKnown: group.every((g) => g.set_order_known),
      aId,
      bId,
      a: first.blue_name ?? "팀 1",
      b: first.red_name ?? "팀 2",
      scoreA: countable ? wins(aId, 100) : null,
      scoreB: countable ? wins(bId, 200) : null,
      sets: group.map((g) => ({
        id: g.match_id,
        number: g.series_game_no,
        label: setLabel({
          standalone: g.series_id === null || g.series_id === g.match_id,
          best_of: g.best_of,
          set_order_known: g.set_order_known,
          series_game_no: g.series_game_no,
        }),
        date: kstDateString(g.game_creation),
        playedAt: g.game_creation.toISOString(),
        precision: g.game_creation_precision,
        duration: g.game_duration,
        winningSide: g.winning_team,
        blueTeamId: g.blue_team_id,
        redTeamId: g.red_team_id,
        blueName: g.blue_name ?? "팀 1",
        redName: g.red_name ?? "팀 2",
        sourceUrl: g.source_url,
        players: players.get(g.match_id) ?? [],
      })),
    };
  });
}

export function tournamentPlayerRecords(series: TournamentSeries[]) {
  const players = new Map<
    string,
    {
      id: string;
      slug: string | null;
      name: string;
      games: number;
      wins: number;
      losses: number;
      known: number;
      kills: number;
      deaths: number;
      assists: number;
    }
  >();
  const champions = new Map<
    number,
    { id: number; name: string; picks: number; wins: number; losses: number }
  >();
  for (const s of series)
    for (const set of s.sets)
      for (const p of set.players) {
        // Unknown names cannot be treated as a stable person across games.
        if (p.streamer_id) {
          const row = players.get(p.streamer_id) ?? {
            id: p.streamer_id,
            slug: p.slug,
            name: p.display_name ?? "미확인",
            games: 0,
            wins: 0,
            losses: 0,
            known: 0,
            kills: 0,
            deaths: 0,
            assists: 0,
          };
          row.games++;
          if (p.outcome === "win") row.wins++;
          if (p.outcome === "loss") row.losses++;
          if (p.kills != null && p.deaths != null && p.assists != null) {
            row.known++;
            row.kills += p.kills;
            row.deaths += p.deaths;
            row.assists += p.assists;
          }
          players.set(p.streamer_id, row);
        }
        if (p.champion_id) {
          const c = champions.get(p.champion_id) ?? {
            id: p.champion_id,
            name: p.champion_name ?? "",
            picks: 0,
            wins: 0,
            losses: 0,
          };
          c.picks++;
          if (p.outcome === "win") c.wins++;
          if (p.outcome === "loss") c.losses++;
          champions.set(c.id, c);
        }
      }
  return {
    players: [...players.values()].sort(
      (a, b) =>
        b.wins - a.wins ||
        b.games - a.games ||
        a.name.localeCompare(b.name, "ko"),
    ),
    champions: [...champions.values()].sort(
      (a, b) => b.picks - a.picks || a.id - b.id,
    ),
  };
}
