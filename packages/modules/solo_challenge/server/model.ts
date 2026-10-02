/**
 * 솔랭 도전 — 순수 계산. 판·랭크·같은 판의 다른 스트리머를 받아 화면이 그릴 모양을 만든다(DB 를 모른다).
 *
 * ★ 승률은 표본이 작으면 50%쪽으로 당긴다(CLAUDE.md 코딩 원칙 3 — affinity, α=4). 3승 0패를 100%로 쓰지 않는다.
 * ★ LP 는 경기 정보에 없다 — 진행도는 랭크 스냅샷(하루 한 장)에서만 나온다. 판마다 LP 변화는 그리지 않는다.
 */

import {
  affinity, championById, kstDateString, lpAbsolute,
  type PublicAccountRank, type PublicRankedGame,
} from "@soop-lol/core/lib/contract";

export interface ChallengeMember { streamer: string; name: string; role: string; color: string; puuid: string }
export interface ChallengeDef {
  slug: string; title: string; summary: string;
  goal: { tier: string; division?: string };
  since: string;
  members: ChallengeMember[];
}

export interface MemberRank {
  tier: string | null; division: string | null; lp: number | null;
  wins: number | null; losses: number | null;
  /** 정렬 가능한 LP(lp_absolute) */
  abs: number | null;
  /** 목표까지 남은 LP — 이미 넘었으면 0 */
  toGoal: number | null;
  date: string;
}
export interface MemberLine {
  member: ChallengeMember;
  rank: MemberRank | null;
  /** 날짜별 lp_absolute — 진행 그래프 */
  series: { date: string; abs: number }[];
}
export interface ChampRow { id: number; name: string; wins: number; losses: number; shrunk: number }
export interface MemberStat {
  games: number; wins: number;
  kp: number; damageShare: number; dpm: number; kda: number; soloKills: number;
  /** 같이 한 판에서 팀 딜 비중이 상대 멤버보다 높았던 판 */
  moreDamage: number;
  champs: ChampRow[];
}
export interface GameLine {
  kills: number; deaths: number; assists: number;
  champId: number; champName: string; position: string | null;
  kp: number; damageShare: number; soloKills: number; csLead: number;
}
export interface GameRow {
  matchId: string; at: string; day: string; minutes: number; win: boolean; surrender: boolean;
  /** 멤버 순서대로 — 그 판에 없으면 null */
  lines: (GameLine | null)[];
  /** 멤버가 둘 이상 같은 팀이었나 */
  together: boolean;
  tags: string[];
}
export interface DayRow { day: string; wins: number; losses: number; results: boolean[] }
export interface CoPlayer { slug: string; name: string; ally: number; enemy: number; winsWithOrAgainst: number }

export interface ChallengeView {
  def: ChallengeDef;
  goalAbs: number;
  /** 진행 막대의 왼쪽 끝 — 멤버 중 가장 낮은 위치가 든 티어의 시작(없으면 목표 − 800) */
  floorAbs: number;
  members: MemberLine[];
  stats: MemberStat[];
  games: GameRow[];
  days: DayRow[];
  record: { games: number; wins: number; together: number; togetherWins: number; bestWinStreak: number; worstLoseStreak: number };
  coPlayers: CoPlayer[];
  /** 랭크 스냅샷 기준 시즌 승패 합(Riot) — 수집한 판 수와 다르면 수집이 밀린 것 */
  riotGames: number | null;
}

const pct = (v: number | undefined) => (v == null ? 0 : v * 100);
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function buildChallenge(
  def: ChallengeDef,
  rows: PublicRankedGame[],
  ranks: PublicAccountRank[],
  co: { match_id: string; slug: string; display_name: string; team_id: number; outcome: string }[],
): ChallengeView {
  const goalAbs = lpAbsolute({ tier: def.goal.tier, division: def.goal.division ?? "IV", leaguePoints: 0 });
  if (goalAbs == null) throw new Error(`목표 티어를 모른다: ${def.goal.tier}`);
  const idx = new Map(def.members.map((m, i) => [m.puuid, i]));

  // ── 랭크
  const members: MemberLine[] = def.members.map((m) => {
    const mine = ranks.filter((r) => r.puuid === m.puuid && r.lp_absolute != null);
    const last = mine.at(-1);
    return {
      member: m,
      rank: last ? {
        tier: last.tier, division: last.division, lp: last.league_points, wins: last.wins, losses: last.losses,
        abs: last.lp_absolute, toGoal: Math.max(0, goalAbs - (last.lp_absolute ?? 0)), date: last.snapshot_date,
      } : null,
      series: mine.map((r) => ({ date: r.snapshot_date, abs: r.lp_absolute! })),
    };
  });
  const lows = members.map((m) => m.rank?.abs).filter((v): v is number => v != null);
  const floorAbs = lows.length ? Math.min(Math.floor(Math.min(...lows) / 400) * 400, goalAbs - 400) : goalAbs - 800;

  // ── 판(경기 단위로 묶기)
  const byMatch = new Map<string, PublicRankedGame[]>();
  for (const r of rows) (byMatch.get(r.match_id) ?? byMatch.set(r.match_id, []).get(r.match_id)!).push(r);
  const games: GameRow[] = [...byMatch.values()].map((ps) => {
    const first = ps[0];
    const lines: (GameLine | null)[] = def.members.map(() => null);
    for (const p of ps) {
      const i = idx.get(p.puuid);
      if (i == null) continue;
      lines[i] = {
        kills: p.kills, deaths: p.deaths, assists: p.assists, champId: p.champion_id,
        champName: championById(p.champion_id)?.name ?? p.champion_name, position: p.team_position,
        kp: Math.round(pct(p.challenges.killParticipation)), damageShare: Math.round(pct(p.challenges.teamDamagePercentage)),
        soloKills: p.challenges.soloKills ?? 0, csLead: Math.round(p.challenges.maxCsAdvantageOnLaneOpponent ?? 0),
      };
    }
    const teams = new Set(ps.map((p) => p.team_id));
    const win = first.outcome === "win";
    const g: GameRow = {
      matchId: first.match_id, at: first.game_creation.toISOString(), day: kstDateString(first.game_creation),
      minutes: Math.round(first.game_duration / 60), win, surrender: !!first.ended_in_surrender,
      lines, together: ps.length >= 2 && teams.size === 1, tags: [],
    };
    g.tags = gameTags(g, def.members);
    return g;
  });

  // ── 날짜·연승
  const dayMap = new Map<string, DayRow>();
  for (const g of games) {
    const d = dayMap.get(g.day) ?? dayMap.set(g.day, { day: g.day, wins: 0, losses: 0, results: [] }).get(g.day)!;
    if (g.win) d.wins++; else d.losses++;
    d.results.push(g.win);
  }
  let run = 0, best = 0, worst = 0;
  for (const g of games) {
    run = g.win ? Math.max(1, run + 1) : Math.min(-1, run - 1);
    best = Math.max(best, run); worst = Math.min(worst, run);
  }

  // ── 멤버별
  const stats: MemberStat[] = def.members.map((m, i) => {
    const mine = rows.filter((r) => r.puuid === m.puuid);
    const champs = new Map<number, ChampRow>();
    for (const r of mine) {
      const c = champs.get(r.champion_id) ?? champs.set(r.champion_id, { id: r.champion_id, name: championById(r.champion_id)?.name ?? r.champion_name, wins: 0, losses: 0, shrunk: 0 }).get(r.champion_id)!;
      if (r.outcome === "win") c.wins++; else c.losses++;
    }
    const sum = (k: "kills" | "deaths" | "assists") => mine.reduce((a, r) => a + r[k], 0);
    const together = games.filter((g) => g.together && g.lines[i]);
    return {
      games: mine.length, wins: mine.filter((r) => r.outcome === "win").length,
      kp: avg(mine.map((r) => pct(r.challenges.killParticipation))),
      damageShare: avg(mine.map((r) => pct(r.challenges.teamDamagePercentage))),
      dpm: avg(mine.map((r) => r.challenges.damagePerMinute ?? 0)),
      kda: (sum("kills") + sum("assists")) / Math.max(1, sum("deaths")),
      soloKills: mine.reduce((a, r) => a + (r.challenges.soloKills ?? 0), 0),
      moreDamage: together.filter((g) => g.lines.every((l, j) => j === i || !l || l.damageShare <= g.lines[i]!.damageShare)).length,
      champs: [...champs.values()]
        .map((c) => ({ ...c, shrunk: affinity({ wins: c.wins, losses: c.losses }) }))
        .sort((a, b) => b.wins + b.losses - (a.wins + a.losses) || b.shrunk - a.shrunk),
    };
  });

  // ── 같은 판의 다른 스트리머
  const myTeam = new Map(games.map((g) => [g.matchId, rows.find((r) => r.match_id === g.matchId)!.team_id]));
  const coMap = new Map<string, CoPlayer>();
  for (const c of co) {
    const team = myTeam.get(c.match_id);
    if (team == null) continue;
    const e = coMap.get(c.slug) ?? coMap.set(c.slug, { slug: c.slug, name: c.display_name, ally: 0, enemy: 0, winsWithOrAgainst: 0 }).get(c.slug)!;
    if (c.team_id === team) e.ally++; else e.enemy++;
    if (games.find((g) => g.matchId === c.match_id)?.win) e.winsWithOrAgainst++;
  }

  const riot = members.map((m) => (m.rank?.wins ?? 0) + (m.rank?.losses ?? 0));
  return {
    def, goalAbs, floorAbs, members, stats, games, days: [...dayMap.values()],
    record: {
      games: games.length, wins: games.filter((g) => g.win).length,
      together: games.filter((g) => g.together).length, togetherWins: games.filter((g) => g.together && g.win).length,
      bestWinStreak: best, worstLoseStreak: -worst,
    },
    coPlayers: [...coMap.values()].sort((a, b) => b.ally + b.enemy - (a.ally + a.enemy)),
    riotGames: riot.some((n) => n > 0) ? Math.max(...riot) : null,
  };
}

/** 판 한 줄 이야기 — 솔킬 3+, 팀 딜 30%+, 노데스, CS 40개 이상 앞섬, 서렌 패. */
export function gameTags(g: Pick<GameRow, "lines" | "win" | "surrender">, members: Pick<ChallengeMember, "name">[]): string[] {
  const out: string[] = [];
  g.lines.forEach((l, i) => {
    if (!l) return;
    const who = members[i].name;
    if (l.soloKills >= 3) out.push(`${who} 솔킬 ${l.soloKills}`);
    if (l.damageShare >= 30) out.push(`${who} 딜 ${l.damageShare}%`);
    if (l.deaths === 0) out.push(`${who} 노데스`);
    if (l.csLead >= 40) out.push(`${who} CS ${l.csLead}개 앞섬`);
  });
  if (g.surrender && !g.win) out.push("서렌");
  return out;
}

/** 진행 막대 위 위치(0~100). */
export function progressAt(abs: number, floorAbs: number, goalAbs: number): number {
  return Math.max(0, Math.min(100, ((abs - floorAbs) / Math.max(1, goalAbs - floorAbs)) * 100));
}
