/**
 * 멸망전 로스터 빈자리에 **나무위키 참가팀 표의 이름**을 표시용으로 채운다(0068 event_team_listed_name).
 *
 *   node --env-file-if-exists=apps/web/.env.local scripts/fill-listed-names.mjs meljang-2026-s1          # 미리보기
 *   node --env-file-if-exists=apps/web/.env.local scripts/fill-listed-names.mjs meljang-2026-s1 --apply  # 쓴다
 *   node --env-file-if-exists=apps/web/.env.local scripts/fill-listed-names.mjs --all [--apply]          # 전 회차
 *
 * ── 왜 ────────────────────────────────────────────────────────────────
 * 시드 생성(build-meljang)은 SOOP 방송국 아이디로 이어지는 사람만 로스터에 넣고 나머지 이름은 버렸다.
 * 그래서 예선 팀 로스터 상당수가 「미수집」이었다. 사람으로 잇지 못해도 출처가 적은 이름은 보여 준다.
 *
 * ── 안 하는 것 ─────────────────────────────────────────────────────────
 * 1. 스트리머를 만들거나 잇지 않는다. 이름은 표시 전용이다 — 상대전적·통계에 안 들어간다(0068 주석).
 * 2. 연결된 멤버가 있는 자리는 건드리지 않는다. 포지션 없이 연결된 멤버가 같은 이름이면 그 이름도 넣지 않는다.
 * 3. 나무위키 표를 못 읽으면 그 회차는 건너뛴다(기존 표시 이름을 지우지 않는다).
 * 나무위키는 기존 시드 경로(seed:meljang)와 같은 출처다. 회차마다 한 번만, 쉬어 가며 읽는다.
 */
import { db, closeDb } from "@soop-lol/core/lib/db/client";
import { saveListedNames } from "@soop-lol/core/lib/db/tournaments";

import { fetchRosters, namuUrl, normTeam } from "./lib/namu.mjs";
import { SEASONS } from "./meljang-seasons.mjs";

const APPLY = process.argv.includes("--apply");
const keys = process.argv.includes("--all")
  ? Object.keys(SEASONS).filter((k) => SEASONS[k].namu?.length)
  : process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!keys.length) {
  console.error("사용법: scripts/fill-listed-names.mjs <회차 slug…> | --all  [--apply]");
  process.exit(1);
}
const POSITIONS = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"];
/** 이름이 아닌 칸 — 비어 있음·미정 표기 */
const EMPTY = /^(-|—|–|\?|x|X|미정|없음|공석)$/;
const clean = (s) => String(s ?? "").split("\n")[0].replace(/\[\d+\]/g, "").trim();
/** 같은 사람 비교용 — 'BJ주잔' 과 '주잔.' 이 같게. 앞의 BJ, 공백·기호를 뗀다 */
const norm = (s) => String(s).toLowerCase().replace(/^\s*bj\s*/, "").replace(/[^0-9a-z가-힣]/g, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sql = db();
let total = 0;
try {
  for (const [i, key] of keys.entries()) {
    if (i) await sleep(1500);
    const season = SEASONS[key];
    const [event] = await sql`SELECT id FROM event WHERE slug = ${key} AND game_code = 'lol'`;
    if (!event) { console.log(`· ${key}: DB 에 대회가 없다 — 건너뜀`); continue; }
    const title = season.namu[0];
    const table = await fetchRosters(title);
    if (!table) { console.log(`· ${key}: 나무위키 참가팀 표를 못 읽었다 — 건너뜀(기존 이름 유지)`); continue; }
    const url = namuUrl(title);

    const teams = await sql`SELECT id, name FROM event_team WHERE event_id = ${event.id}`;
    const byNorm = new Map(teams.map((t) => [normTeam(t.name), t.name]));
    const members = await sql`
      SELECT m.event_team_id, m.position, s.display_name, s.aliases
        FROM event_team_member m JOIN streamer s ON s.id = m.streamer_id WHERE m.event_id = ${event.id}`;
    const teamId = new Map(teams.map((t) => [t.name, t.id]));

    const rows = [];
    const unmatchedTeams = [];
    for (const [rawTeam, names] of Object.entries(table)) {
      // 대회 중 이름을 바꾼 팀은 'A ▶ B' — 어느 쪽이든 DB 팀명과 맞으면 그 팀이다
      const team = rawTeam.split(/[▶→]/).map((x) => byNorm.get(normTeam(x.trim()))).find(Boolean);
      if (!team) { unmatchedTeams.push(rawTeam); continue; }
      const linkedNames = new Set(members.filter((m) => m.event_team_id === teamId.get(team))
        .flatMap((m) => [m.display_name, ...(m.aliases ?? [])]).map(norm));
      names.slice(0, 5).forEach((raw, idx) => {
        const name = clean(raw);
        if (!name || EMPTY.test(name) || linkedNames.has(norm(name))) return;
        rows.push({ team, position: POSITIONS[idx], name, sourceUrl: url });
      });
    }
    if (APPLY) {
      const r = await saveListedNames(event.id, rows);
      total += r.inserted;
      console.log(`✓ ${key}: 표시 이름 ${r.inserted}칸 · 연결된 멤버가 있어 건너뜀 ${r.skippedLinked}칸`
        + (unmatchedTeams.length ? ` · DB 에 없는 팀 ${unmatchedTeams.length}개(${unmatchedTeams.slice(0, 3).join(", ")}…)` : ""));
    } else {
      // 미리보기: 연결된 멤버가 있는 포지션은 저장 함수가 건너뛴다 — 여기서도 같은 기준으로 센다
      const linkedPos = new Set(members.filter((m) => m.position).map((m) => `${m.event_team_id}:${m.position}`));
      const fill = rows.filter((r) => !linkedPos.has(`${teamId.get(r.team)}:${r.position}`));
      total += fill.length;
      console.log(`· ${key}: 채울 칸 ${fill.length} (나무위키 팀 ${Object.keys(table).length} · DB 팀 ${teams.length}`
        + (unmatchedTeams.length ? ` · DB 에 없는 팀 ${unmatchedTeams.length}` : "") + ")");
      for (const r of fill.slice(0, 6)) console.log(`    ${r.team} · ${r.position} · ${r.name}`);
    }
  }
  console.log(`\n${APPLY ? "반영" : "미리보기"} 합계 ${total}칸${APPLY ? "" : " — 쓰려면 --apply"}`);
} finally {
  await closeDb();
}
