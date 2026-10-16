/**
 * **세트와 시리즈를 세는 단일 출처** — 모든 공개 집계가 이 함수 하나로 센다(docs/CLASSIFICATION-REDESIGN-PLAN.md §5.2).
 *
 * - 세트 = 본게임 한 판의 결과. 시리즈 = 그 시리즈에서 **센 세트들**로 정한다(진행 방식과 무관 — CK·랜드·대회 같은 규칙).
 *   일부 세트만 뛴 사람은 본인이 뛴 세트로만, 상대전적은 둘이 상대편이었던 세트로만 센다 — 넘겨받은 행이 곧 센 세트다.
 * - 미상이 섞이면 결과가 뒤집힐 수 없을 때만 확정한다(1승 0패 2미상은 아직 승이 아니다).
 * - 상대전적의 한 세트 결과는 두 사람의 결과 짝으로 정한다 — 그래서 A 의 기록과 B 의 기록은 언제나 거울이다.
 * - 승 + 무 + 패 + 미상 = 판 수(세트·시리즈 각각). 숨기는 값이 없다.
 * - 저장된 세트만 센다. 안 들어온 세트를 best_of 로 짐작하지 않는다.
 * - **확인 전(pending) 세트는 세지 않는다** — 회원 제보가 바꾸고 운영자가 아직 안 본 판이다(0093, 결정 A). 목록에는 보이고 점수에는 안 들어간다.
 *   집계 뷰(lol_versus_set)는 이미 뺐고, 목록 행(lol_set_row)을 넘겨받아도 여기서 빠진다 — 세는 곳이 이 함수 하나라 규칙도 여기 하나다.
 */

export type Outcome = "win" | "draw" | "loss" | "unknown";
export interface Counts { win: number; draw: number; loss: number; unknown: number }
export interface Tally { sets: Counts; series: Counts }
export interface SetRow { series_id: string; outcome: Outcome; pending?: boolean }

/** 세는 세트인가 — 확인 전이 아니면. */
export const counted = (r: { pending?: boolean }) => r.pending !== true;

const zero = (): Counts => ({ win: 0, draw: 0, loss: 0, unknown: 0 });

/** 한 시리즈에서 센 세트들의 결과 → 시리즈 결과. 무 세트는 어느 쪽에도 안 센다. */
export function seriesOutcome(sets: readonly Outcome[]): Outcome {
  let w = 0, l = 0, u = 0;
  for (const o of sets) { if (o === "win") w++; else if (o === "loss") l++; else if (o === "unknown") u++; }
  if (w > l + u) return "win";
  if (l > w + u) return "loss";
  if (w === l && u === 0) return "draw";
  return "unknown";
}

export function tally(rows: readonly SetRow[]): Tally {
  const sets = zero(), series = zero();
  const bySeries = new Map<string, Outcome[]>();
  for (const r of rows) {
    if (!counted(r)) continue;
    sets[r.outcome]++;
    const list = bySeries.get(r.series_id);
    if (list) list.push(r.outcome); else bySeries.set(r.series_id, [r.outcome]);
  }
  for (const list of bySeries.values()) series[seriesOutcome(list)]++;
  return { sets, series };
}

/**
 * 상대전적 한 세트 — A 기준 결과. 양쪽 다 패(FC 양쪽 몰수 등)는 무.
 * 그 밖의 어긋난 짝(승/승·무/패·미상이 낀 짝)은 미상 — 데이터 모순이라 관리 화면의 정합성 목록에도 올린다.
 */
export function pairSetOutcome(a: Outcome, b: Outcome): Outcome {
  if (a === "win" && b === "loss") return "win";
  if (a === "loss" && b === "win") return "loss";
  if (a === "draw" && b === "draw") return "draw";
  if (a === "loss" && b === "loss") return "draw";
  return "unknown";
}

/** 상대전적 짝의 모순 여부 — 정합성 목록용. 양쪽 몰수는 모순이 아니라 규칙으로 정한 무다. */
export const isPairContradiction = (a: Outcome, b: Outcome) =>
  pairSetOutcome(a, b) === "unknown" && !(a === "unknown" || b === "unknown");

export const total = (c: Counts) => c.win + c.draw + c.loss + c.unknown;

/** B 기준으로 뒤집기 — 대칭 검사와 상대 쪽 화면에서 쓴다. */
export const mirror = (c: Counts): Counts => ({ win: c.loss, draw: c.draw, loss: c.win, unknown: c.unknown });
