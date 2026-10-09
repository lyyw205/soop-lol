import { closeDb, db } from "@soop-lol/core/lib/db/client";
const sql = db();
const names = process.argv.slice(2);
for (const name of names) {
  const ms = await sql`SELECT m.match_id, m.series_id, m.series_game_no no, ms.best_of, ms.set_order_known sok, to_char(m.game_creation AT TIME ZONE 'Asia/Seoul','MM-DD HH24:MI') t, m.game_creation_precision p, m.game_duration d, m.winning_team w,
      left((SELECT body FROM review_record WHERE match_id=m.match_id AND type='final_evidence'), 150) ev
    FROM match m LEFT JOIN match_series ms ON ms.id=m.series_id JOIN event ev ON ev.id=COALESCE(ms.event_id,m.event_id)
    WHERE ev.name=${name} AND m.visibility='public' ORDER BY m.game_creation, m.match_id`;
  console.log(`\n### ${name}`);
  for (const m of ms) console.log(` ${m.t}${m.p==='date'?'(d)':''} ${m.match_id} ${m.series_id ? m.series_id.replace(/^.*?(series|ck)-2026-/,'')+'#'+m.no+' bo'+(m.best_of??'?') : '— 단판'} ${m.d}s | ${m.ev}`);
}
await closeDb();
