import { db } from "./client.ts";
import { listReviewChanges } from "./ck.ts";
export interface AdminHistoryRow { id: string; entity: string; operation: string; before: unknown; after: unknown; changed_at: string }
export async function listAdminHistory(scope: "match" | "streamer" | "schedule" | "candidate" | "event", key: string): Promise<AdminHistoryRow[]> {
  const rows = await db()`SELECT id::text, entity, operation, before, after, changed_at FROM admin_audit
    WHERE scope = ${scope} AND scope_key = ${key} ORDER BY id DESC LIMIT 100`;
  const out: AdminHistoryRow[] = rows.map(r => ({ id: `audit:${r.id}`, entity: r.entity, operation: r.operation, before: r.before, after: r.after, changed_at: new Date(r.changed_at).toISOString() }));
  if (scope === "match") {
    const changes = await listReviewChanges({ match_id: key });
    out.push(...changes.slice(-100).map(r => ({ id: `review:${r.id}`, entity: `${r.entity} ${r.entity_key} · ${r.field}`, operation: "UPDATE", before: r.before, after: r.after, changed_at: new Date(r.changed_at).toISOString() })));
  }
  return out.sort((a, b) => b.changed_at.localeCompare(a.changed_at)).slice(0, 100);
}
