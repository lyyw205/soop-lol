import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { execFileSync, spawn } from "node:child_process";
import { acknowledge, before, config, configure, context, hash, loadPacket, packet, ranges, readPage, reviewed, save, scanListen, status } from "./core.mjs";
import { prepare } from "./prepare.mjs";

export function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "ck-listen-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  save(join(root, "out/ck/777/probe.json"), { vod_id: 777, total_sec: 7200, parts: [{ index: 1, offset_sec: 0, length_sec: 7200, length_measured: true }] });
  save(join(root, ".local/asr/sensevoice.model.json"), { repo: "test", revision: "r1", path: "/fake" });
  for (const path of ["scripts/asr/runtime.py", "scripts/ck-listen/worker.py"]) { mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), "test-v1"); }
  return root;
}
export function seed(root: string, entries: { at: number; end: number; text: string }[]) {
  const ctx = context(root, 777);
  ctx.data.chunks = entries.map((c) => ({ ...c, audio_sha256: "abc", id: hash({ ...c, audio: "abc" }) }));
  save(ctx.file, ctx.data); return ctx;
}

test("첫 경기 기본은 정확히 30분, 다음 판은 종료~시작; 잘못된 범위는 거부", () => {
  assert.deepEqual(before(6219), [[4419, 6219]]);
  assert.deepEqual(before(600), [[0, 600]]);
  assert.deepEqual(before(6219, 6000), [[6000, 6219]]);
  assert.throws(() => before(600, 700)); assert.throws(() => before(NaN)); assert.throws(() => ranges("1:"));
  assert.deepEqual(ranges("0:30,20:50"), [[0, 50]]);
});

test("겹친 창은 청크를 한 번만, 문장·조건부 답변·동일 발언의 다른 시각은 보존", (t) => {
  const root = fixture(t);
  const ctx = seed(root, [{ at: 0, end: 30, text: "  랜드? 아니 그건 다음 판  " }, { at: 30, end: 60, text: "  랜드? 아니 그건 다음 판  " }]);
  const p = packet(ctx, [[10, 40], [20, 50]]);
  assert.deepEqual(p.requested, [[10, 50]]); assert.deepEqual(p.delivered_ranges, [[0, 60]]);
  const output = readPage(ctx, p, 1);
  assert.equal(output.chunks.length, 2); assert.equal(output.chunks[0].text, ctx.data.chunks[0].text);
  assert.throws(() => reviewed(ctx, [p.id]), /ack/);
  assert.deepEqual(acknowledge(ctx, [p.id]).transcript_read, [[0, 60]]);
});

test("전사·출력·열람은 분리하고 모든 페이지 출력 전 ack 거부", (t) => {
  const ctx = seed(fixture(t), Array.from({ length: 5 }, (_, i) => ({ at: i * 30, end: (i + 1) * 30, text: `청크 ${i}` })));
  const p = packet(ctx, [[0, 150]], 110);
  assert.equal(p.pages.length, 5);
  readPage(ctx, p, 1); assert.throws(() => acknowledge(ctx, [p.id]), /미출력/);
  for (let page = 2; page <= 5; page++) readPage(ctx, p, page);
  assert.deepEqual(acknowledge(ctx, [p.id]).transcript_read, [[0, 150]]);
  assert.equal(status(ctx).packets[0].emitted_pages.length, 5);
});

test("부분 전사·무음과 누락을 구분하고 읽지 못한 범위를 열람 기록에 넣지 않음", (t) => {
  const ctx = seed(fixture(t), [{ at: 30, end: 60, text: "" }]);
  const p = packet(ctx, [[0, 90]]); readPage(ctx, p, 1);
  assert.deepEqual(p.missing, [[0, 30], [60, 90]]);
  assert.deepEqual(acknowledge(ctx, [p.id]).transcript_read, [[30, 60]]);
});

test("모델·축 변경과 원문 위조는 이전 열람 재사용을 거부", (t) => {
  const root = fixture(t); const ctx = seed(root, [{ at: 0, end: 30, text: "원문" }]);
  const p = packet(ctx, [[0, 30]]); readPage(ctx, p, 1); acknowledge(ctx, [p.id]);
  ctx.data.chunks[0].text = "변조"; save(ctx.file, ctx.data);
  assert.throws(() => context(root, 777), /손상/);
  save(join(root, ".local/asr/sensevoice.model.json"), { repo: "test", revision: "r2", path: "/fake" });
  const next = context(root, 777); assert.notEqual(next.version, ctx.version);
  assert.throws(() => loadPacket(next, p.id), /버전/);
  assert.throws(() => loadPacket(next, "../bad"), /잘못된/);
  const probe = JSON.parse(readFileSync(join(root, "out/ck/777/probe.json"), "utf8"));
  probe.parts[0].length_measured = false; save(join(root, "out/ck/777/probe.json"), probe);
  assert.throws(() => context(root, 777), /HLS/);
});

test("기본 off, VOD별 적용 격리, 전체 off로 모두 해제", (t) => {
  const root = fixture(t); assert.equal(config(root, 777).active, false);
  configure(root, true, 777); assert.equal(config(root, 777).active, true); assert.equal(config(root, 888).active, false);
  configure(root, false); assert.equal(config(root, 777).active, false);
  configure(root, true); assert.equal(config(root, 888).active, true);
  assert.throws(() => configure(root, false, 777), /전체 적용/);
  configure(root, false); assert.deepEqual(config(root, 777).vods, []);
});

test("완료 캐시는 WAV·모델 실행파일·네트워크 없이 재사용, off 자동 준비는 시간축 없이도 skip", async (t) => {
  const root = fixture(t); seed(root, [{ at: 0, end: 30, text: "캐시" }]);
  const source = { vodDetail: async () => { throw new Error("네트워크 호출 금지"); }, hlsSegments: async () => { throw new Error("네트워크 호출 금지"); }, segmentsSpan: async () => null };
  const result = await prepare(root, "777", [[0, 30]], { source });
  assert.equal(result.reused, true);
  assert.equal((await prepare(root, "888", undefined, { ifEnabled: true, source })).skipped, "disabled");
});

test("실제 ffmpeg + 가짜 ASR: 저장 후 임시파일 제거, 실패 범위 보존, 재개는 누락만 처리", async (t) => {
  const root = fixture(t);
  mkdirSync(join(root, ".local/asr/sensevoice/bin"), { recursive: true });
  writeFileSync(join(root, "scripts/asr/env.sh"), '#!/bin/bash\nexec "$@"\n');
  writeFileSync(join(root, ".local/asr/sensevoice/bin/python"), `#!${process.execPath}\nconst rl=require('node:readline').createInterface({input:process.stdin}); console.log(JSON.stringify({ready:true})); rl.on('line',line=>{const r=JSON.parse(line);const chunks=[];for(let at=r.at;at<r.at+r.seconds;at+=30)chunks.push({at,end:Math.min(at+30,r.at+r.seconds),text:'테스트 원문'});console.log(JSON.stringify({chunks}));});\n`, { mode: 0o755 });
  const audio = Buffer.alloc(44 + 16000 * 2 * 60);
  audio.write("RIFF"); audio.writeUInt32LE(audio.length - 8, 4); audio.write("WAVEfmt ", 8); audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22); audio.writeUInt32LE(16000, 24); audio.writeUInt32LE(32000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write("data", 36); audio.writeUInt32LE(audio.length - 44, 40);
  let broken = true; const called: number[] = [];
  const source = { vodDetail: async () => ({ files: [{}] }), hlsSegments: async () => ({ segs: [{ start: 0, dur: 7200, uri: "fixture" }], dir: "fixture", init: null, audioOnly: true }),
    segmentsSpan: async (_h: unknown, at: number) => { called.push(at); return { data: broken ? Buffer.from("bad audio") : audio, offset: 0, bytes: audio.length, segments: 1 }; } };
  const failed = await prepare(root, "777", [[0, 60]], { source });
  assert.deepEqual(failed.requested_missing, [[0, 60]]); assert.equal(failed.failures.length, 1);
  assert.equal(existsSync(join(root, ".local/asr/runs/listen-777/piece.src")), false);
  assert.equal(existsSync(join(root, ".local/asr/runs/listen-777/piece.wav")), false);
  broken = false;
  const ok = await prepare(root, "777", [[0, 60]], { source });
  assert.deepEqual(ok.requested_missing, []); assert.equal(ok.chunks, 2);
  assert.equal(existsSync(join(root, ".local/asr/runs/listen-777/piece.wav")), false);
  await prepare(root, "777", [[0, 60]], { source }); assert.deepEqual(called, [0, 0]);
  assert.equal(context(root, 777).data.pieces[0].source_sha256, hash(audio));
});

function fakeAsr(root: string) {
  mkdirSync(join(root, ".local/asr/sensevoice/bin"), { recursive: true });
  writeFileSync(join(root, "scripts/asr/env.sh"), '#!/bin/bash\nexec "$@"\n');
  // 받은 WAV 길이를 그대로 돌려준다 — 덧붙인 무음이 실제 파일에 들어갔는지까지 확인한다.
  writeFileSync(join(root, ".local/asr/sensevoice/bin/python"), `#!${process.execPath}\nconst fs=require('node:fs');const rl=require('node:readline').createInterface({input:process.stdin}); console.log(JSON.stringify({ready:true})); rl.on('line',line=>{const r=JSON.parse(line);const sec=(fs.statSync(r.wav).size-44)/32000;if(Math.abs(sec-r.seconds)>0.25){console.log(JSON.stringify({error:'Truncated audio'}));return;}const chunks=[];for(let at=r.at;at<r.at+r.seconds;at+=30)chunks.push({at,end:Math.min(at+30,r.at+r.seconds),text:'원문 '+at});console.log(JSON.stringify({chunks}));});\n`, { mode: 0o755 });
}
function wavBuffer(seconds: number) {
  const audio = Buffer.alloc(44 + Math.round(16000 * seconds) * 2);
  audio.write("RIFF"); audio.writeUInt32LE(audio.length - 8, 4); audio.write("WAVEfmt ", 8); audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22); audio.writeUInt32LE(16000, 24); audio.writeUInt32LE(32000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write("data", 36); audio.writeUInt32LE(audio.length - 44, 40);
  return audio;
}
const hlsFixture = async () => ({ segs: [{ start: 0, dur: 7200, uri: "fixture" }], dir: "fixture", init: null, audioOnly: true });

test("조각 경계의 반올림 틈(0.05초 미만)은 누락이 아니다 — 다시 받지 않고 상태에도 안 나온다", async (t) => {
  const root = fixture(t);
  seed(root, [{ at: 0, end: 299.993, text: "앞" }, { at: 300, end: 600, text: "뒤" }]);
  let contacted = false;
  const source = { vodDetail: async () => { contacted = true; return { files: [{}] }; }, hlsSegments: hlsFixture, segmentsSpan: async () => null };
  const r = await prepare(root, "777", [[0, 600]], { source });
  assert.equal(r.reused, true); assert.equal(contacted, false);
  assert.deepEqual(status(context(root, 777)).missing, [[600, 7200]]);
});

test("VOD 끝 소리가 1초 미만 짧으면 무음으로 채워 그 조각을 살리고, 1초 넘게 짧으면 그 조각만 실패", async (t) => {
  const root = fixture(t); fakeAsr(root);
  const source = { vodDetail: async () => ({ files: [{}] }), hlsSegments: hlsFixture,
    segmentsSpan: async (_h: unknown, at: number) => { const audio = wavBuffer(at < 100 ? 59.3 : 58); return { data: audio, offset: 0, bytes: audio.length, segments: 1 }; } };
  const tail = await prepare(root, "777", [[0, 60]], { source });
  assert.deepEqual(tail.requested_missing, []);
  const piece = context(root, 777).data.pieces[0];
  assert.ok(Math.abs(piece.padded_seconds - 0.7) < 0.01, `채운 무음 ${piece.padded_seconds}초가 조각에 남는다`);
  const gap = await prepare(root, "777", [[100, 160]], { source });
  assert.deepEqual(gap.requested_missing, [[100, 160]]);
  assert.match(gap.failures.at(-1).detail, /2\.00초 짧다/);
  assert.equal(existsSync(join(root, ".local/asr/runs/listen-777/piece.pad.wav")), false);
});

test("ASR 이 뜬 뒤 조각 하나가 실패해도 나머지 조각은 계속, 분할 파일 하나를 못 열어도 다음 파일은 전사", async (t) => {
  const root = fixture(t); fakeAsr(root);
  const called: number[] = [];
  const source = { vodDetail: async () => ({ files: [{}] }), hlsSegments: hlsFixture,
    segmentsSpan: async (_h: unknown, at: number) => { called.push(at); const audio = at === 300 ? Buffer.from("bad audio") : wavBuffer(300); return { data: audio, offset: 0, bytes: audio.length, segments: 1 }; } };
  const r = await prepare(root, "777", [[0, 900]], { source });
  assert.deepEqual(called, [0, 300, 600]);
  assert.deepEqual(r.requested_missing, [[300, 600]]);
  assert.deepEqual(r.coverage, [[0, 300], [600, 900]]);
  assert.equal(r.session.failed_pieces, 1);

  // 두 파일짜리 VOD — 1번 파일을 못 열어도 2번 파일은 전사한다.
  save(join(root, "out/ck/778/probe.json"), { vod_id: 778, total_sec: 1200, parts: [{ index: 1, offset_sec: 0, length_sec: 600, length_measured: true }, { index: 2, offset_sec: 600, length_sec: 600, length_measured: true }] });
  let opened = 0;
  const split = { vodDetail: async () => ({ files: [{ n: 1 }, { n: 2 }] }),
    hlsSegments: async (file: { n: number }) => { opened++; if (file.n === 1) throw new Error("구독자 전용"); return { segs: [{ start: 0, dur: 600, uri: "fixture" }], dir: "fixture", init: null, audioOnly: true }; },
    segmentsSpan: async () => { const audio = wavBuffer(300); return { data: audio, offset: 0, bytes: audio.length, segments: 1 }; } };
  const s2 = await prepare(root, "778", undefined, { source: split });
  assert.equal(opened, 2, "못 연 파일은 조각마다 다시 열지 않는다");
  assert.deepEqual(s2.coverage, [[600, 1200]]);
  assert.deepEqual(s2.requested_missing, [[0, 600]]);
  assert.equal(s2.failures.length, 2);
});

test("영상 서버가 차단 의심 응답(429)이면 즉시 멈추고 1시간 쉬며, 그 뒤엔 기본 간격 700ms 로만 받는다", async (t) => {
  const root = fixture(t); fakeAsr(root);
  const called: number[] = [];
  const blocked = { vodDetail: async () => ({ files: [{}] }), hlsSegments: hlsFixture,
    segmentsSpan: async (_h: unknown, at: number) => { called.push(at); throw new Error("HLS 세그먼트 HTTP 429"); } };
  await assert.rejects(prepare(root, "777", [[0, 900]], { source: blocked }), /HTTP 429/);
  assert.deepEqual(called, [0], "남은 조각을 이어 받지 않는다");
  const marker = join(root, ".local/ck-listen/hls-block.json");
  assert.equal(JSON.parse(readFileSync(marker, "utf8")).status, 429);
  let contacted = false;
  const any = { vodDetail: async () => { contacted = true; return { files: [{}] }; }, hlsSegments: hlsFixture,
    segmentsSpan: async () => { const audio = wavBuffer(300); return { data: audio, offset: 0, bytes: audio.length, segments: 1 }; } };
  await assert.rejects(prepare(root, "777", [[0, 300]], { source: any }), /차단 의심.*분 남음/);
  assert.equal(contacted, false, "대기 중에는 SOOP 에 닿지 않는다");
  save(marker, { ...JSON.parse(readFileSync(marker, "utf8")), at: new Date(Date.now() - 3601_000).toISOString() });
  const saved = [process.env.SOOP_HLS_INTERVAL_MS, process.env.CK_LISTEN_HLS_INTERVAL_MS]; process.env.CK_LISTEN_HLS_INTERVAL_MS = "300";
  t.after(() => { for (const [k, v] of [["SOOP_HLS_INTERVAL_MS", saved[0]], ["CK_LISTEN_HLS_INTERVAL_MS", saved[1]]] as const) { if (v == null) delete process.env[k]; else process.env[k] = v; } });
  const after = await prepare(root, "777", [[0, 300]], { source: any });
  assert.deepEqual(after.requested_missing, []);
  assert.equal(after.session.hls_interval_ms, 700, "시험 간격(300)을 무시하고 기본 간격으로 받는다");
});

test("조각이 연속 3번 실패하면 남은 조각을 받지 않고 멈춘다(네트워크 장애에 헛돌지 않는다)", async (t) => {
  const root = fixture(t); fakeAsr(root);
  const called: number[] = [];
  const source = { vodDetail: async () => ({ files: [{}] }), hlsSegments: hlsFixture, segmentsSpan: async (_h: unknown, at: number) => { called.push(at); return null; } };
  await assert.rejects(prepare(root, "777", [[0, 1500]], { source }), /HLS 세그먼트 없음/);
  assert.deepEqual(called, [0, 300, 600]);
  assert.equal(context(root, 777).data.sessions.at(-1).failed_pieces, 3);
});

test("다른 ASR 준비가 잠금을 소유하면 네트워크 전에 중단", async (t) => {
  const root = fixture(t); mkdirSync(join(root, ".local/ck-listen"), { recursive: true });
  const owner = spawn("flock", [join(root, ".local/ck-listen/prepare.lock"), process.execPath, "-e", "console.log('locked');setTimeout(()=>{},10000)"], { detached: true });
  t.after(() => { try { process.kill(-owner.pid!, "SIGKILL"); } catch {} });
  await new Promise<void>((resolve, reject) => { owner.stdout.once("data", () => resolve()); owner.once("error", reject); });
  let contacted = false;
  const source = { vodDetail: async () => { contacted = true; throw new Error("네트워크 금지"); }, hlsSegments: async () => { throw new Error("네트워크 금지"); }, segmentsSpan: async () => null };
  await assert.rejects(prepare(root, "777", [[0, 30]], { source, lockWaitSeconds: 0.5 }), /GPU 잠금 — \d+초 기다림/);
  assert.equal(contacted, false);
});

test("잠금이 비면 기다리던 준비가 이어서 진행한다(바로 포기하지 않는다)", async (t) => {
  const root = fixture(t); mkdirSync(join(root, ".local/ck-listen"), { recursive: true });
  const owner = spawn("flock", [join(root, ".local/ck-listen/prepare.lock"), process.execPath, "-e", "console.log('locked');setTimeout(()=>{},1200)"], { detached: true });
  t.after(() => { try { process.kill(-owner.pid!, "SIGKILL"); } catch {} });
  await new Promise<void>((resolve, reject) => { owner.stdout.once("data", () => resolve()); owner.once("error", reject); });
  const started = Date.now();
  const source = { vodDetail: async () => { throw new Error("잠금 얻은 뒤 진입"); }, hlsSegments: async () => { throw new Error("unused"); }, segmentsSpan: async () => null };
  await assert.rejects(prepare(root, "777", [[0, 30]], { source, lockWaitSeconds: 10 }), /잠금 얻은 뒤 진입/);
  assert.ok(Date.now() - started >= 800, "앞 준비가 끝날 때까지 기다렸다");
  assert.ok(context(root, 777).data.sessions.at(-1).lock_wait_seconds >= 1);
});

test("차례를 기다리는 중 SIGTERM이면 기다림을 끝내고 바로 종료(60분을 붙잡지 않는다)", async (t) => {
  const root = fixture(t); mkdirSync(join(root, ".local/ck-listen"), { recursive: true });
  const owner = spawn("flock", [join(root, ".local/ck-listen/prepare.lock"), process.execPath, "-e", "console.log('locked');setTimeout(()=>{},30000)"], { detached: true });
  t.after(() => { try { process.kill(-owner.pid!, "SIGKILL"); } catch {} });
  await new Promise<void>((resolve, reject) => { owner.stdout.once("data", () => resolve()); owner.once("error", reject); });
  const script = join(root, "wait.mjs");
  writeFileSync(script, `import {prepare} from ${JSON.stringify(new URL("./prepare.mjs", import.meta.url).href)};
try{await prepare(${JSON.stringify(root)},'777',[[0,30]],{lockWaitSeconds:3600});process.exit(9)}catch(e){console.log(e.message);process.exit(130)};`);
  const child = spawn(process.execPath, [script]);
  t.after(() => child.kill("SIGKILL"));
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  const exited = new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
  await new Promise<void>((resolve) => child.stderr.once("data", () => resolve())); // "기다린다" 안내가 나오면 대기 중이다
  const sent = Date.now(); child.kill("SIGTERM");
  assert.equal(await exited, 130);
  assert.ok(Date.now() - sent < 5000);
  assert.match(out, /차례 대기 중/);
});

test("finish는 ack된 범위만 병합하고 기존 경기값을 보존; 미열람 ID는 저장 전 거부", (t) => {
  const root = fixture(t); const ctx = seed(root, [{ at: 0, end: 30, text: "다음 판 랜드?" }]);
  const p = packet(ctx, [[0, 60]]); readPage(ctx, p, 1);
  const dir = join(root, "out/ck/777/local");
  save(join(dir, "scan.json"), { run_id: "R1", total_sec: 7200, map: [] });
  save(join(dir, "scan-draft.json"), { resultType: "scan", scan: { note: "화면 판독", transcript_read: [], signals: ["frame"], failed: [] }, frames: [], candidates: [] });
  const result = { resultType: "match", winner: "red", players: [{ name: "화면에서 읽은 이름", kills: 5, deaths: 3, assists: 4 }] };
  save(join(dir, "games.json"), { results: [result] });
  writeFileSync(join(root, "out/ck/777/g0000100.jpg"), "test");
  const args = [join(import.meta.dirname, "../ck-local/scan.mjs"), "--finish", "--vod", "777", "--run", "R1", "--opened", "100", "--games", join(dir, "games.json"), "--listen-read", p.id];
  assert.throws(() => execFileSync(process.execPath, args, { cwd: root, stdio: "pipe" }), /ack/);
  assert.equal(existsSync(join(dir, "final.json")), false);
  acknowledge(ctx, [p.id]);
  configure(root, true, 777); packet(ctx, [[60, 90]]);
  const output = execFileSync(process.execPath, args, { cwd: root, encoding: "utf8" });
  assert.match(output, /미열람 패킷 1개/); // Warning, not a classification/storage gate.
  const final = JSON.parse(readFileSync(join(dir, "final.json"), "utf8"));
  assert.deepEqual(final[0].scan.transcript_read, [[0, 30]]);
  assert.deepEqual(final[0].scan.signals, ["frame", "asr"]);
  assert.match(final[0].scan.note, /미확보: \[\[30,60\]\]/);
  assert.deepEqual(final[1], result);
});

test("FC 도장(fco:context scan)도 같은 기록 함수 — 미열람 ID는 DB 전에 거부, ack 범위·asr·메모만 넣는다", (t) => {
  const root = fixture(t); const ctx = seed(root, [{ at: 0, end: 30, text: "이번 판 친선이에요" }]);
  const p = packet(ctx, [[0, 60]]); readPage(ctx, p, 1);
  const cli = [join(import.meta.dirname, "../fco-context.ts"), "scan", "--vod", "777", "--status", "running", "--listen-read", p.id];
  // DATABASE_URL 없이 돌린다 — DB 에 닿기 전에 열람 검사에서 멈춰야 통과한다.
  const env = { ...process.env, DATABASE_URL: "" };
  assert.throws(() => execFileSync(process.execPath, cli, { cwd: root, stdio: "pipe", env }), /실제 열람 ack가 없는/); // "packages" 경로의 ack 와 헷갈리지 않게
  assert.deepEqual(scanListen(root, "777", {}), { transcript_read: [], signals: [], notes: [], warnings: [] }); // 꺼져 있으면 아무것도 안 붙인다
  acknowledge(ctx, [p.id]);
  configure(root, true, 777); packet(ctx, [[60, 90]]);
  const audio = scanListen(root, "777", { read: [p.id], note: "120~300초 다운로드 실패" });
  assert.deepEqual(audio.transcript_read, [[0, 30]]);
  assert.deepEqual(audio.signals, ["asr"]);
  assert.match(audio.notes[0], /미확보: \[\[30,60\]\]/); assert.match(audio.notes[1], /음성 확인 한계: 120~300초/);
  assert.match(audio.warnings.join("\n"), /미열람 패킷 1개/);
});

test("네트워크 대기 중 SIGTERM은 체크포인트와 잠금을 남겨두지 않고 종료", async (t) => {
  const root = fixture(t);
  const script = join(root, "cancel.mjs");
  writeFileSync(script, `import {prepare} from ${JSON.stringify(new URL("./prepare.mjs", import.meta.url).href)};
const source={vodDetail:()=>{console.log('waiting');return new Promise(()=>{});}};
try{await prepare(${JSON.stringify(root)},'777',[[0,30]],{source});process.exit(9)}catch(e){console.log(e.message);process.exit(130)};`);
  const child = spawn(process.execPath, [script]);
  t.after(() => child.kill("SIGKILL"));
  const exited = new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
  await new Promise<void>((resolve, reject) => { child.stdout.once("data", () => resolve()); child.once("error", reject); });
  child.kill("SIGTERM");
  assert.equal(await exited, 130);
  const ctx = context(root, 777);
  assert.equal(ctx.data.chunks.length, 0); assert.match(ctx.data.sessions[0].error, /중단/);
  const source = { vodDetail: async () => { throw new Error("다음 준비 진입"); }, hlsSegments: async () => { throw new Error("unused"); }, segmentsSpan: async () => null };
  await assert.rejects(prepare(root, "777", [[0, 30]], { source }), /다음 준비 진입/);
  assert.equal(existsSync(join(root, ".local/asr/runs/listen-777/piece.src")), false);
});
