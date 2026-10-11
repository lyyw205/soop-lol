/**
 * **시리즈 점검** — 한 시리즈의 세트들을 이어 보며 팀 구성 변화·누적 스코어·이상 신호를 낸다.
 * 검수 화면(경기 화면의 시리즈 칸)과 시리즈 비교 화면이 이 함수 하나를 쓴다.
 *
 * ★ 진영(블루/레드)은 세트마다 바뀌므로 진영으로 팀을 잇지 않는다. 팀 이름이 있으면 이름으로,
 *   없으면(CK) 직전 세트 로스터와 더 많이 겹치는 쪽을 같은 팀으로 본다. 겹침이 같으면(로스터를 통째로
 *   바꿈) 잇지 않는다 — 없는 교체·없는 스코어를 지어내지 않는다.
 * ★ 보너스 판(set_role='bonus')은 본게임이 아니다 — 스코어·세트 번호 점검에서 뺀다(0079).
 */

export interface SeriesSetInput {
  match_id: string;
  series_game_no: number | null;
  set_role?: string | null;
  game_creation_epoch_ms: number;
  game_creation_precision: "datetime" | "date" | string;
  winning_team: number | null;
  blue_team: string | null;
  red_team: string | null;
  participants: Array<{ participant_id: number; team_id: number; key: string | null; name: string }>;
}

/** 세트 사이에서 같은 사람으로 보는 열쇠 — 스트리머 연결이 먼저, 없으면 화면 이름. */
export const rosterKey = (p: { streamer_slug?: string | null; observed_name?: string | null }): string | null =>
  p.streamer_slug ? `s:${p.streamer_slug}` : p.observed_name?.trim() ? `o:${p.observed_name.trim()}` : null;

export interface TeamChange {
  side: 100 | 200;
  /** 직전 세트에 없던 선수. */
  joined: Array<{ participant_id: number; name: string }>;
  /** 직전 세트에 있었는데 빠진 선수 이름. */
  left: string[];
}

export interface SeriesSetCheck {
  match_id: string;
  /** 직전 본게임 세트와 비교한 팀별 변화. 이을 수 없는 팀은 빠진다. 첫 세트는 빈 배열. */
  changes: TeamChange[];
  /** 이 세트까지의 누적 스코어 [첫 세트 블루 쪽 팀, 상대]. 팀을 이을 수 없거나 승자를 모르면 이후 null. */
  score: [number, number] | null;
  bonus: boolean;
}

export interface SeriesCheck {
  sets: SeriesSetCheck[];
  warnings: string[];
}

interface Team { name: string | null; roster: Set<string>; players: SeriesSetInput["participants"]; lineage: 0 | 1 | null }

const overlap = (a: Set<string>, b: Set<string>) => [...a].filter((k) => b.has(k)).length;

/** 세트들은 표시 순서(세트 번호 → 시각)로 넘긴다. bestOf 를 알면 선승 초과를 점검한다. */
export function checkSeries(sets: readonly SeriesSetInput[], bestOf: number | null): SeriesCheck {
  const out: SeriesSetCheck[] = [];
  const warnings: string[] = [];
  let prev: Team[] | null = null;
  let score: [number, number] | null = [0, 0];
  const need = bestOf && bestOf > 1 ? Math.ceil(bestOf / 2) : null;
  let decidedAt: string | null = null;
  for (const set of sets) {
    const bonus = set.set_role === "bonus";
    const teams: Team[] = ([100, 200] as const).map((side) => {
      const players = set.participants.filter((p) => p.team_id === side);
      return { name: side === 100 ? set.blue_team : set.red_team, players, lineage: null,
        roster: new Set(players.map((p) => p.key).filter((k): k is string => k != null)) };
    });
    const changes: TeamChange[] = [];
    if (bonus) { out.push({ match_id: set.match_id, changes, score, bonus }); continue; }
    if (!prev) {
      teams[0].lineage = 0; teams[1].lineage = 1;
    } else {
      for (const [index, team] of teams.entries()) {
        const before = team.name && prev.some((t) => t.name === team.name)
          ? prev.find((t) => t.name === team.name)!
          : (() => {
            const [x, y] = prev!.map((t) => overlap(team.roster, t.roster));
            return x === y ? null : prev![x > y ? 0 : 1];
          })();
        if (!before) continue;
        team.lineage = before.lineage;
        const joined = team.players.filter((p) => p.key && !before.roster.has(p.key)).map((p) => ({ participant_id: p.participant_id, name: p.name }));
        const left = before.players.filter((p) => p.key && !team.roster.has(p.key)).map((p) => p.name);
        if (joined.length || left.length) changes.push({ side: index === 0 ? 100 : 200, joined, left });
      }
      // 두 팀이 같은 쪽으로 이어지면(한쪽이 상대 로스터를 더 닮음) 잇기를 믿지 않는다.
      if (teams[0].lineage != null && teams[0].lineage === teams[1].lineage) teams[0].lineage = teams[1].lineage = null;
    }
    if (score) {
      const winner = set.winning_team === 100 ? teams[0] : set.winning_team === 200 ? teams[1] : null;
      score = winner?.lineage == null ? null
        : winner.lineage === 0 ? [score[0] + 1, score[1]] : [score[0], score[1] + 1];
    }
    if (decidedAt) warnings.push(`승부가 난 뒤에도 세트가 있다 — ${decidedAt} 이후 ${set.match_id}`);
    if (need && score && !decidedAt && Math.max(...score) >= need) decidedAt = set.match_id;
    out.push({ match_id: set.match_id, changes, score, bonus });
    prev = teams;
  }
  const main = sets.filter((s) => s.set_role !== "bonus");
  const numbers = main.map((s) => s.series_game_no).filter((n): n is number => n != null);
  const dup = [...new Set(numbers.filter((n, i) => numbers.indexOf(n) !== i))];
  if (dup.length) warnings.push(`세트 번호가 겹친다 — ${dup.join(", ")}세트`);
  const max = Math.max(0, ...numbers);
  const missing = Array.from({ length: max }, (_, i) => i + 1).filter((n) => !numbers.includes(n));
  if (missing.length) warnings.push(`빠진 세트 번호 — ${missing.join(", ")}세트`);
  const timed = main.filter((s) => s.game_creation_precision === "datetime" && s.series_game_no != null);
  const byTime = [...timed].sort((a, b) => a.game_creation_epoch_ms - b.game_creation_epoch_ms).map((s) => s.match_id);
  const byNumber = [...timed].sort((a, b) => a.series_game_no! - b.series_game_no!).map((s) => s.match_id);
  if (byTime.join() !== byNumber.join()) warnings.push("세트 번호 순서와 경기 시각 순서가 다르다");
  return { sets: out, warnings };
}

/** 두 경기에 함께 나온 사람 수(팀 무관). 시리즈로 묶을 후보를 고를 때 쓴다. */
export function sharedPlayers(a: SeriesSetInput["participants"], b: SeriesSetInput["participants"]): number {
  return overlap(new Set(a.map((p) => p.key).filter((k): k is string => k != null)), new Set(b.map((p) => p.key).filter((k): k is string => k != null)));
}
