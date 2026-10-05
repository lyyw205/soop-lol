/**
 * 검수 보호가 **칸 단위**로 도는지 실제 `ck:merge` 명령으로 끝까지 돌려 본다(0074, core/lib/db/review-lock.ts).
 *
 *   npm run verify:ck:cell-lock
 *
 * 재현하는 사고: 사람이 참가자 연결 하나만 고쳤는데 경기 전체가 잠겨, 다른 시점이 읽은 챔피언이
 * 빈 칸에 못 들어갔다(2026-10-05, VOD 207333829 dudan g1·g3 등 약 140경기).
 *
 * PGlite 에 마이그레이션을 전부 올리고, 가짜 VOD 사진만 만들어 `node scripts/ck-merge.mjs --result` 로 넣는다.
 * 사람의 수정은 검수 화면이 실제로 부르는 함수(reviewUnidentifiedParticipants·applyMatchReview·
 * setMatchReviewCompleted)로 한다. 가짜는 VOD 화면(사진 파일)뿐이다.
 */

import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

import { freePort } from "./lib/disposable-postgres.ts";
import { applyAll } from "./lib/migrations.ts";

const ROOT = join(import.meta.dirname, "..");
const WORK = join(ROOT, "out", "ck", "_verify-cell-lock");
// 실제 VOD 번호와 겹치지 않는 가짜 번호. ck-merge 가 사진 파일 존재를 보므로 out/ck/<번호>/ 에 만든다.
const VOD_A = 99990301, VOD_B = 99990302;

let failures = 0, passed = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${!ok && detail ? ` — ${detail}` : ""}`);
  if (ok) passed++; else failures++;
}

const pg = await PGlite.create({ extensions: { pg_trgm, pgcrypto } });
const PORT = await freePort();
// 이 프로세스와 자식 ck:merge 가 같이 붙는다. 자식이 도는 동안 이쪽은 기다리기만 한다.
const server = new PGLiteSocketServer({ db: pg, port: PORT, host: "127.0.0.1", maxConnections: 30 });
await server.start();
const DATABASE_URL = `postgres://postgres@127.0.0.1:${PORT}/postgres`;
process.env.DATABASE_URL = DATABASE_URL;

const { db: sql, closeDb } = await import("../packages/core/lib/db/client.ts");
const streamers = await import("../packages/core/lib/db/streamers.ts");
const ck = await import("../packages/core/lib/db/ck.ts");
const lockLib = await import("../packages/core/lib/db/review-lock.ts");

const framePath = (vod: number, s: number) => `out/ck/${vod}/g${String(s).padStart(7, "0")}.jpg`;
function fakeVod(vod: number, secs: number[]) {
  const dir = join(ROOT, "out", "ck", String(vod));
  mkdirSync(dir, { recursive: true });
  for (const s of secs) writeFileSync(join(dir, `g${String(s).padStart(7, "0")}.jpg`), "x");
}
function scan(vod: number, channel: string, secs: number[]) {
  return {
    resultType: "scan",
    lead: { source_key: `vod:${vod}`, title: `검증 VOD ${vod}`, url: `https://vod.sooplive.com/player/${vod}`,
      channel_id: channel, observed_at: "2026-09-16T15:00:00Z" },
    scan: { status: "done", requested: [[0, 7200]], sampled: [[0, 7200]], opened: secs },
    frames: secs.map((s) => ({ frame_path: framePath(vod, s), at_sec: s, kind: "result" })),
  };
}
let fileNo = 0;
/** ★ 비동기로 돌린다 — PGlite 서버가 이 프로세스 안에 있어 spawnSync 로 기다리면 자식이 연결을 못 한다. */
function merge(results: unknown[]): Promise<{ code: number; out: string }> {
  mkdirSync(WORK, { recursive: true });
  const file = join(WORK, `r${++fileNo}.json`);
  writeFileSync(file, JSON.stringify(results));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(ROOT, "scripts", "ck-merge.mjs"), "--result", file], {
      cwd: ROOT, env: { ...process.env, DATABASE_URL, DATABASE_POOL_MAX: "2" },
    });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("close", (code) => resolve({ code: code ?? 1, out }));
  });
}

type Row = { participant_id: number; streamer_id: string | null; champion_id: number; champion_name: string | null; kills: number | null };
const rows = async (matchId: string) => sql()<Row[]>`
  SELECT participant_id, streamer_id, champion_id, champion_name, kills FROM match_participant
   WHERE match_id = ${matchId} ORDER BY participant_id`;
const seat = async (matchId: string, pid: number) => (await rows(matchId)).find((r) => r.participant_id === pid)!;
const changes = async (matchId: string) => sql()<{ entity_key: string; field: string; actor: string; before: unknown; after: unknown }[]>`
  SELECT entity_key, field, actor, before, "after" FROM review_change WHERE match_id = ${matchId} ORDER BY id`;
const matchRow = async (matchId: string) => (await sql()<{ reviewed_at: Date | null; review_completed_at: Date | null; review_version: number }[]>`
  SELECT reviewed_at, review_completed_at, review_version FROM match WHERE match_id = ${matchId}`)[0];
const lockOf = async (matchId: string) => sql().begin((tx) => lockLib.loadReviewLockInTx(tx, matchId));

const people = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "x"];
const id: Record<string, string> = {};

/**
 * 첫 시점(VOD A, 방송 주인 a)이 만든 경기. 3번 자리는 화면 이름만 읽어 사람을 못 붙였고(c),
 * 2·3·4번 챔피언과 10번 사람은 못 읽었다 — 다른 시점이 채울 빈 칸이다.
 */
function created(matchId: string, at: string) {
  const champs = ["가렌", null, null, null, "룰루", "아리", "징크스", "리 신", "블리츠크랭크", "코르키"];
  return {
    resultType: "match", match_id: matchId, game_mode: "CLASSIC", winning_team: 100, played_at: at,
    played_at_precision: "date", duration: 1800, result_evidence: "결과창 점수판",
    evidence_frames: [framePath(VOD_A, 100)],
    participants: people.slice(0, 10).map((p, i) => ({
      participant_id: i + 1, team_id: i < 5 ? 100 : 200,
      ...(i === 2 ? { observed_name: "미식별셋" } : i === 9 ? { observed_name: "미식별열" } : { streamer_slug: `cl-${p}` }),
      ...(champs[i] ? { champion_name: champs[i] } : {}),
      kills: i, deaths: 1, assists: 2,
    })),
  };
}
/** 두 번째 시점(VOD B, 방송 주인 c — 3번 자리). 이 화면에서 직접 읽은 칸만 낸다. */
function second(matchId: string, extra: Record<string, unknown>[] = []) {
  return {
    resultType: "match", match_id: matchId, pov: { source: "own", link_basis: "같은 10명 로비, 결과창 KDA 일치" },
    evidence_frames: [framePath(VOD_B, 200)],
    participants: [
      { streamer_slug: "cl-b", champion_name: "코르키" },
      { streamer_slug: "cl-c", champion_name: "아리" },
      { streamer_slug: "cl-d", champion_name: "블리츠크랭크" },
      ...extra,
    ],
  };
}

try {
  console.log("\n▸ 준비 — VOD A 가 경기 넷을 만든다");
  await applyAll((s) => pg.exec(s), ROOT);
  for (const p of people) {
    await streamers.createStreamer({ slug: `cl-${p}`, display_name: `칸${p.toUpperCase()}`, channel: { channel_id: `cl_${p}` } });
    id[p] = (await ck.streamerIdBySlug(`cl-${p}`))!;
  }
  fakeVod(VOD_A, [100]);
  fakeVod(VOD_B, [200]);
  const M = { link: "cl:link-only", human: "cl:human-values", legacy: "cl:legacy", done: "cl:completed" };
  let r = await merge([scan(VOD_A, "cl_a", [100]),
    created(M.link, "2026-09-16T10:00:00Z"), created(M.human, "2026-09-16T11:00:00Z"),
    created(M.legacy, "2026-09-16T12:00:00Z"), created(M.done, "2026-09-16T13:00:00Z")]);
  check("경기 넷 생성", r.code === 0, r.out.slice(-400));

  // 사람의 연결 — 2026-10-05 작업과 같은 경로(미식별 자리 일괄 연결 → applyMatchReview).
  const target = (matchId: string) => ({ match_id: matchId, participant_id: 3, observed_name: "미식별셋", reviewed_at: null });
  await ck.reviewUnidentifiedParticipants([target(M.link), target(M.human), target(M.done)], id.c);
  check("사람 연결이 reviewed_at 을 찍는다(지금 동작 그대로)", (await matchRow(M.link)).reviewed_at != null);
  check("사람 연결만 고친 경기는 칸 단위 보호", (await lockOf(M.link))?.mode === "cells", JSON.stringify(await lockOf(M.link)));

  console.log("\n▸ a. 사람 연결만 고친 경기 — 다른 칸의 빈 챔피언이 자동 판독으로 채워진다(ck:merge)");
  const statBefore = await sql()<{ n: number }[]>`SELECT COALESCE(max(games), 0)::int n FROM champion_stat WHERE streamer_id = ${id.b} AND champion_id = 42`;
  r = await merge([scan(VOD_B, "cl_c", [200]), second(M.link, [{ streamer_slug: "cl-a", kills: 7 }])]);
  check("시점 제출 통과", r.code === 0 && r.out.includes("빈 칸 채움 3"), r.out.slice(-500));
  const link = await rows(M.link);
  check("★★ 다른 자리(2·4번)의 빈 챔피언이 채워진다", link[1].champion_id === 42 && link[3].champion_id === 53, JSON.stringify(link.slice(0, 4)));
  check("★★ 사람이 연결만 고친 3번 자리의 빈 챔피언도 채워진다(같은 자리 다른 칸)", link[2].champion_id === 103 && link[2].streamer_id === id.c,
    JSON.stringify(link[2]));
  const autoRows = (await changes(M.link)).filter((c) => c.actor === "auto");
  check("★ 채운 칸이 review_change 에 actor=auto 로 남는다(전→후)",
    autoRows.some((c) => c.entity_key === "2" && c.field === "champion_id" && c.before === 0 && c.after === 42)
      && autoRows.some((c) => c.entity_key === "2" && c.field === "champion_name" && c.after === "Corki"),
    JSON.stringify(autoRows));
  check("자동 채움 뒤에도 사람 칸만 사람 것으로 남는다(칸 보호 유지)", (await lockOf(M.link))?.mode === "cells");
  const statAfter = await sql()<{ n: number }[]>`SELECT COALESCE(max(games), 0)::int n FROM champion_stat WHERE streamer_id = ${id.b} AND champion_id = 42`;
  check("★ 파생(챔피언 통계 — 시즌별·전체 행 모두 1경기)이 같은 트랜잭션에서 다시 계산된다", statBefore[0].n === 0 && statAfter[0].n === 1, `${statBefore[0].n} → ${statAfter[0].n}`);

  console.log("\n▸ c. 값이 있는 칸과 다른 판독은 덮지 않고 불일치로 남는다");
  check("★ 1번 킬(0)은 7 로 안 바뀐다", link[0].kills === 0, JSON.stringify(link[0]));
  check("불일치가 미해결로 보인다", r.out.includes("불일치 1"), r.out.slice(-300));

  console.log("\n▸ a'. 식별 — 칸 보호 경기의 빈 사람 칸은 채우고, 사람이 정한 자리는 안 바꾼다");
  r = await merge([{ resultType: "identify", match_id: M.link, participants: [
    { participant_id: 10, streamer_slug: "cl-j" }, { participant_id: 3, streamer_slug: "cl-x" }] }]);
  check("식별 통과", r.code === 0 && r.out.includes("1명") && r.out.includes("안 바꿈 3번"), r.out.slice(-300));
  check("★ 빈 10번 자리는 연결된다", (await seat(M.link, 10)).streamer_id === id.j);
  check("★★ 사람이 연결한 3번 자리는 그대로", (await seat(M.link, 3)).streamer_id === id.c);
  check("★ 파생(조우)도 다시 계산돼 새로 연결된 사람이 조우에 들어간다",
    (await sql()<{ n: number }[]>`SELECT count(*)::int n FROM streamer_encounter
      WHERE match_id = ${M.link} AND ${id.j} IN (streamer_a_id, streamer_b_id)`)[0].n > 0);
  check("식별 채움도 actor=auto", (await changes(M.link)).some((c) => c.actor === "auto" && c.entity_key === "10" && c.field === "streamer_id"));

  console.log("\n▸ e. 같은 입력 재제출 — 추가 변경·이력 없음");
  const snap = { rows: JSON.stringify(await rows(M.link)), log: (await changes(M.link)).length, ver: (await matchRow(M.link)).review_version };
  r = await merge([scan(VOD_B, "cl_c", [200]), second(M.link, [{ streamer_slug: "cl-a", kills: 7 }])]);
  const r2 = await merge([{ resultType: "identify", match_id: M.link, participants: [
    { participant_id: 10, streamer_slug: "cl-j" }, { participant_id: 3, streamer_slug: "cl-x" }] }]);
  check("★ 재제출 통과·채움 0", r.code === 0 && r2.code === 0 && !r.out.includes("빈 칸 채움"), r.out.slice(-300));
  check("★★ 값·이력·검수 버전이 그대로", JSON.stringify(await rows(M.link)) === snap.rows
    && (await changes(M.link)).length === snap.log && (await matchRow(M.link)).review_version === snap.ver,
    JSON.stringify({ log: [snap.log, (await changes(M.link)).length], ver: [snap.ver, (await matchRow(M.link)).review_version] }));

  console.log("\n▸ b. 사람이 직접 고친 값(챔피언·킬·사람)은 자동 판독이 못 바꾼다 — 비운 칸 포함");
  const cur5 = await seat(M.human, 5), cur6 = await seat(M.human, 6), cur7 = await seat(M.human, 7);
  await ck.applyMatchReview(M.human, { participants: { patch: [
    { participant_id: 5, changes: { champion_name: "블리츠크랭크" }, expect: { champion_name: cur5.champion_name, champion_id: cur5.champion_id } },
    { participant_id: 6, changes: { kills: null }, expect: { kills: cur6.kills } },
    { participant_id: 7, changes: { streamer_id: id.x }, expect: { streamer_id: cur7.streamer_id } },
  ] } });
  r = await merge([scan(VOD_B, "cl_c", [200]), second(M.human, [
    { streamer_slug: "cl-e", champion_name: "룰루" }, { streamer_slug: "cl-f", kills: 9 }, { streamer_slug: "cl-g", kills: 6 }])]);
  check("시점 제출 통과", r.code === 0 && r.out.includes("사람이 고친 칸이라 안 채움 1"), r.out.slice(-500));
  const human = await rows(M.human);
  check("★★ 사람이 고친 챔피언(5번 블리츠크랭크)은 룰루로 안 돌아간다", human[4].champion_id === 53, JSON.stringify(human[4]));
  check("★★ 사람이 비운 킬(6번)은 비어 있어도 안 채운다", human[5].kills === null, JSON.stringify(human[5]));
  check("사람 칸 아닌 빈 챔피언(2번)은 같은 제출에서 채워진다", human[1].champion_id === 42);
  r = await merge([{ resultType: "identify", match_id: M.human, participants: [{ participant_id: 7, streamer_slug: "cl-g" }] }]);
  check("★★ 사람이 바꾼 연결(7번 → x)은 식별이 되돌리지 못한다", r.code === 0 && (await seat(M.human, 7)).streamer_id === id.x, r.out.slice(-300));

  console.log("\n▸ d. 이력으로 칸을 가릴 수 없는 과거 검수 경기는 전체 보호");
  // 0042 이전처럼 값만 바뀌고 도장만 있고 칸 기록이 없다.
  await sql()`UPDATE match_participant SET streamer_id = ${id.c} WHERE match_id = ${M.legacy} AND participant_id = 3`;
  await sql()`UPDATE match SET reviewed_at = now() WHERE match_id = ${M.legacy}`;
  const legacyBefore = JSON.stringify(await rows(M.legacy));
  r = await merge([scan(VOD_B, "cl_c", [200]), second(M.legacy)]);
  check("★★ 빈 칸도 안 채운다(값은 잠김)", r.code === 0 && r.out.includes("값은 잠김") && JSON.stringify(await rows(M.legacy)) === legacyBefore,
    r.out.slice(-300));
  r = await merge([{ resultType: "identify", match_id: M.legacy, participants: [{ participant_id: 10, streamer_slug: "cl-j" }] }]);
  check("★ 식별도 통째로 물러난다(빈 10번 자리도 그대로)", r.code === 0 && r.out.includes("전체가 보호된") && (await seat(M.legacy, 10)).streamer_id === null, r.out.slice(-300));
  check("자동 기록이 하나도 안 생긴다", (await changes(M.legacy)).length === 0);

  console.log("\n▸ 복구 조회 — 사람이 사람 연결 칸만 바꾼 검수 경기(칸 보호로 바뀌어 빈 칸을 다시 채울 수 있는 것)");
  // ★ 운영 복구 단계에 그대로 쓰는 조회다. 판정 규칙(review-lock.ts decideReviewLock)을 SQL 로 옮긴 것.
  const recoveryQuery = () => sql().unsafe(`
    WITH h AS (
      SELECT match_id, entity, field, "after", id FROM review_change
       WHERE actor = 'admin' AND match_id IS NOT NULL
    ), s AS (
      SELECT m.match_id,
             (SELECT h2."after" FROM h h2 WHERE h2.match_id = m.match_id AND h2.entity = 'match'
                AND h2.field = 'admin_protected' ORDER BY h2.id DESC LIMIT 1) AS protected_flag,
             bool_or(h.entity = 'match' AND h.field = 'created') AS admin_created,
             array_agg(DISTINCT h.field) FILTER (WHERE h.entity IN ('match', 'participant', 'series')
               AND h.field NOT IN ('admin_protected', 'created', 'review_completed')) AS cell_fields
        FROM match m JOIN h ON h.match_id = m.match_id
       WHERE m.game_code = 'lol' AND m.reviewed_at IS NOT NULL AND m.review_completed_at IS NULL
       GROUP BY m.match_id
    )
    SELECT s.match_id, s.cell_fields,
           (SELECT count(*)::int FROM match_participant mp WHERE mp.match_id = s.match_id AND mp.champion_id = 0) AS empty_champion,
           (SELECT array_agg(DISTINCT el.source_key) FROM match_pov p JOIN event_lead el ON el.id = p.lead_id
             WHERE p.match_id = s.match_id) AS pov_vods
      FROM s
     WHERE COALESCE(s.protected_flag, 'false'::jsonb) <> 'true'::jsonb AND NOT s.admin_created
       AND s.cell_fields IS NOT NULL
       AND s.cell_fields <@ ARRAY['streamer_id', 'puuid', 'observed_name']
     ORDER BY s.match_id`);
  const recovery = await recoveryQuery();
  check("★ 복구 조회는 연결만 고친 경기만 고른다(값을 고친 경기·과거 잠금 제외)",
    recovery.map((x) => x.match_id).join(",") === `${M.done},${M.link}`, JSON.stringify(recovery));

  console.log("\n▸ f. 검수 완료 경기는 빈 칸 자동 채우기도 막는다(완료는 그대로)");
  await ck.setMatchReviewCompleted(M.done, true, (await matchRow(M.done)).review_version);
  check("복구 조회는 검수 완료 경기도 뺀다", (await recoveryQuery()).map((x) => x.match_id).join(",") === M.link);
  const doneBefore = JSON.stringify(await rows(M.done));
  r = await merge([scan(VOD_B, "cl_c", [200]), second(M.done)]);
  const done = await matchRow(M.done);
  check("★★ 완료 경기의 빈 칸은 안 채우고 완료 표시도 안 풀린다",
    r.code === 0 && r.out.includes("검수 완료된 경기") && JSON.stringify(await rows(M.done)) === doneBefore && done.review_completed_at != null,
    r.out.slice(-300));
  r = await merge([scan(VOD_B, "cl_c", [200]), second(M.done, [{ streamer_slug: "cl-a", kills: 7 }])]);
  check("다른 값을 읽으면 지금처럼 완료를 풀어 재검수 대상으로 돌린다(값은 그대로)",
    r.code === 0 && (await matchRow(M.done)).review_completed_at === null && (await seat(M.done, 1)).kills === 0, r.out.slice(-300));
} finally {
  await closeDb();
  await server.stop();
  await pg.close();
  rmSync(WORK, { recursive: true, force: true });
  for (const vod of [VOD_A, VOD_B]) rmSync(join(ROOT, "out", "ck", String(vod)), { recursive: true, force: true });
}

console.log(failures === 0 ? `\n전부 통과 (${passed}건).\n` : `\n${failures}건 실패 (통과 ${passed}).\n`);
process.exit(failures === 0 ? 0 : 1);
