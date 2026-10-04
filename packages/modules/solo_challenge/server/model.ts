/**
 * 솔랭 도전 — 순수 계산. 판·랭크·라인업을 받아 화면이 그릴 모양을 만든다(DB 를 모른다).
 *
 * ★ 승률은 표본이 작으면 50%쪽으로 당긴다(CLAUDE.md 코딩 원칙 3 — affinity, α=4). 3승 0패를 100%로 쓰지 않는다.
 * ★ LP 는 경기 정보에 없고 Riot 은 과거 랭크도 주지 않는다 — 현재 위치는 랭크 스냅샷, 출발점은 방송에서 확인해 설정에 적은 값이다.
 * ★ 다시하기(5분 미만)는 판으로 세지 않는다.
 */

import {
  affinity, championById, kstDateString, lpAbsolute,
  type PublicAccountRank, type PublicLineupSlot, type PublicRankedGame,
} from "@soop-lol/core/lib/contract";

export const REMAKE_SEC = 300;

export interface ChallengeStart { tier: string; division?: string; lp: number; date: string; note?: string; source?: string }
export interface ChallengeMember { streamer: string; name: string; role: string; color: string; puuid: string; start?: ChallengeStart }
export interface ChallengeDef {
  slug: string; title: string; summary: string;
  /** Optional poster; keep the main subject in the right 55% of the image. */
  heroImage?: string;
  goal: { tier: string; division?: string };
  since: string;
  members: ChallengeMember[];
}

export interface MemberLine {
  member: ChallengeMember;
  rank: { tier: string | null; division: string | null; lp: number | null; wins: number | null; losses: number | null; abs: number | null; date: string } | null;
  startAbs: number | null;
  /** 출발점에서 지금까지 오른 LP(내려갔으면 음수) */
  gained: number | null;
  /** 목표까지 남은 LP — 이미 넘었으면 0 */
  toGoal: number | null;
}

export interface Line {
  kills: number; deaths: number; assists: number; cs: number; damage: number;
  champId: number; champName: string; position: string | null;
  kp: number; damageShare: number; soloKills: number; csLead: number;
  items: number[]; spells: (number | null)[]; keystone: number | null; subStyle: number | null;
}
export interface LineupSlot { teamId: number; champId: number; name: string | null; slug: string | null; member: number | null; kills: number; deaths: number; assists: number }
export interface GameRow {
  matchId: string; at: string; day: string; minutes: number; seconds: number; win: boolean; surrender: boolean;
  /** 멤버 순서대로 — 그 판에 없으면 null */
  lines: (Line | null)[];
  together: boolean;
  teamId: number;
  lineup: LineupSlot[];
  tags: string[];
}
export interface FlowPoint { i: number; net: number; win: boolean; day: string }
/** 연속 결과 한 덩어리 — 3연승·2연패 */
export interface Run { win: boolean; n: number; firstMatchId: string }
export interface DayLog { day: string; games: number; wins: number; losses: number; runs: Run[] }
export interface ChampRow { id: number; name: string; games: number; wins: number; losses: number; shrunk: number; kda: number; csPerMin: number; dmgPerMin: number; kills: number; deaths: number; assists: number }
export interface MemberStat { games: number; wins: number; champs: ChampRow[] }
export interface RecordRow { key: string; label: string; value: string; who: string | null; champ: string | null; matchId: string | null; at: string | null; note?: string }
export interface CoPlayer { slug: string; name: string; ally: number; enemy: number }

export interface ChallengeView {
  def: ChallengeDef;
  goalAbs: number;
  floorAbs: number;
  members: MemberLine[];
  stats: MemberStat[];
  games: GameRow[];
  flow: FlowPoint[];
  days: DayLog[];
  records: RecordRow[];
  record: { games: number; wins: number; bestWinStreak: number; worstLoseStreak: number; remakes: number; current: Run | null };
  coPlayers: CoPlayer[];
  /** 랭크 스냅샷 기준 시즌 판 수(Riot) — 수집한 판 수와 다르면 수집이 밀린 것 */
  riotGames: number | null;
}

const pct = (v: number | undefined) => (v == null ? 0 : v * 100);
const kdaOf = (k: number, d: number, a: number) => (k + a) / Math.max(1, d);
const absOf = (s: { tier: string; division?: string | null; lp: number }) => lpAbsolute({ tier: s.tier, division: s.division ?? "IV", leaguePoints: s.lp });

export function buildChallenge(
  def: ChallengeDef,
  rowsAll: PublicRankedGame[],
  ranks: PublicAccountRank[],
  lineups: PublicLineupSlot[],
): ChallengeView {
  const goalAbs = absOf({ tier: def.goal.tier, division: def.goal.division ?? "IV", lp: 0 });
  if (goalAbs == null) throw new Error(`목표 티어를 모른다: ${def.goal.tier}`);
  const idx = new Map(def.members.map((m, i) => [m.puuid, i]));
  const remakes = new Set(rowsAll.filter((r) => r.game_duration < REMAKE_SEC).map((r) => r.match_id));
  const rows = rowsAll.filter((r) => !remakes.has(r.match_id));

  // ── 랭크: 지금(스냅샷) · 출발(설정)
  const members: MemberLine[] = def.members.map((m) => {
    const last = ranks.filter((r) => r.puuid === m.puuid && r.lp_absolute != null).at(-1);
    const startAbs = m.start ? absOf(m.start) : null;
    const abs = last?.lp_absolute ?? null;
    return {
      member: m,
      rank: last ? { tier: last.tier, division: last.division, lp: last.league_points, wins: last.wins, losses: last.losses, abs, date: last.snapshot_date } : null,
      startAbs,
      gained: abs != null && startAbs != null ? abs - startAbs : null,
      toGoal: abs != null ? Math.max(0, goalAbs - abs) : null,
    };
  });
  const lows = members.flatMap((m) => [m.startAbs, m.rank?.abs]).filter((v): v is number => v != null);
  const floorAbs = lows.length ? Math.min(Math.floor(Math.min(...lows) / 400) * 400, goalAbs - 400) : goalAbs - 800;

  // ── 판
  const byMatch = new Map<string, PublicRankedGame[]>();
  for (const r of rows) (byMatch.get(r.match_id) ?? byMatch.set(r.match_id, []).get(r.match_id)!).push(r);
  const lineupBy = new Map<string, PublicLineupSlot[]>();
  for (const l of lineups) (lineupBy.get(l.match_id) ?? lineupBy.set(l.match_id, []).get(l.match_id)!).push(l);
  const memberStreamer = new Map(rows.map((r) => [r.streamer_id, idx.get(r.puuid)!]));

  const games: GameRow[] = [...byMatch.values()].map((ps) => {
    const first = ps[0];
    const lines: (Line | null)[] = def.members.map(() => null);
    for (const p of ps) {
      const i = idx.get(p.puuid);
      if (i == null) continue;
      lines[i] = {
        kills: p.kills, deaths: p.deaths, assists: p.assists, cs: p.cs, damage: p.damage_to_champions,
        champId: p.champion_id, champName: championById(p.champion_id)?.name ?? p.champion_name, position: p.team_position,
        kp: Math.round(pct(p.challenges.killParticipation)), damageShare: Math.round(pct(p.challenges.teamDamagePercentage)),
        soloKills: p.challenges.soloKills ?? 0, csLead: Math.round(p.challenges.maxCsAdvantageOnLaneOpponent ?? 0),
        items: p.items ?? [], spells: [p.summoner1_id, p.summoner2_id], keystone: p.keystone_id, subStyle: p.sub_style_id,
      };
    }
    const win = first.outcome === "win";
    const g: GameRow = {
      matchId: first.match_id, at: first.game_creation.toISOString(), day: kstDateString(first.game_creation),
      minutes: Math.round(first.game_duration / 60), seconds: first.game_duration, win, surrender: !!first.ended_in_surrender,
      lines, together: ps.length >= 2 && new Set(ps.map((p) => p.team_id)).size === 1, teamId: first.team_id,
      lineup: (lineupBy.get(first.match_id) ?? []).map((l) => ({
        teamId: l.team_id, champId: l.champion_id, name: l.display_name, slug: l.slug,
        member: l.streamer_id ? memberStreamer.get(l.streamer_id) ?? null : null, kills: l.kills, deaths: l.deaths, assists: l.assists,
      })),
      tags: [],
    };
    g.tags = gameTags(g, def.members);
    return g;
  }).sort((a, b) => a.at.localeCompare(b.at));

  // ── 흐름(누적 승−패)·연승
  let net = 0, run = 0, best = 0, worst = 0;
  const flow: FlowPoint[] = games.map((g, i) => {
    net += g.win ? 1 : -1;
    run = g.win ? Math.max(1, run + 1) : Math.min(-1, run - 1);
    best = Math.max(best, run); worst = Math.min(worst, run);
    return { i, net, win: g.win, day: g.day };
  });

  // ── 방송 일지(KST 날짜)
  const dayMap = new Map<string, GameRow[]>();
  for (const g of games) (dayMap.get(g.day) ?? dayMap.set(g.day, []).get(g.day)!).push(g);
  const runsOf = (gs: GameRow[]): Run[] => {
    const out: Run[] = [];
    for (const g of gs) {
      const last = out.at(-1);
      if (last && last.win === g.win) last.n++;
      else out.push({ win: g.win, n: 1, firstMatchId: g.matchId });
    }
    return out;
  };
  const days: DayLog[] = [...dayMap.entries()].map(([day, gs]) => ({
    day, games: gs.length, wins: gs.filter((g) => g.win).length, losses: gs.filter((g) => !g.win).length, runs: runsOf(gs),
  }));

  // ── 멤버별 챔피언 표(전적 사이트 형식)
  const stats: MemberStat[] = def.members.map((m) => {
    const mine = rows.filter((r) => r.puuid === m.puuid);
    const champs = new Map<number, ChampRow & { mins: number; dmg: number; csSum: number }>();
    for (const r of mine) {
      const c = champs.get(r.champion_id) ?? champs.set(r.champion_id, {
        id: r.champion_id, name: championById(r.champion_id)?.name ?? r.champion_name, games: 0, wins: 0, losses: 0, shrunk: 0,
        kda: 0, csPerMin: 0, dmgPerMin: 0, kills: 0, deaths: 0, assists: 0, mins: 0, dmg: 0, csSum: 0,
      }).get(r.champion_id)!;
      c.games++; if (r.outcome === "win") c.wins++; else c.losses++;
      c.kills += r.kills; c.deaths += r.deaths; c.assists += r.assists;
      c.mins += r.game_duration / 60; c.dmg += r.damage_to_champions; c.csSum += r.cs;
    }
    return {
      games: mine.length, wins: mine.filter((r) => r.outcome === "win").length,
      champs: [...champs.values()].map(({ mins, dmg, csSum, ...c }) => ({
        ...c, shrunk: affinity({ wins: c.wins, losses: c.losses }), kda: kdaOf(c.kills, c.deaths, c.assists),
        csPerMin: csSum / Math.max(1, mins), dmgPerMin: dmg / Math.max(1, mins),
      })).sort((a, b) => b.games - a.games || b.shrunk - a.shrunk),
    };
  });

  // ── 같은 판의 다른 스트리머
  const coMap = new Map<string, CoPlayer>();
  for (const g of games) for (const s of g.lineup) {
    if (!s.slug || s.member != null) continue;
    const e = coMap.get(s.slug) ?? coMap.set(s.slug, { slug: s.slug, name: s.name ?? s.slug, ally: 0, enemy: 0 }).get(s.slug)!;
    if (s.teamId === g.teamId) e.ally++; else e.enemy++;
  }

  const riot = members.map((m) => (m.rank?.wins ?? 0) + (m.rank?.losses ?? 0));
  return {
    def, goalAbs, floorAbs, members, stats, games, flow, days,
    records: buildRecords(def, games, rows, best, worst),
    record: { games: games.length, wins: games.filter((g) => g.win).length, bestWinStreak: best, worstLoseStreak: -worst, remakes: remakes.size, current: runsOf(games).at(-1) ?? null },
    coPlayers: [...coMap.values()].sort((a, b) => b.ally + b.enemy - (a.ally + a.enemy)),
    riotGames: riot.some((n) => n > 0) ? Math.max(...riot) : null,
  };
}

/** 기록실 — 이 도전의 명기록. 같은 값이면 먼저 나온 판. 해당이 없으면 그 줄을 빼지 않고 "없음"으로 둔다(없다는 것도 기록이다). */
function buildRecords(def: ChallengeDef, games: GameRow[], rows: PublicRankedGame[], best: number, worst: number): RecordRow[] {
  const at = (id: string) => games.find((g) => g.matchId === id)?.at ?? null;
  const who = (r: PublicRankedGame) => def.members[def.members.findIndex((m) => m.puuid === r.puuid)]?.name ?? null;
  const champ = (r: PublicRankedGame) => championById(r.champion_id)?.name ?? r.champion_name;
  const top = (key: string, label: string, f: (r: PublicRankedGame) => number | null, show: (v: number, r: PublicRankedGame) => string, opts: { min?: number; lowest?: boolean } = {}): RecordRow => {
    let pick: PublicRankedGame | null = null, val = 0;
    for (const r of rows) {
      const v = f(r);
      if (v == null || (opts.min != null && v < opts.min)) continue;
      if (!pick || (opts.lowest ? v < val : v > val)) { pick = r; val = v; }
    }
    return pick ? { key, label, value: show(val, pick), who: who(pick), champ: champ(pick), matchId: pick.match_id, at: at(pick.match_id) }
      : { key, label, value: "없음", who: null, champ: null, matchId: null, at: null };
  };
  const kdaText = (r: PublicRankedGame) => `${r.kills}/${r.deaths}/${r.assists}`;
  const ch = (k: keyof PublicRankedGame["challenges"]) => (r: PublicRankedGame) => r.challenges[k] ?? null;
  const out: RecordRow[] = [
    top("kills", "최다 킬", (r) => r.kills, (v, r) => `${v}킬 · ${kdaText(r)}`),
    top("deaths", "최다 데스", (r) => r.deaths, (v, r) => `${v}데스 · ${kdaText(r)}`),
    top("assists", "최다 어시스트", (r) => r.assists, (v, r) => `${v}어시 · ${kdaText(r)}`),
    top("kda", "최고 KDA", (r) => kdaOf(r.kills, r.deaths, r.assists), (v, r) => `${v.toFixed(1)} · ${kdaText(r)}`),
    top("dpm", "분당 딜 최고", ch("damagePerMinute"), (v) => `${Math.round(v).toLocaleString("ko-KR")}/분`),
    top("solo", "최다 솔로킬", ch("soloKills"), (v) => `솔킬 ${v}`, { min: 1 }),
    top("multi", "최다 멀티킬(더블 이상)", ch("multikills"), (v) => `${v}번`, { min: 1 }),
    top("spree", "최다 연속 킬 행진", ch("killingSprees"), (v) => `${v}번`, { min: 1 }),
    top("steal", "에픽 몬스터 스틸", ch("epicMonsterSteals"), (v) => `${v}번`, { min: 1 }),
    top("plates", "포탑 방패 최다", ch("turretPlatesTaken"), (v) => `${v}개`, { min: 1 }),
    top("long", "최장 경기", (r) => r.game_duration, (v, r) => `${Math.floor(v / 60)}분 ${v % 60}초 · ${r.outcome === "win" ? "승" : "패"}`),
    top("shortWin", "최단 승리", (r) => (r.outcome === "win" ? r.game_duration : null), (v) => `${Math.floor(v / 60)}분 ${v % 60}초`, { lowest: true }),
    top("shortLoss", "최단 패배", (r) => (r.outcome !== "win" ? r.game_duration : null), (v, r) => `${Math.floor(v / 60)}분 ${v % 60}초${r.ended_in_surrender ? " · 서렌" : ""}`, { lowest: true }),
  ];
  const perfect = rows.filter((r) => (r.challenges.perfectGame ?? 0) > 0);
  out.push({ key: "perfect", label: "무결점 판(노데스 승리)", value: `${perfect.length}판`, who: perfect[0] ? who(perfect[0]) : null, champ: perfect[0] ? champ(perfect[0]) : null, matchId: perfect[0]?.match_id ?? null, at: perfect[0] ? at(perfect[0].match_id) : null, note: perfect.length > 1 ? "첫 판" : undefined });
  out.push({ key: "streakW", label: "최장 연승", value: `${best}연승`, who: null, champ: null, matchId: null, at: null });
  out.push({ key: "streakL", label: "최장 연패", value: `${-worst}연패`, who: null, champ: null, matchId: null, at: null });
  return out;
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
