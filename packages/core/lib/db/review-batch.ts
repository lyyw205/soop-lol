import { db } from "./client.ts";
import { setMatchReviewCompleted } from "./ck.ts";
import { setFcoMatchCompleted } from "../games/fconline/match-units.ts";

export interface ReviewTarget { id: string; version: number; contextVersion?: number }
/** Lock in a stable order, validate every snapshot, then complete all or none. */
export async function completeReviewBatch(game: "lol" | "fconline", targets: ReviewTarget[]): Promise<number> {
  if (!['lol', 'fconline'].includes(game) || !Array.isArray(targets) || !targets.length || targets.length > 50
    || targets.some(t => !t || typeof t.id !== 'string' || !t.id || !Number.isSafeInteger(t.version) || t.version < 0)
    || (game === 'fconline' && targets.some(t => !Number.isSafeInteger(t.contextVersion) || t.contextVersion! < 0))
    || new Set(targets.map(t => t.id)).size !== targets.length) throw new Error("확인한 경기를 1~50개 선택하세요.");
  return db().begin(async tx => {
    const ordered = [...targets].sort((a, b) => a.id.localeCompare(b.id));
    for (const t of ordered) {
      const [row] = await tx`SELECT review_version, context_review_version, review_completed_at FROM match WHERE match_id = ${t.id} AND game_code = ${game} FOR UPDATE`;
      if (!row || row.review_version !== t.version || row.review_completed_at || (game === 'fconline' && row.context_review_version !== t.contextVersion)) throw new Error("선택한 경기의 값·분류·완료 상태가 바뀌었습니다. 이번 처리는 모두 취소했습니다. 새로고침 후 다시 확인하세요.");
    }
    for (const t of ordered) {
      if (game === 'lol') await setMatchReviewCompleted(t.id, true, t.version, tx);
      else await setFcoMatchCompleted(t.id, true, t.version, tx);
    }
    return ordered.length;
  });
}
