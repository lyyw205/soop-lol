// Read-only existing schedule context. No secrets or admin notes are sent to the analyzer.
import { db } from '../../packages/core/lib/db/client.ts';
export async function scheduleContext() {
  const sql = db();
  try {
    const rows = await sql`
      SELECT e.id, e.title, e.game_code, e.planned_kind, e.status,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('date',s.on_date,'startsAt',s.starts_at))
          FROM schedule_slot s WHERE s.entry_id=e.id), '[]'::jsonb) AS slots,
        COALESCE((SELECT jsonb_agg(s.url) FROM schedule_source s WHERE s.entry_id=e.id), '[]'::jsonb) AS sources
      FROM schedule_entry e
      WHERE EXISTS (SELECT 1 FROM schedule_slot s WHERE s.entry_id=e.id
        AND s.on_date BETWEEN (now() AT TIME ZONE 'Asia/Seoul')::date - 7 AND (now() AT TIME ZONE 'Asia/Seoul')::date + 60)
      ORDER BY e.updated_at DESC LIMIT 201`;
    if (rows.length > 200) throw new Error('Schedule context exceeds 200; narrow the context before analyzing');
    return [...rows];
  } finally { await sql.end(); }
}
