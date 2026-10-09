import { closeDb, db } from "@soop-lol/core/lib/db/client";
const sql = db();
const ids = (await sql`SELECT m.match_id FROM match m WHERE m.match_id LIKE 'land-2026-09-2%-jeungkal%' OR m.match_id LIKE 'ck-2026-09-27-clid1-skqudgusgud-s%' ORDER BY m.game_creation`).map(r=>r.match_id);
const out = {};
for (const id of ids) {
  const rows = await sql`SELECT mp.participant_id, mp.team_id, mp.observed_name, mp.champion_name, mp.kills, mp.deaths, mp.assists, s.slug, m.winning_team, m.game_duration, m.game_creation
   FROM match_participant mp JOIN match m USING (match_id) LEFT JOIN streamer s ON s.id = COALESCE((SELECT sa.streamer_id FROM streamer_account sa WHERE sa.puuid=mp.puuid AND sa.active_to IS NULL), mp.streamer_id)
   WHERE mp.match_id=${id} ORDER BY mp.participant_id`;
  out[id] = rows;
}
await closeDb();
import { writeFileSync } from "node:fs";
writeFileSync("/tmp/ck/rosters.json", JSON.stringify(out));
console.log(Object.keys(out).length);
