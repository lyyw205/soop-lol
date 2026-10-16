/**
 * 상대 전적 — `core_public.versus_pair_set` 행(같은 판의 두 사람)을 사람별·시리즈별로 센다.
 *
 * ★ 한 세트의 상대전적 결과는 두 사람의 결과 **짝**으로 정한다(tally.ts 의 pairSetOutcome).
 *   그래서 A 의 기록과 B 의 기록은 언제나 거울이다 — 프로필 상대 전적 탭, 사이드바 "자주 만난 매치업",
 *   상대전적 상세가 모두 이 파일의 같은 함수로 센다(예전엔 셋이 각자 세서 18:27 과 11–16 처럼 어긋났다).
 * ★ 같은 팀이었던 세트는 상대전적이 아니다 — 같은 팀 전적은 본인 결과 그대로다(`pairResult`).
 * ★ 맞라인은 **세트 단위**다: 상대편이고 두 사람의 포지션(core_public.resolve_position 로 정한 값)이 같다.
 *   포지션을 못 정한 판은 맞라인이 아니다 — 틀린 맞라인 전적은 없느니만 못하다(원칙 10).
 *   시리즈는 맞라인으로 고른 세트들로 센다(일부 세트만 맞라인이면 그 세트로만).
 */
import { pairSetOutcome, tally, type Outcome, type Tally } from "./tally.ts";

export type PairRelation = "teammate" | "opponent";

/** versus_pair_set 한 행에서 세는 데 필요한 칸. a = 기준 스트리머, b = 상대. */
export interface PairSetRow {
  other_id: string;
  match_id: string;
  series_id: string;
  series_game_no: number | null;
  played_at: Date | string;
  relation: PairRelation;
  a_outcome: Outcome;
  b_outcome: Outcome;
  a_position: string | null;
  b_position: string | null;
}

/** 맞라인 세트인가 — 상대편 + 같은 포지션(둘 다 확정된 값). */
export const isLanePair = (r: Pick<PairSetRow, "relation" | "a_position" | "b_position">) =>
  r.relation === "opponent" && r.a_position != null && r.a_position !== "" && r.a_position === r.b_position;

/** 기준 스트리머(a) 쪽에서 본 이 세트의 결과. 상대편이면 결과 짝, 같은 팀이면 본인 결과. */
export const pairResult = (r: Pick<PairSetRow, "relation" | "a_outcome" | "b_outcome">): Outcome =>
  r.relation === "opponent" ? pairSetOutcome(r.a_outcome, r.b_outcome) : r.a_outcome;

export type PairView = "opponent" | "lane" | "teammate";

/** 관계 보기(상대 팀·맞라인·같은 팀)로 세트를 고른다. 세트 단위라 시리즈는 고른 세트로 센다. */
export function selectPairs<T extends Pick<PairSetRow, "relation" | "a_position" | "b_position">>(rows: readonly T[], view: PairView): T[] {
  if (view === "teammate") return rows.filter((r) => r.relation === "teammate");
  if (view === "lane") return rows.filter(isLanePair);
  return rows.filter((r) => r.relation === "opponent");
}

export interface OpponentSummary {
  other_id: string;
  /** 세트·시리즈 둘 다 — 화면은 RecordPair 로 통째로 보인다. */
  record: Tally;
  last_met: Date;
}

/** 넘겨받은 세트(이미 고른 것)를 상대별로 센다. 같은 세트가 두 번 와도 한 번만. */
export function summarizeOpponents(rows: readonly PairSetRow[]): OpponentSummary[] {
  const by = new Map<string, Map<string, PairSetRow>>();
  for (const r of rows) {
    const sets = by.get(r.other_id) ?? new Map<string, PairSetRow>();
    sets.set(r.match_id, r);
    by.set(r.other_id, sets);
  }
  return [...by.entries()].map(([other_id, sets]) => {
    const list = [...sets.values()];
    return {
      other_id,
      record: tally(list.map((r) => ({ series_id: r.series_id, outcome: pairResult(r) }))),
      last_met: new Date(Math.max(...list.map((r) => new Date(r.played_at).getTime()))),
    };
  });
}
