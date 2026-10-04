/**
 * 손으로 옮긴 로스터 표시 이름(seed/rosters/listed-names.json)을 반영한다.
 *
 *   node --env-file-if-exists=apps/web/.env.local scripts/apply-listed-names.mjs           # 미리보기
 *   node --env-file-if-exists=apps/web/.env.local scripts/apply-listed-names.mjs --apply   # 쓴다
 *
 * 순서: remove(정정) → names. names 의 이름(또는 적어 둔 slug)이 그 팀에 **포지션 없이 연결된 스트리머**와 같으면
 * 그 사람의 포지션을 채우고, 아니면 표시 이름을 넣는다. 기존 값은 덮지 않는다(core fillRosterGaps).
 */
import { readFileSync } from "node:fs";
import { db, closeDb } from "@soop-lol/core/lib/db/client";
import { fillRosterGaps, removeListedName } from "@soop-lol/core/lib/db/tournaments";

const APPLY = process.argv.includes("--apply");
const doc = JSON.parse(readFileSync("seed/rosters/listed-names.json", "utf8"));
const nameKey = (s) => String(s ?? "").toLowerCase().replace(/^\s*bj\s*/, "").replace(/[^0-9a-z가-힣]/g, "");
const sql = db();
try {
  const events = [...new Set([...doc.names, ...doc.remove].map((x) => x.event))];
  for (const slug of events) {
    const [event] = await sql`SELECT id FROM event WHERE slug = ${slug} AND game_code = 'lol'`;
    if (!event) { console.log(`✖ ${slug}: DB 에 대회가 없다`); continue; }
    for (const r of doc.remove.filter((x) => x.event === slug)) {
      const n = APPLY ? await removeListedName(event.id, r.team, r.position) : 1;
      console.log(`  ${APPLY ? "지움" : "지울 것"} ${slug} · ${r.team} · ${r.position}${APPLY ? ` (${n})` : ""} — ${r.reason}`);
    }
    const teams = new Map((await sql`SELECT id, name FROM event_team WHERE event_id = ${event.id}`).map((t) => [t.name, t.id]));
    const members = await sql`
      SELECT m.event_team_id, m.streamer_id, m.position, s.slug, s.display_name, s.aliases
        FROM event_team_member m JOIN streamer s ON s.id = m.streamer_id WHERE m.event_id = ${event.id}`;
    const positions = [], names = [];
    for (const x of doc.names.filter((n) => n.event === slug)) {
      const teamId = teams.get(x.team);
      if (!teamId) { console.log(`  ✖ ${slug}: 팀 '${x.team}' 이 DB 에 없다`); continue; }
      // slug 를 적었으면 그 스트리머로, 아니면 이름(별칭 포함)으로 잇는다
      const who = members.find((m) => m.event_team_id === teamId && !m.position && (x.slug ? m.slug === x.slug :
        [m.display_name, ...(m.aliases ?? [])].some((n) => nameKey(n) && nameKey(n) === nameKey(x.name))));
      if (x.slug && !who) { console.log(`  ✖ ${slug}: '${x.team}' 에 포지션 없는 ${x.slug} 가 없다 — 건너뜀`); continue; }
      if (who) positions.push({ teamId, streamerId: who.streamer_id, position: x.position, label: `${x.team} · ${x.position} ← ${who.display_name}(연결된 스트리머)` });
      else names.push({ teamId, position: x.position, name: x.name, sourceUrl: x.source, label: `${x.team} · ${x.position} · ${x.name}` });
    }
    if (APPLY) {
      const r = await fillRosterGaps(event.id, { positions, names });
      console.log(`✓ ${slug}: 포지션 채움 ${r.positioned}/${positions.length} · 표시 이름 ${r.named}/${names.length}`);
    } else {
      console.log(`· ${slug}`);
      for (const x of [...positions, ...names]) console.log(`    ${x.label}`);
    }
  }
} finally {
  await closeDb();
}
