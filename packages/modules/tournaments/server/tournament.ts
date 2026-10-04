/**
 * 대회 모듈의 해석 — 분류·시리즈 점수·선수 기록. core 에는 사실만 있고 이건 여기 것이다.
 * 순수 함수라 화면(클라이언트 컴포넌트)도 그대로 import 한다.
 */
import type { BoardModel } from "../../../ui/bracket/bracket-model.ts";
import {
  kstDateString, setLabel, type PublicRosterEntry, type PublicTournamentMatchRow,
} from "@soop-lol/core/lib/contract/client";

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
  /** 스트리머로 연결되지 않은 자리의 출처 표기 이름(표시 전용, 0068). 상대전적·기록에 쓰지 않는다. */
  listed: { position: string; name: string; sourceUrl: string }[];
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
  /** 공통 대진(core 계산 → packages/ui/bracket 모델). 대진을 등록하지 않은 대회는 null — 라운드별 목록으로 그린다. */
  bracket?: BoardModel | null;
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

/* ── 기록실: 맞라인 대결 · 명기록 ─────────────────────────────────────── */

export interface DuelSide {
  championId: number;
  championName: string | null;
  kills: number | null;
  deaths: number | null;
  assists: number | null;
}
export interface LaneDuelSet {
  seriesId: string;
  setIndex: number;
  round: string;
  label: string;
  date: string;
  a: DuelSide;
  b: DuelSide;
  /** 그 세트에서 이긴 쪽(팀 승패). 모르면 null */
  winner: "a" | "b" | null;
}
export interface DuelPerson { id: string; slug: string | null; name: string }
export interface LaneDuel {
  position: string;
  a: DuelPerson;
  b: DuelPerson;
  aWins: number;
  bWins: number;
  sets: LaneDuelSet[];
}

/**
 * 같은 포지션으로 맞붙은 두 스트리머의 **세트 팀 승패**. 라인전 승패가 아니다(골드·CS 가 없다).
 * ★ 양쪽 모두 등록된 스트리머인 세트만 센다 — 미등록 이름은 같은 사람인지 알 수 없다(선수 기록과 같은 규칙).
 * ★ 포지션은 출전 명단의 team_position. 한쪽이라도 모르면 맞라인이 아니다(코딩 원칙 10).
 * a 는 이긴 세트가 많은 쪽(같으면 이름순)이다.
 */
export function laneDuels(series: TournamentSeries[]): LaneDuel[] {
  const duels = new Map<string, LaneDuel>();
  for (const s of series) s.sets.forEach((set, setIndex) => {
    const blue = set.players.filter((p) => p.team_id === 100);
    const red = set.players.filter((p) => p.team_id === 200);
    for (const x of blue) {
      if (!x.streamer_id || !x.team_position) continue;
      const y = red.find((p) => p.team_position === x.team_position);
      if (!y?.streamer_id || y.streamer_id === x.streamer_id) continue;
      // 쌍의 순서를 고정해 같은 두 사람이 한 줄로 모이게 한다
      const [p, q] = x.streamer_id < y.streamer_id ? [x, y] : [y, x];
      const key = `${x.team_position}:${p.streamer_id}:${q.streamer_id}`;
      const duel = duels.get(key) ?? {
        position: x.team_position,
        a: { id: p.streamer_id!, slug: p.slug, name: p.display_name ?? "미확인" },
        b: { id: q.streamer_id!, slug: q.slug, name: q.display_name ?? "미확인" },
        aWins: 0, bWins: 0, sets: [],
      };
      const side = (r: PublicRosterEntry): DuelSide => ({
        championId: r.champion_id, championName: r.champion_name, kills: r.kills, deaths: r.deaths, assists: r.assists,
      });
      const winner = p.outcome === "win" ? "a" : q.outcome === "win" ? "b" : null;
      if (winner === "a") duel.aWins++;
      if (winner === "b") duel.bWins++;
      duel.sets.push({ seriesId: s.id, setIndex, round: s.round, label: set.label, date: set.date, a: side(p), b: side(q), winner });
      duels.set(key, duel);
    }
  });
  return [...duels.values()].map((d) => {
    // 이긴 세트가 많은 쪽을 왼쪽(a)에
    if (d.bWins > d.aWins || (d.bWins === d.aWins && d.b.name.localeCompare(d.a.name, "ko") < 0)) {
      return {
        ...d, a: d.b, b: d.a, aWins: d.bWins, bWins: d.aWins,
        sets: d.sets.map((x) => ({ ...x, a: x.b, b: x.a, winner: x.winner === "a" ? "b" as const : x.winner === "b" ? "a" as const : null })),
      };
    }
    return d;
  }).sort((x, y) => y.sets.length - x.sets.length || x.a.name.localeCompare(y.a.name, "ko"));
}

export interface SetRef { seriesId: string; setIndex: number; round: string; label: string; date: string }
export interface TournamentHighlights {
  /** 경기 시간이 확인된 세트 중 가장 긴 세트. known = 시간이 확인된 세트 수 */
  longest: (SetRef & { seconds: number; blue: string; red: string; known: number; total: number }) | null;
  /** 한 세트 최다 킬(킬이 확인된 기록 중). ties = 같은 킬 수의 다른 기록 수 */
  mostKills: (SetRef & { name: string; slug: string | null; champion: string | null; championId: number; kills: number; deaths: number | null; assists: number | null; ties: number }) | null;
  /** 이 대회에서 나온 챔피언 종류 수와 전체 픽 수, 한 번만 나온 챔피언 수 */
  champions: { kinds: number; picks: number; once: number } | null;
}

export function tournamentHighlights(series: TournamentSeries[]): TournamentHighlights {
  let longest: TournamentHighlights["longest"] = null;
  let known = 0, total = 0;
  let best: TournamentHighlights["mostKills"] = null;
  let ties = 0;
  const picks = new Map<number, number>();
  for (const s of series) s.sets.forEach((set, setIndex) => {
    total++;
    const ref = { seriesId: s.id, setIndex, round: s.round, label: set.label, date: set.date };
    if (set.duration != null) {
      known++;
      if (!longest || set.duration > longest.seconds) longest = { ...ref, seconds: set.duration, blue: set.blueName, red: set.redName, known: 0, total: 0 };
    }
    for (const p of set.players) {
      if (p.champion_id) picks.set(p.champion_id, (picks.get(p.champion_id) ?? 0) + 1);
      if (p.kills == null) continue;
      if (!best || p.kills > best.kills) {
        best = { ...ref, name: p.display_name ?? p.observed_name ?? "미확인", slug: p.slug, champion: p.champion_name,
          championId: p.champion_id, kills: p.kills, deaths: p.deaths, assists: p.assists, ties: 0 };
        ties = 0;
      } else if (p.kills === best.kills) ties++;
    }
  });
  if (longest) longest = { ...(longest as NonNullable<TournamentHighlights["longest"]>), known, total };
  if (best) best = { ...(best as NonNullable<TournamentHighlights["mostKills"]>), ties };
  const counts = [...picks.values()];
  return {
    longest,
    mostKills: best,
    champions: counts.length ? { kinds: counts.length, picks: counts.reduce((a, b) => a + b, 0), once: counts.filter((n) => n === 1).length } : null,
  };
}
