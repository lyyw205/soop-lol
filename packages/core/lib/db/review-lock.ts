/**
 * 검수 보호를 **칸 단위**로 판정한다 — 자동 판독(ck:merge 의 시점 추가·식별)이 검수된 경기의
 * 어느 칸을 채워도 되나. 정본은 `review_change`(0042) 다: 사람이 어느 칸을 바꿨는지 이미 거기 있다.
 *
 * ★ 왜 경기 단위로는 안 되나 — 사람이 참가자 연결 하나만 고쳐도 `match.reviewed_at` 이 찍히고,
 *   그 뒤 자동 판독이 경기를 통째로 건너뛰어 **챔피언 10칸이 빈 채로 굳었다**
 *   (2026-10-05 연결 작업으로 약 140경기. VOD 207333829 의 dudan g1·g3).
 *
 * 계약 (ck-pov · ck 의 식별 · applyMatchReview 가 이 한 곳을 쓴다):
 *   1. 사람이 바꾼 칸(`review_change` actor=admin 의 그 칸)은 자동 판독이 건드리지 않는다. 사람이 비운 칸도.
 *   2. 사람이 안 바꾼 **빈 칸**만 채운다. 채우면 actor=auto 로 남긴다(0074).
 *   3. 값이 있는 칸은 덮지 않는다 — 다른 판독은 시점 비교의 불일치로 남는다(metrics/pov.ts).
 *   4. 이력으로 사람이 바꾼 칸을 가릴 수 없는 검수 경기는 **경기 전체**를 지킨다(아래 decideReviewLock).
 *   5. 검수 완료(review_completed_at)된 경기도 전체를 지킨다 — 사람이 빈칸까지 포함한 현재 값을 확인했다.
 */

import type postgres from "postgres";

type Tx = postgres.TransactionSql | postgres.Sql;

export type ReviewEntity = "match" | "series" | "participant" | "frame";

/** review_change 의 칸 주소. 사람 기록과 자동 판정이 같은 모양을 쓰도록 여기서만 만든다. */
export interface ReviewCell { entity: ReviewEntity; entity_key: string; field: string }
export const matchCell = (matchId: string, field: string): ReviewCell => ({ entity: "match", entity_key: matchId, field });
export const participantCell = (participantId: number, field: string): ReviewCell =>
  ({ entity: "participant", entity_key: String(participantId), field });
/** 참가자 행을 통째로 더하거나 뺀 기록의 field. */
export const PARTICIPANT_ROW_FIELD = "row";

/**
 * 칸이 아니라 **경기 상태**를 남기는 기록. 사람이 어느 칸을 바꿨는지 설명하지 않는다.
 *   admin_protected  값은 그대로 두고 잠금만 건 것(markMatchReviewed·완료 시 보호) — 경기 전체 보호 의사
 *   created          관리자가 만든 경기 — 모든 값이 사람 것
 *   review_completed 완료 표시(자동 해제도 이 이름으로 남는다)
 */
const STATE_FIELDS = new Set(["admin_protected", "created", "review_completed"]);

export interface ReviewChangeLike {
  entity: string;
  entity_key: string;
  field: string;
  after: unknown;
  actor: string;
}

export type ReviewLock =
  | { mode: "open" }
  | { mode: "match"; reason: string }
  | { mode: "cells"; human: ReadonlySet<string> };

const key = (entity: string, entityKey: string, field: string) => `${entity}\u0000${entityKey}\u0000${field}`;

/**
 * 경기 하나의 보호 상태. `changes` 는 그 경기의 review_change 를 **오래된 것부터**.
 *
 *   검수 안 됨(reviewed_at 없음)          open   — 지금까지처럼 자동 경로의 규칙만 적용
 *   검수 완료                             match
 *   마지막 admin_protected 가 켜짐         match  — 사람이 "이 경기 잠가라" 를 직접 눌렀다
 *   관리자가 만든 경기(created)            match
 *   사람의 칸 기록이 하나도 없음           match  — 0042 이전 검수·SQL 로 찍은 도장 등, 무엇을 바꿨는지 모른다
 *   그 밖                                  cells  — 사람 기록이 있는 칸만 보호
 */
export function decideReviewLock(
  match: { reviewed_at: Date | string | null; review_completed_at: Date | string | null },
  changes: readonly ReviewChangeLike[],
): ReviewLock {
  if (match.review_completed_at != null) return { mode: "match", reason: "검수 완료된 경기" };
  if (match.reviewed_at == null) return { mode: "open" };
  const human = changes.filter((c) => c.actor === "admin");
  const protectedFlag = human.filter((c) => c.entity === "match" && c.field === "admin_protected").at(-1);
  if (protectedFlag?.after === true) return { mode: "match", reason: "관리자가 경기 전체를 보호했다" };
  if (human.some((c) => c.entity === "match" && c.field === "created")) return { mode: "match", reason: "관리자가 만든 경기" };
  const cells = human.filter((c) => (c.entity === "match" || c.entity === "participant" || c.entity === "series")
    && !STATE_FIELDS.has(c.field));
  if (cells.length === 0) return { mode: "match", reason: "수정 이력으로 사람이 바꾼 칸을 가릴 수 없는 검수 경기" };
  const set = new Set<string>();
  for (const c of cells) {
    // 사람이 **더한** 자리는 행 전체가 사람 값이다. 지운 자리는 행이 없으니 지킬 칸도 없다.
    if (c.entity === "participant" && c.field === PARTICIPANT_ROW_FIELD) {
      if (c.after != null) set.add(key("participant", c.entity_key, "*"));
      continue;
    }
    set.add(key(c.entity, c.entity_key, c.field));
  }
  return { mode: "cells", human: set };
}

/** 이 칸(을 이루는 컬럼들) 중 하나라도 사람이 바꿨나. cells 가 아닌 모드에서는 false. */
export function isHumanCell(lock: ReviewLock, cell: { entity: ReviewEntity; entity_key: string }, columns: readonly string[]): boolean {
  if (lock.mode !== "cells") return false;
  if (cell.entity === "participant" && lock.human.has(key("participant", cell.entity_key, "*"))) return true;
  return columns.some((f) => lock.human.has(key(cell.entity, cell.entity_key, f)));
}

export type AutoFillVerdict = "write" | "match_locked" | "human" | "occupied";

/**
 * 자동 판독이 이 칸을 **채워도** 되나. 채우기는 빈 칸에만 한다 — 값이 있으면 사람이 안 고쳤어도 덮지 않는다.
 * `empty` 는 호출자가 칸의 의미대로 정한다(챔피언은 0, 사람 연결은 puuid·streamer_id 둘 다 없음).
 */
export function autoFillVerdict(lock: ReviewLock, cell: { entity: ReviewEntity; entity_key: string }, columns: readonly string[], empty: boolean): AutoFillVerdict {
  if (lock.mode === "match") return "match_locked";
  if (isHumanCell(lock, cell, columns)) return "human";
  return empty ? "write" : "occupied";
}

/** 경기 하나의 보호 상태를 읽는다. 호출자가 이미 match 행을 FOR UPDATE 로 잠근 뒤에 부른다. */
export async function loadReviewLockInTx(tx: Tx, matchId: string): Promise<ReviewLock | null> {
  const [m] = await tx<{ reviewed_at: Date | null; review_completed_at: Date | null }[]>`
    SELECT reviewed_at, review_completed_at FROM match WHERE match_id = ${matchId}`;
  if (!m) return null;
  if (m.review_completed_at == null && m.reviewed_at == null) return { mode: "open" };
  const changes = await tx<ReviewChangeLike[]>`
    SELECT entity, entity_key, field, "after", actor FROM review_change
     WHERE match_id = ${matchId} ORDER BY changed_at, id`;
  return decideReviewLock(m, changes);
}

export interface AutoChange extends ReviewCell {
  match_id: string;
  lead_id?: string | null;
  before: unknown;
  after: unknown;
}

/** 자동 경로가 기존 경기의 칸을 바꾼 기록(actor=auto). 값이 같으면 남기지 않는다. 같은 트랜잭션에서 부른다. */
export async function recordAutoChangesInTx(tx: postgres.TransactionSql, changes: readonly AutoChange[]): Promise<void> {
  for (const c of changes) {
    const before = c.before ?? null, after = c.after ?? null;
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    await tx`
      INSERT INTO review_change (match_id, lead_id, entity, entity_key, field, before, after, actor)
      VALUES (${c.match_id}, ${c.lead_id ?? null}, ${c.entity}, ${c.entity_key}, ${c.field},
              ${before == null ? null : tx.json(before as never)}, ${after == null ? null : tx.json(after as never)}, 'auto')`;
  }
}
