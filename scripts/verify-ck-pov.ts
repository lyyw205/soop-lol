/**
 * 다시점 경기 통합을 **실제 `ck:merge` 명령으로** 끝까지 돌려 본다. docs/CK-MULTI-POV-PLAN.md §11
 *
 *   npm run verify:ck:pov
 *
 * PGlite 에 마이그레이션을 전부 올리고, 가짜 VOD 사진 파일을 out/ck/ 아래 만들고, 결과 파일을
 * `node scripts/ck-merge.mjs --result` 로 넣는다. 가짜인 것은 VOD 화면(사진 파일)뿐이다 —
 * 검증·분기·저장·비교는 운영과 같은 코드가 돈다.
 */

import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { applyAll } from "./lib/migrations.ts";

import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const ROOT = join(import.meta.dirname, "..");
const PORT = Number(process.env.VERIFY_DB_PORT ?? 5437);
const WORK = join(ROOT, "out", "ck", "_verify-pov");
// 실제 VOD 번호와 겹치지 않는 가짜 번호. 사진 파일은 out/ck/<번호>/ 에 둔다(ck-merge 가 존재를 본다).
const VODS = { a: 99990101, c: 99990102, k: 99990103, b: 99990104, e: 99990105, f: 99990106, g: 99990107 };

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const pg = await PGlite.create({ extensions: { pg_trgm, pgcrypto } });
// ★ 기본 연결 수가 1 이다. 이 프로세스와 자식 ck:merge 가 같이 붙어야 한다.
//   PGlite 는 세션이 하나라 트랜잭션이 섞일 수 있는데, 자식이 도는 동안 이쪽은 기다리기만 하므로 안전하다.
const server = new PGLiteSocketServer({ db: pg, port: PORT, host: "127.0.0.1", maxConnections: 30 });
await server.start();
const DATABASE_URL = `postgres://postgres@127.0.0.1:${PORT}/postgres`;
process.env.DATABASE_URL = DATABASE_URL;

const { db: sql, closeDb } = await import("../packages/core/lib/db/client.ts");
const streamers = await import("../packages/core/lib/db/streamers.ts");
const pov = await import("../packages/core/lib/db/ck-pov.ts");
const ck = await import("../packages/core/lib/db/ck.ts");

/** out/ck/<vod>/ 에 가짜 사진과(선택) probe.json 을 만든다. */
function fakeVod(vod: number, secs: number[], probe?: { start: string; total: number }) {
  const dir = join(ROOT, "out", "ck", String(vod));
  mkdirSync(dir, { recursive: true });
  for (const s of secs) writeFileSync(join(dir, `g${String(s).padStart(7, "0")}.jpg`), "x");
  if (probe) writeFileSync(join(dir, "probe.json"), JSON.stringify({
    vod_id: vod, total_sec: probe.total, parts: [{ length: probe.total, length_measured: true }],
    broadcast: { start: probe.start, end: new Date(Date.parse(probe.start) + probe.total * 1000).toISOString() },
  }));
}
const framePath = (vod: number, s: number) => `out/ck/${vod}/g${String(s).padStart(7, "0")}.jpg`;

function scan(vod: number, channel: string, secs: number[], candidates: unknown[] = [], extra: Record<string, unknown> = {}) {
  return {
    resultType: "scan",
    lead: { source_key: `vod:${vod}`, title: `검증 VOD ${vod}`, url: `https://vod.sooplive.com/player/${vod}`,
      channel_id: channel, observed_at: "2026-09-26T15:00:00Z", ...extra },
    scan: { status: "done", requested: [[0, 7200]], sampled: [[0, 7200]], opened: secs },
    frames: secs.map((s) => ({ frame_path: framePath(vod, s), at_sec: s, kind: "result" })),
    candidates,
  };
}

let fileNo = 0;
/**
 * ★ 비동기로 돌린다. PGlite 서버가 **이 프로세스 안에서** 돌기 때문에 spawnSync 로 기다리면
 *   서버도 같이 멈춰 자식이 연결을 못 한다(CONNECT_TIMEOUT).
 */
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

const people = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"];
const views = async (matchId: string) => pov.getMatchPovViews(matchId);

try {
  console.log("\n▸ 준비");
  await applyAll((s) => pg.exec(s), ROOT);
  for (const p of people) {
    await streamers.createStreamer({ slug: `pov-${p}`, display_name: `시점${p.toUpperCase()}`, channel: { channel_id: `pov_${p}` } });
  }
  // a~e 가 1팀(100), f~j 가 2팀(200). k 는 이 경기에 없다.
  const roster = (team: 100 | 200, names: string[], offset: number) => names.map((n, i) => ({
    participant_id: offset + i, team_id: team, streamer_slug: `pov-${n}`,
    team_position: ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"][i],
    champion_name: ["가렌", "리 신", "아리", "징크스", "룰루"][i], kills: i, deaths: 1, assists: 2,
  }));
  const full = [...roster(100, ["a", "b", "c", "d", "e"], 1), ...roster(200, ["f", "g", "h", "i", "j"], 6)];
  // d 의 챔피언은 첫 시점이 못 읽었다(빈 칸) — 다른 시점이 채울 자리.
  const firstRead = full.map((p) => (p.streamer_slug === "pov-d" ? { ...p, champion_name: undefined } : p));
  check("준비 완료", true);

  console.log("\n▸ 첫 시점이 경기를 만든다");
  fakeVod(VODS.a, [3000, 3100]);
  let r = await merge([
    scan(VODS.a, "pov_a", [3000, 3100], [{ id: "c1", at: [3000, 3100], conclusion: "match", match_id: "pov:m1" }]),
    { resultType: "match", match_id: "pov:m1", winning_team: 200, played_at: "2026-09-26T13:00:00Z",
      played_at_precision: "datetime", duration: 1800, result_evidence: "결과창", participants: firstRead,
      evidence_frames: [framePath(VODS.a, 3000), framePath(VODS.a, 3100)] },
  ]);
  check("새 경기 생성", r.code === 0, r.code ? r.out : "");
  let v = await views("pov:m1");
  check("만든 시점이 시점 기록으로 남는다", v.length === 1 && v[0].role === "created" && v[0].frames.length === 2,
    JSON.stringify(v.map((x) => [x.role, x.frames.length])));

  console.log("\n▸ 두 번째 시점 — 직접 읽은 칸만, 팀 번호가 뒤집힌 화면");
  fakeVod(VODS.c, [500, 600]);
  // 이 시점은 자기 팀(경기 100)을 200 이라고 부른다. 승자도 그 이름표로 100 이 된다.
  r = await merge([
    scan(VODS.c, "pov_c", [500, 600], [{ id: "c1", at: [500, 600], conclusion: "linked", match_id: "pov:m1" }]),
    { resultType: "match", match_id: "pov:m1", winning_team: 100,
      pov: { source: "own", link_basis: "같은 10명 로비, 결과창 KDA 일치" },
      participants: [
        { streamer_slug: "pov-c", team_id: 200, champion_name: "아리", kills: 2, deaths: 1, assists: 2 },
        { streamer_slug: "pov-d", team_id: 200, champion_name: "블리츠크랭크" },
        { streamer_slug: "pov-f", team_id: 100, kills: 0 },
      ],
      evidence_frames: [framePath(VODS.c, 500), framePath(VODS.c, 600)] },
  ]);
  check("기존 경기에 시점 추가", r.code === 0 && r.out.includes("시점  pov:m1"), r.code ? r.out : "");
  v = await views("pov:m1");
  const second = v.find((x) => x.lead_source_key === `vod:${VODS.c}`);
  check("경기는 하나, 시점 둘, 사진 두 벌", v.length === 2 && second?.frames.length === 2,
    JSON.stringify(v.map((x) => [x.lead_source_key, x.frames.length])));
  check("팀 순서가 뒤집혀도 사람으로 대응해 불일치 없음",
    second?.summary.mismatch_open === 0 && second.comparison.team_map[200] === 100,
    JSON.stringify(second?.summary));
  const [dRow] = await sql()<{ champion_id: number; kills: number | null }[]>`
    SELECT champion_id, kills FROM match_participant WHERE match_id = 'pov:m1' AND participant_id = 4`;
  check("빈 챔피언 칸만 채워진다", dRow.champion_id === 53, JSON.stringify(dRow));
  check("채운 칸이 filled 에 남는다", second?.filled.length === 1 && second.filled[0].field === "champion_id",
    JSON.stringify(second?.filled));
  const [fRow] = await sql()<{ kills: number }[]>`SELECT kills FROM match_participant WHERE match_id = 'pov:m1' AND participant_id = 6`;
  check("0킬은 읽은 값으로 비교된다(경기 값 0 과 일치)", fRow.kills === 0
    && second?.comparison.items.some((i) => i.field === "kills" && i.observed === 0 && i.status === "agree") === true);

  console.log("\n▸ 부분 재제출 — 보낸 칸만 바뀌고 이력이 남는다");
  r = await merge([
    scan(VODS.c, "pov_c", [500, 600]),
    { resultType: "match", match_id: "pov:m1", pov: { link_basis: "재확인" },
      participants: [{ streamer_slug: "pov-c", kills: 5 }] },
  ]);
  check("재제출 통과", r.code === 0, r.code ? r.out : "");
  v = await views("pov:m1");
  const c2 = v.find((x) => x.lead_source_key === `vod:${VODS.c}`)!;
  const cObs = c2.observed.participants![Object.keys(c2.observed.participants!).find((k) => c2.observed.participants![k].ident.streamer_id)!];
  check("챔피언 관측은 유지된다", Object.values(c2.observed.participants!).some((p) => p.champion_id?.v === 103), JSON.stringify(cObs));
  check("다른 킬 수는 덮지 않고 미해결 불일치", c2.summary.mismatch_open === 1, JSON.stringify(c2.summary));
  check("바뀐 관측이 이력에 남는다", c2.history.some((h) => h.field === "kills" && h.before === 2 && h.after === 5),
    JSON.stringify(c2.history));
  const [cRow] = await sql()<{ kills: number }[]>`SELECT kills FROM match_participant WHERE match_id = 'pov:m1' AND participant_id = 3`;
  check("경기 값은 그대로", cRow.kills === 2);

  console.log("\n▸ 검수 완료 — 불일치는 남되 '검수 완료' 로 구분");
  // 사람이 검수 완료를 누른 시각은 항상 과거다. 미래 시각을 넣으면 뒤따르는 제출이 "이미 본 것" 으로 잘못 분류된다.
  await sql()`UPDATE match SET review_completed_at = now() WHERE match_id = 'pov:m1'`;
  v = await views("pov:m1");
  const c3 = v.find((x) => x.lead_source_key === `vod:${VODS.c}`)!;
  check("미해결 0 · 검수 완료 1", c3.summary.mismatch_open === 0 && c3.summary.mismatch_reviewed === 1, JSON.stringify(c3.summary));

  console.log("\n▸ 검수 완료 뒤 새 시점이 다른 값을 가져오면 다시 검수 대상");
  fakeVod(VODS.g, [800]);
  r = await merge([
    scan(VODS.g, "pov_g", [800]),
    { resultType: "match", match_id: "pov:m1", pov: { link_basis: "결과창" },
      participants: [{ streamer_slug: "pov-h", kills: 9 }], evidence_frames: [framePath(VODS.g, 800)] },
  ]);
  const [reopen] = await sql()<{ review_completed_at: Date | null }[]>`SELECT review_completed_at FROM match WHERE match_id = 'pov:m1'`;
  check("검수 완료가 풀려 미검수 목록에 다시 뜬다", r.code === 0 && reopen.review_completed_at === null && r.out.includes("검수 완료를 풀었다"),
    r.code ? r.out : JSON.stringify(reopen));

  // 사람이 다시 확인하고 완료하면, 그 불일치는 "검수 완료" 로 정리된다(기존 완료 함수 그대로).
  const [ver] = await sql()<{ review_version: number }[]>`SELECT review_version FROM match WHERE match_id = 'pov:m1'`;
  await ck.setMatchReviewCompleted("pov:m1", true, ver.review_version);
  const gView = (await views("pov:m1")).find((x) => x.lead_source_key === `vod:${VODS.g}`);
  check("다시 완료하면 새 불일치도 '검수 완료' 로 정리된다",
    gView?.summary.mismatch_open === 0 && gView.summary.mismatch_reviewed === 1, JSON.stringify(gView?.summary));
  await sql()`UPDATE match SET reviewed_at = NULL WHERE match_id = 'pov:m1'`; // 완료가 건 값 보호는 뒤 사례를 위해 되돌린다

  console.log("\n▸ 잘못 읽은 승자·팀 철회(null)");
  r = await merge([
    scan(VODS.c, "pov_c", [500, 600]),
    { resultType: "match", match_id: "pov:m1", winning_team: null, pov: { link_basis: "승자 오독 철회" },
      participants: [{ streamer_slug: "pov-d", team_id: null }] },
  ]);
  v = await views("pov:m1");
  const c4 = v.find((x) => x.lead_source_key === `vod:${VODS.c}`)!;
  const dObs = Object.values(c4.observed.participants!).find((p) => p.ident.streamer_id && p.champion_id?.v === 53);
  check("기존 경기에 null 은 철회로 받는다", r.code === 0 && c4.observed.match?.winning_team === undefined && dObs?.team === undefined,
    r.code ? r.out.slice(-300) : JSON.stringify(c4.observed.match));
  check("철회도 이력에 남는다", c4.history.some((h) => h.field === "winning_team" && h.after === null));

  console.log("\n▸ 거부해야 하는 것");
  r = await merge([scan(VODS.c, "pov_c", [500, 600], [{ id: "c9", at: [500, 600], conclusion: "linked", match_id: "pov:m1" }])]);
  check("linked 만 적고 시점 제출이 없으면 거부", r.code !== 0 && r.out.includes("match 제출이 없다"), r.out.slice(-300));
  fakeVod(VODS.k, [100]);
  r = await merge([
    scan(VODS.k, "pov_k", [100]),
    { resultType: "match", match_id: "pov:m1", pov: { source: "own", link_basis: "같은 판" },
      participants: [{ streamer_slug: "pov-a", kills: 0 }], evidence_frames: [framePath(VODS.k, 100)] },
  ]);
  check("본인 화면인데 방송 주인이 참가자에 없으면 거부", r.code !== 0 && r.out.includes("방송 주인이 이 경기 참가자에 없다"), r.out.slice(-300));
  r = await merge([
    scan(VODS.k, "pov_k", [100]),
    { resultType: "match", match_id: "pov:m1", participants: [{ streamer_slug: "pov-a", kills: 0 }] },
  ]);
  check("기존 경기에 근거(link_basis) 없이 내면 거부", r.code !== 0 && r.out.includes("link_basis"), r.out.slice(-300));

  console.log("\n▸ 재송출 — 방송 주인 조건·시각 검사 면제, 근거는 필요");
  r = await merge([
    scan(VODS.k, "pov_k", [100]),
    { resultType: "match", match_id: "pov:m1", pov: { source: "rebroadcast", link_basis: "c 방송을 띄운 화면, 결과창 동일" },
      participants: [{ streamer_slug: "pov-a", kills: 0 }], evidence_frames: [framePath(VODS.k, 100)] },
  ]);
  check("재송출 시점 추가", r.code === 0, r.code ? r.out : "");
  v = await views("pov:m1");
  check("재송출은 source 로 구분된다", v.some((x) => x.lead_source_key === `vod:${VODS.k}` && x.source === "rebroadcast"));

  console.log("\n▸ 시각 모순 — 대응할 수 있을 때만 검사한다");
  // 방송 12:00 시작. 경기는 13:00~13:30. 사진 5000초 = 13:23(정상), 14000초 = 15:53(두 시간 넘게 뒤).
  fakeVod(VODS.b, [5000, 14000], { start: "2026-09-26T12:00:00Z", total: 20000 });
  const bScan = scan(VODS.b, "pov_b", [5000, 14000], [], { vod_started_at: "2026-09-26T12:00:00Z" });
  r = await merge([bScan, { resultType: "match", match_id: "pov:m1", pov: { link_basis: "로비" },
    participants: [{ streamer_slug: "pov-b", kills: 1 }], evidence_frames: [framePath(VODS.b, 14000)] }]);
  check("시각이 명백히 떨어지면 거부", r.code !== 0 && r.out.includes("명백히 떨어져"), r.out.slice(-300));
  r = await merge([bScan, { resultType: "match", match_id: "pov:m1", pov: { link_basis: "결과창" },
    participants: [{ streamer_slug: "pov-b", kills: 1 }], evidence_frames: [framePath(VODS.b, 5000)] }]);
  check("경기 뒤 결과창(±30분 안)은 통과", r.code === 0, r.code ? r.out : "");
  r = await merge([bScan, { resultType: "match", match_id: "pov:m1", pov: { link_basis: "VOD 가 중간에 끊김", time_reliable: false },
    participants: [{ streamer_slug: "pov-b", kills: 1 }], evidence_frames: [framePath(VODS.b, 14000)] }]);
  check("시간축을 믿을 수 없다고 하면 시각 검사 없이 근거로 판단", r.code === 0, r.code ? r.out : "");

  console.log("\n▸ 검수된 경기 — 값은 잠기고 시점·사진은 붙는다");
  await sql()`UPDATE match SET reviewed_at = now() WHERE match_id = 'pov:m1'`;
  await sql()`UPDATE match_participant SET assists = NULL WHERE match_id = 'pov:m1' AND participant_id = 7`;
  fakeVod(VODS.e, [700]);
  r = await merge([
    scan(VODS.e, "pov_e", [700]),
    { resultType: "match", match_id: "pov:m1", pov: { link_basis: "결과창" },
      participants: [{ streamer_slug: "pov-g", assists: 9 }], evidence_frames: [framePath(VODS.e, 700)] },
  ]);
  check("검수된 경기에도 시점 추가", r.code === 0 && r.out.includes("값은 잠김"), r.code ? r.out : r.out.slice(-200));
  const [gRow] = await sql()<{ assists: number | null }[]>`SELECT assists FROM match_participant WHERE match_id = 'pov:m1' AND participant_id = 7`;
  v = await views("pov:m1");
  const eView = v.find((x) => x.lead_source_key === `vod:${VODS.e}`);
  check("빈 칸도 채우지 않고 filled 도 비어 있다", gRow.assists === null && eView?.filled.length === 0, JSON.stringify(eView?.filled));
  check("사진은 붙는다", eView?.frames.length === 1);

  console.log("\n▸ 사람이 떼어 낸 사진은 되돌리지 않는다");
  await sql()`UPDATE match_evidence_frame SET match_id = NULL, reviewed_at = now() WHERE frame_path = ${framePath(VODS.e, 700)}`;
  r = await merge([
    scan(VODS.e, "pov_e", [700]),
    { resultType: "match", match_id: "pov:m1", pov: { link_basis: "결과창" },
      participants: [{ streamer_slug: "pov-g", assists: 9 }], evidence_frames: [framePath(VODS.e, 700)] },
  ]);
  const [eFrame] = await sql()<{ match_id: string | null }[]>`SELECT match_id FROM match_evidence_frame WHERE frame_path = ${framePath(VODS.e, 700)}`;
  check("재제출해도 떼어 낸 사진은 그대로", r.code === 0 && eFrame.match_id === null, JSON.stringify(eFrame));

  console.log("\n▸ 만든 시점이 혼자일 때만 고칠 수 있다");
  fakeVod(VODS.f, [100, 200]);
  const m2 = (winner: 100 | 200) => ({ resultType: "match", match_id: "pov:m2", winning_team: winner,
    played_at: "2026-09-26T14:00:00Z", played_at_precision: "date", result_evidence: "결과창",
    participants: full, evidence_frames: [framePath(VODS.f, 100)] });
  await merge([scan(VODS.f, "pov_f", [100, 200]), m2(100)]);
  r = await merge([scan(VODS.f, "pov_f", [100, 200]), { ...m2(200), pov: { link_basis: "세트 결과 재확인" } }]);
  let [m2Row] = await sql()<{ winning_team: number }[]>`SELECT winning_team FROM match WHERE match_id = 'pov:m2'`;
  check("혼자면 덮어쓰기 허용", r.code === 0 && m2Row.winning_team === 200, r.code ? r.out : "");
  r = await merge([scan(VODS.a, "pov_a", [3000, 3100]), { resultType: "match", match_id: "pov:m2", pov: { link_basis: "같은 10명" },
    participants: [{ streamer_slug: "pov-a", kills: 0 }] }]);
  r = await merge([scan(VODS.f, "pov_f", [100, 200]), { ...m2(100), pov: { link_basis: "다시 뒤집음" } }]);
  [m2Row] = await sql()<{ winning_team: number }[]>`SELECT winning_team FROM match WHERE match_id = 'pov:m2'`;
  check("다른 시점이 붙은 뒤에는 덮어쓰지 않는다", r.code === 0 && m2Row.winning_team === 200, r.code ? r.out : "");

  console.log("\n▸ 예전 경기에 처음 붙은 추가 시점은 혼자여도 덮어쓰지 못한다");
  await merge([scan(VODS.f, "pov_f", [100, 200]), { ...m2(100), match_id: "pov:m3" }]);
  await sql()`DELETE FROM match_pov WHERE match_id = 'pov:m3'`; // 시점 기록 이전의 경기처럼 만든다
  r = await merge([scan(VODS.c, "pov_c", [500, 600]), { ...m2(100), match_id: "pov:m3",
    evidence_frames: [framePath(VODS.c, 500)], pov: { link_basis: "같은 판" } }]);
  const c3role = (await views("pov:m3")).map((x) => x.role);
  r = await merge([scan(VODS.c, "pov_c", [500, 600]), { ...m2(200), match_id: "pov:m3",
    evidence_frames: [framePath(VODS.c, 500)], pov: { link_basis: "다시 냄" } }]);
  const [m3Row] = await sql()<{ winning_team: number }[]>`SELECT winning_team FROM match WHERE match_id = 'pov:m3'`;
  check("추가 시점(added)은 필수 정보를 다 채워도 원본을 덮지 못한다",
    JSON.stringify(c3role) === '["added"]' && r.code === 0 && m3Row.winning_team === 100,
    JSON.stringify({ c3role, win: m3Row.winning_team, out: r.code ? r.out.slice(-200) : "" }));

  console.log("\n▸ FC 단서는 같은 VOD 주소여도 롤 경기에 안 이어진다");
  await sql()`INSERT INTO event_lead (source, source_key, url, title, observed_at)
              VALUES ('manual', ${`fc:${VODS.a}:1`}, ${`https://vod.sooplive.com/player/${VODS.a}`}, 'FC 단서', now())`;
  await sql()`UPDATE match SET source_url = ${`https://vod.sooplive.com/player/${VODS.a}`} WHERE match_id = 'pov:m1'`;
  const fcLinks = await sql()<{ n: number }[]>`
    SELECT count(*)::int AS n FROM lead_match lm JOIN event_lead el ON el.id = lm.lead_id WHERE el.source_key LIKE 'fc:%'`;
  check("lead_match 에 FC 단서가 없다", fcLinks[0].n === 0, JSON.stringify(fcLinks));
} finally {
  await closeDb();
  await server.stop();
  await pg.close();
  rmSync(WORK, { recursive: true, force: true });
  for (const vod of Object.values(VODS)) rmSync(join(ROOT, "out", "ck", String(vod)), { recursive: true, force: true });
}

console.log(failures === 0 ? "\n전부 통과.\n" : `\n${failures}건 실패.\n`);
process.exit(failures === 0 ? 0 : 1);
