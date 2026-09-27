/** match_series의 쓰기 규칙. CK·대회 시드가 같은 검증과 충돌 정책을 공유한다. */

import type postgres from "postgres";

type Tx = postgres.TransactionSql;
export type SeriesGameCode = "lol" | "fconline";

export interface MatchSeriesInput {
  id: string;
  game_code: SeriesGameCode;
  event_id?: string | null;
  best_of?: number | null;
  best_of_evidence?: string | null;
  /** 대회 안의 위치 ("8강 2경기"). 세트 번호는 빼고 적는다. */
  round_label?: string | null;
  /** 세트 순서를 출처에서 확인했으면 true. 모르면 비운다(false 로 내려가지 않는다). */
  set_order_known?: boolean;
}

export interface MatchSeriesRow {
  id: string;
  game_code: SeriesGameCode;
  event_id: string | null;
  best_of: number | null;
  best_of_evidence: string | null;
  round_label: string | null;
  set_order_known: boolean;
}

const SERIES_COLUMNS = "id, game_code, event_id, best_of, best_of_evidence, round_label, set_order_known";

export function validateBestOf(bestOf: number | null | undefined, evidence: string | null | undefined): void {
  if (bestOf == null) return;
  if (!Number.isInteger(bestOf) || bestOf <= 0 || bestOf % 2 === 0) {
    throw new Error("best_of는 양의 홀수여야 합니다. 고정 2세트제나 모르는 포맷은 비워 두세요.");
  }
  if (!evidence?.trim()) throw new Error("best_of를 채우려면 대회 규정이나 VOD 시각 근거가 필요합니다.");
}

/**
 * 시리즈를 만들거나 기존 정본과 일치하는지 확인한다.
 * 기존 non-null 값을 다른 값으로 조용히 덮지 않는다 — 잘못된 입력 한 건이 모든 세트를 바꾸기 때문이다.
 */
export async function ensureMatchSeries(tx: Tx, input: MatchSeriesInput): Promise<MatchSeriesRow> {
  const id = input.id.trim();
  if (!id) throw new Error("series_id가 비어 있습니다.");
  validateBestOf(input.best_of, input.best_of_evidence);

  await tx`
    INSERT INTO match_series (id, game_code, event_id, best_of, best_of_evidence)
    VALUES (${id}, ${input.game_code}, ${input.event_id ?? null}::uuid,
            ${input.best_of ?? null}, ${input.best_of_evidence?.trim() || null})
    ON CONFLICT (id) DO NOTHING
  `;
  // round_label·set_order_known 은 아래에서 기존 값과 대조해 채운다(새 행이어도 같은 길).
  const [current] = await tx<MatchSeriesRow[]>`
    SELECT ${tx.unsafe(SERIES_COLUMNS)} FROM match_series WHERE id = ${id} FOR UPDATE
  `;
  if (current.game_code !== input.game_code) {
    throw new Error(`시리즈 ${id}는 ${current.game_code} 경기입니다. ${input.game_code} 경기를 섞을 수 없습니다.`);
  }
  if (input.event_id !== undefined && current.event_id !== input.event_id) {
    // null도 하나의 명시적 값이다. event를 옮기는 일은 영향 범위를 보여주는 별도 검수로만 한다.
    throw new Error(`시리즈 ${id}의 event가 기존 값과 다릅니다.`);
  }
  if (input.best_of != null && current.best_of != null && current.best_of !== input.best_of) {
    throw new Error(`시리즈 ${id}의 best_of는 이미 ${current.best_of}입니다.`);
  }
  const roundLabel = input.round_label?.trim() || null;
  if (roundLabel && current.round_label && current.round_label !== roundLabel) {
    // 같은 시리즈에 라운드명이 둘이면 어느 쪽이 맞는지 여기서 고르지 않는다.
    throw new Error(`시리즈 ${id}의 라운드명은 이미 "${current.round_label}"입니다 (입력: "${roundLabel}").`);
  }

  const set: Record<string, unknown> = {};
  if (input.best_of != null && current.best_of == null) {
    set.best_of = input.best_of;
    set.best_of_evidence = input.best_of_evidence!.trim();
  }
  if (roundLabel && !current.round_label) set.round_label = roundLabel;
  // 확인된 순서를 "모름" 으로 내리지 않는다 — 시드는 모른다고 말할 뿐 틀렸다고 하지 않는다.
  if (input.set_order_known && !current.set_order_known) set.set_order_known = true;
  if (Object.keys(set).length === 0) return current;

  const [updated] = await tx<MatchSeriesRow[]>`
    UPDATE match_series SET ${tx(set, ...Object.keys(set))}, updated_at = now()
     WHERE id = ${id}
     RETURNING ${tx.unsafe(SERIES_COLUMNS)}
  `;
  return updated;
}
