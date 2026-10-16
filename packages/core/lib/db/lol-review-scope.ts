import { db } from "./client.ts";

export type LoLReviewCollection = "rift" | "aram";

/**
 * 검수 목록의 협곡/칼바람 구분 — 공개 화면의 맵 탭과 같은 칸(match.map, 0089 생성 칼럼) 하나를 본다.
 * 아레나·우르프 등(map = 'unsupported')은 어느 쪽에도 들지 않는다. Match alias: m.
 */
export function lolReviewScope(collection?: LoLReviewCollection) {
  const sql = db();
  if (!collection) return sql`true`;
  return collection === "aram" ? sql`m.map = 'aram'` : sql`m.map = 'rift'`;
}
