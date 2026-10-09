import { db } from "./client.ts";

export type LoLReviewCollection = "rift" | "aram";

/** Uses the public collection rules, including Mayhem queues and excluded modes. Match alias: m. */
export function lolReviewScope(collection?: LoLReviewCollection) {
  const sql = db();
  if (!collection) return sql`true`;
  const category = sql`lol_match_category(m.source, m.queue_id, NULL::text, m.game_mode)`;
  return collection === "aram"
    ? sql`${category} IN ('aram', 'aram_custom')`
    : sql`${category} NOT IN ('aram', 'aram_custom', 'excluded')`;
}
