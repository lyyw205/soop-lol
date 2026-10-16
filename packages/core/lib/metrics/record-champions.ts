/**
 * 챔피언 기록 — 사이드바 "모스트 챔피언" 과 프로필 챔피언 탭이 **같은 세트·같은 함수**로 센다.
 *
 * ★ 재료는 공개 내전 세트(core_public.lol_versus_set)의 본인 행뿐이다. 예전엔 사이드바는 파생 표(champion_stat),
 *   탭은 참가 기록에서 따로 세서 같은 사람의 같은 챔피언이 455 판·459 판으로 달랐다.
 * ★ 승패는 세트 단위다(tally 의 sets). 승·무·패·미상의 합 = 판 수 — 미상을 패로 넣지 않는다.
 * ★ KDA 평균의 분모는 셋을 다 읽은 판 수(kda_games)다 — 방송에서 승패만 읽은 판은 KDA 가 없다(0020 ⑧).
 * ★ 분당 CS 는 없다(계획 §3.6) — 내전 판은 CS 를 저장하지 않는다.
 * ★ 맞라인 상대는 상대전적과 같은 정의다(opponent-history.ts 의 isLanePair) — 상대편 스트리머와 같은 포지션.
 *   미등록 자리의 챔피언은 세지 않는다(상대전적·맞라인 전적과 같은 고르기).
 */
import { tally, type Counts, type Outcome } from "./tally.ts";

export interface ChampionSetRow {
  match_id: string;
  series_id: string;
  champion_id: number | null;
  outcome: Outcome;
  kills: number | null;
  deaths: number | null;
  assists: number | null;
}

/** 맞라인 한 세트 — 내 챔피언 쪽에서 본 상대 챔피언과 결과(상대전적 결과 짝). */
export interface LaneChampionRow {
  match_id: string;
  series_id: string;
  foe_champion_id: number | null;
  outcome: Outcome;
}

export interface ChampionLine {
  champion_id: number;
  /** 세트(판) 수 = 승+무+패+미상. */
  games: number;
  record: Counts;
  kills: number;
  deaths: number;
  assists: number;
  /** KDA 평균의 분모. 0 이면 평균을 내지 않는다. */
  kda_games: number;
}

export interface ChampionRecord extends ChampionLine {
  /** 맞라인 상대 챔피언별. 판 많은 순. */
  matchups: ChampionLine[];
}

function line(champion_id: number, sets: { series_id: string; outcome: Outcome; kills: number | null; deaths: number | null; assists: number | null }[]): ChampionLine {
  const read = sets.filter((s) => s.kills != null && s.deaths != null && s.assists != null);
  return {
    champion_id,
    games: sets.length,
    record: tally(sets).sets,
    kills: read.reduce((n, s) => n + s.kills!, 0),
    deaths: read.reduce((n, s) => n + s.deaths!, 0),
    assists: read.reduce((n, s) => n + s.assists!, 0),
    kda_games: read.length,
  };
}

const byGames = (a: ChampionLine, b: ChampionLine) => b.games - a.games || a.champion_id - b.champion_id;

/**
 * 판 많은 순 `limit` 개. ★ champion_id 0·NULL(챔피언 미상)도 한 줄로 센다 — 빼면 판 수 합이 맞지 않는다.
 */
export function championRecords(mine: readonly ChampionSetRow[], lane: readonly LaneChampionRow[], limit = 20): ChampionRecord[] {
  const sets = new Map<string, ChampionSetRow>();
  for (const s of mine) sets.set(s.match_id, s);
  const byChampion = new Map<number, ChampionSetRow[]>();
  for (const s of sets.values()) {
    const id = s.champion_id ?? 0;
    (byChampion.get(id) ?? byChampion.set(id, []).get(id)!).push(s);
  }
  // 맞라인: 내 세트(match_id)의 챔피언 아래로 상대 챔피언을 모은다. 한 세트에 상대가 둘로 읽혔으면 두 줄로 센다.
  const foes = new Map<number, Map<number, (LaneChampionRow & { kills: number | null; deaths: number | null; assists: number | null })[]>>();
  for (const l of lane) {
    const me = sets.get(l.match_id);
    if (!me) continue;
    const mineId = me.champion_id ?? 0, foeId = l.foe_champion_id ?? 0;
    const per = foes.get(mineId) ?? foes.set(mineId, new Map()).get(mineId)!;
    (per.get(foeId) ?? per.set(foeId, []).get(foeId)!).push({ ...l, kills: me.kills, deaths: me.deaths, assists: me.assists });
  }
  return [...byChampion.entries()].map(([id, list]) => ({
    ...line(id, list),
    matchups: [...(foes.get(id) ?? new Map()).entries()].map(([foeId, rows]) => line(foeId, rows)).sort(byGames),
  })).sort(byGames).slice(0, limit);
}
