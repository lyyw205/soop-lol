/**
 * 멸망전 로스터 **남은 빈자리**를 sooplol 1회 스냅샷(out/sooplol/teams.ndjson)으로 채운다.
 *
 *   node --env-file-if-exists=apps/web/.env.local scripts/fill-roster-gaps.mjs           # 미리보기
 *   node --env-file-if-exists=apps/web/.env.local scripts/fill-roster-gaps.mjs --apply   # 쓴다
 *
 * 나무위키 표시 이름(fill-listed-names.mjs) 다음 단계다. 나무위키 표에 없던 팀·자리만 남아 있다.
 *
 * ── 무엇을 하나 ───────────────────────────────────────────────────────
 * 팀을 맞춘다: ① 이름(「Team」·「팀」·공백을 뗀 비교) ② 안 맞으면 연결 멤버의 SOOP 방송국 아이디가 2명 이상 겹치는 팀.
 * 맞춘 팀의 빈 포지션마다:
 *   - 저쪽 아이디(또는 이름)가 이 팀에 **포지션 없이 연결된 스트리머**와 같으면 → 그 사람의 포지션을 채운다
 *   - 아니면 → 저쪽 이름을 표시 이름(0068)으로 넣는다. 스트리머를 만들거나 잇지 않는다.
 * 기존 값은 덮지 않는다(core fillRosterGaps). 같은 파일을 다시 돌려도 같다.
 * ⚠ 재수집하지 않는다 — 있는 파일만 읽는다(CLAUDE.md 원칙 9, out/sooplol/README.md).
 */
import { readFileSync } from "node:fs";
import { db, closeDb } from "@soop-lol/core/lib/db/client";
import { fillRosterGaps } from "@soop-lol/core/lib/db/tournaments";

import { SOOPLOL_EVENT, SOOPLOL_SLOTS, SOOPLOL_TEAMS } from "./lib/sooplol.mjs";

const APPLY = process.argv.includes("--apply");
// 사람이 근거를 보고 지운 칸(seed/rosters/listed-names.json 의 remove)은 이 스냅샷으로 다시 채우지 않는다
// — 일반인 팀원 이름·잘못 옮긴 이름이 재실행 때 되살아나면 정정이 무의미해진다.
const corrected = JSON.parse(readFileSync("seed/rosters/listed-names.json", "utf8"));
const blocked = new Set([...corrected.remove, ...corrected.names].map((x) => `${x.event}:${x.team}:${x.position}`));
/** lib 의 대응표에 없던 회차. 34(2024 앙코르전)는 우리 2024 올스타전과 같은 대회다(팀·로스터 일치 확인). */
const EVENT = { ...SOOPLOL_EVENT, 34: "meljang-2024-allstar" };
const sourceUrl = (tid) => `https://www.sooplol.com/tournament/${tid}`;
const teamKey = (s) => String(s ?? "").toLowerCase().replace(/^team\s*/, "").replace(/\s*팀$/, "").replace(/[\s·ㆍ]/g, "");
const nameKey = (s) => String(s ?? "").toLowerCase().replace(/^\s*bj\s*/, "").replace(/[^0-9a-z가-힣]/g, "");
const cleanId = (v) => (typeof v === "string" && /^[A-Za-z0-9_]+$/.test(v.trim()) ? v.trim().toLowerCase() : null);

// sooplol 팀(이름이 빠진 팀도 남긴다 — 아이디 겹침으로 맞춘다)
const bySlug = new Map();
for (const line of readFileSync(SOOPLOL_TEAMS, "utf8").split("\n")) {
  if (!line.trim()) continue;
  const t = JSON.parse(line);
  const slug = EVENT[t.tournamentId];
  if (!slug) continue;
  const slots = SOOPLOL_SLOTS.map(([idKey, nameK, position]) => ({ position, id: cleanId(t[idKey]), name: (t[nameK] ?? "").trim() || null }));
  (bySlug.get(slug) ?? bySlug.set(slug, []).get(slug)).push({ tid: t.tournamentId, teamName: t.teamName, slots });
}

const sql = db();
const leftovers = [];
let sumPos = 0, sumName = 0;
try {
  for (const [slug, theirs] of bySlug) {
    const [event] = await sql`SELECT id FROM event WHERE slug = ${slug} AND game_code = 'lol'`;
    if (!event) continue;
    const teams = await sql`SELECT id, name FROM event_team WHERE event_id = ${event.id} ORDER BY name`;
    const members = await sql`
      SELECT m.event_team_id, m.streamer_id, m.position, s.display_name, s.aliases,
             coalesce((SELECT array_agg(lower(c.channel_id)) FROM streamer_channel c WHERE c.streamer_id = s.id AND c.platform = 'soop'), '{}') AS channels
        FROM event_team_member m JOIN streamer s ON s.id = m.streamer_id WHERE m.event_id = ${event.id}`;
    const listed = await sql`SELECT event_team_id, position FROM event_team_listed_name WHERE event_id = ${event.id}`;

    const positions = [], names = [];
    for (const team of teams) {
      const mine = members.filter((m) => m.event_team_id === team.id);
      const filled = new Set([...mine.filter((m) => m.position).map((m) => m.position),
        ...listed.filter((l) => l.event_team_id === team.id).map((l) => l.position)]);
      const gaps = SOOPLOL_SLOTS.map(([, , p]) => p).filter((p) => !filled.has(p));
      if (!gaps.length) continue;
      // ① 이름 ② 아이디 2명 이상 겹침(가장 많이 겹치는 팀 하나, 동률이면 못 정한다)
      let match = theirs.find((t) => t.teamName && teamKey(t.teamName) === teamKey(team.name));
      let how = "이름";
      if (!match) {
        // 겹침은 사람 단위로 센다: 저쪽 칸의 아이디가 멤버 채널과 같거나, 이름이 멤버 이름(별칭 포함)과 같으면 같은 사람
        const same = (s, m) => (s.id && m.channels.includes(s.id)) ||
          (s.name && [m.display_name, ...(m.aliases ?? [])].some((n) => nameKey(n) && nameKey(n) === nameKey(s.name)));
        const scored = theirs.map((t) => ({ t, n: mine.filter((m) => t.slots.some((s) => same(s, m))).length })).sort((a, b) => b.n - a.n);
        if (scored[0]?.n >= 2 && scored[0].n > (scored[1]?.n ?? 0)) { match = scored[0].t; how = `멤버 ${scored[0].n}명 겹침`; }
      }
      if (!match) { leftovers.push({ slug, team: team.name, gaps, reason: "sooplol 에 같은 팀 없음" }); continue; }
      const used = new Set();
      const stillEmpty = [];
      for (const p of gaps) {
        if (blocked.has(`${slug}:${team.name}:${p}`)) { stillEmpty.push(p); continue; }
        const slot = match.slots.find((s) => s.position === p);
        if (!slot?.id && !slot?.name) { stillEmpty.push(p); continue; }
        // 포지션 없이 연결된 이 팀 멤버 중 아이디(없으면 이름)가 같은 사람
        const who = mine.find((m) => !m.position && !used.has(m.streamer_id) &&
          ((slot.id && m.channels.includes(slot.id)) ||
           (slot.name && [m.display_name, ...(m.aliases ?? [])].some((n) => nameKey(n) === nameKey(slot.name)))));
        if (who) { used.add(who.streamer_id); positions.push({ teamId: team.id, streamerId: who.streamer_id, position: p, label: `${team.name} · ${p} ← ${who.display_name}` }); continue; }
        // 다른 포지션에 이미 연결된 같은 사람이면 이름을 또 넣지 않는다
        const elsewhere = mine.some((m) => m.position && ((slot.id && m.channels.includes(slot.id)) ||
          (slot.name && nameKey(m.display_name) === nameKey(slot.name))));
        if (elsewhere || !slot.name) { stillEmpty.push(p); continue; }
        names.push({ teamId: team.id, position: p, name: slot.name, sourceUrl: sourceUrl(match.tid), label: `${team.name} · ${p} · ${slot.name}` });
      }
      if (stillEmpty.length) leftovers.push({ slug, team: team.name, gaps: stillEmpty, reason: `sooplol(${how})에도 그 자리가 비어 있음` });
    }
    if (!positions.length && !names.length) continue;
    if (APPLY) {
      const r = await fillRosterGaps(event.id, { positions, names });
      sumPos += r.positioned; sumName += r.named;
      console.log(`✓ ${slug}: 포지션 채움 ${r.positioned} · 표시 이름 ${r.named}`);
    } else {
      sumPos += positions.length; sumName += names.length;
      console.log(`· ${slug}: 포지션 채움 ${positions.length} · 표시 이름 ${names.length}`);
      for (const x of [...positions, ...names]) console.log(`    ${x.label}`);
    }
  }
  // 대응표에 sooplol 회차가 없는 대회의 빈칸도 남은 목록에 넣는다
  const covered = new Set(bySlug.keys());
  const rest = await sql`
    WITH pos(p) AS (VALUES ('TOP'),('JUNGLE'),('MIDDLE'),('BOTTOM'),('UTILITY'))
    SELECT e.slug, t.name team, array_agg(p ORDER BY array_position(ARRAY['TOP','JUNGLE','MIDDLE','BOTTOM','UTILITY'], p)) gaps
      FROM event e JOIN event_team t ON t.event_id = e.id CROSS JOIN pos
     WHERE e.slug LIKE 'meljang-%' AND e.slug <> ALL(${[...covered]}::text[])
       AND NOT EXISTS (SELECT 1 FROM event_team_member m WHERE m.event_team_id = t.id AND m.position = p)
       AND NOT EXISTS (SELECT 1 FROM event_team_listed_name l WHERE l.event_team_id = t.id AND l.position = p)
     GROUP BY e.slug, t.name`;
  for (const r of rest) leftovers.push({ slug: r.slug, team: r.team, gaps: r.gaps, reason: "sooplol 에 회차 없음" });
  console.log(`\n${APPLY ? "반영" : "미리보기"} — 포지션 채움 ${sumPos} · 표시 이름 ${sumName}${APPLY ? "" : " (쓰려면 --apply)"}`);
  console.log(`\n남은 빈자리 ${leftovers.length}팀`);
  for (const l of leftovers) console.log(`  ${l.slug.padEnd(22)} ${String(l.team).padEnd(18)} ${l.gaps.join(",").padEnd(36)} ${l.reason}`);
} finally {
  await closeDb();
}
