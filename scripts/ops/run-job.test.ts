/**
 * 감싸는 실행기(run-job.ts)를 실제 Postgres(PGlite, 마이그레이션 전부 적용)와 가짜 명령으로 끝까지 돌린다.
 * 확인: 같은 종료 코드라도 이유가 다르면 다르게 남는다 · 이유가 없으면 unknown · 종료 코드·신호 투명 전달 ·
 * 생존 신호·진척 · DB 가 막히면 파일로, 나중에 옮겨도 행은 하나 · 끊긴 앞 실행은 lost · DB 주소가 자식 환경에 안 내려감.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { disposablePglite } from "../lib/disposable-pglite.ts";
import { applyAll } from "../lib/migrations.ts";

const REPO = join(import.meta.dirname, "..", "..");
const HELPER = join(REPO, "scripts", "ops", "ops-stop.sh");
let pg: Awaited<ReturnType<typeof disposablePglite>>;
let root: string;

const job = (id: string, record: string) => JSON.stringify({ id, title: id, group: "ops", install: "manual", units: [], run: "bash", schedule: "시험",
  record, locks: [], resources: ["disk"], docs: [], remove: ["시험"] });

before(async () => {
  pg = await disposablePglite();
  await applyAll((s) => pg.database.exec(s), REPO);
  root = mkdtempSync(join(tmpdir(), "run-job-"));
  mkdirSync(join(root, "ops", "jobs"), { recursive: true });
  writeFileSync(join(root, "ops", "jobs", "probe-runner.json"), job("probe-runner", "runner"));
  writeFileSync(join(root, "ops", "jobs", "probe-exit.json"), job("probe-exit", "exit_code"));
});
after(async () => { await pg.stop(); rmSync(root, { recursive: true, force: true }); });

function run(id: string, script: string, env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [join(REPO, "scripts/ops/run-job.ts"), "--job", id, "--", "bash", "-c", `source ${HELPER}; ${script}`], {
    env: { PATH: process.env.PATH!, HOME: process.env.HOME!, OPS_ROOT: root, OPS_DATABASE_URL: pg.url, ...env }, stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal, stderr })));
  return { child, done };
}
const rows = async (where = "true") => (await pg.database.query<Record<string, unknown>>(`SELECT * FROM job_run WHERE ${where} ORDER BY id`)).rows;
const last = async (id: string) => (await rows(`ops_job = '${id}'`)).at(-1)!;

test("같은 종료 코드 3 — DB 관문·사용자 정지·시간 상한이 각각 다른 이유로 남는다", async () => {
  for (const [reason, state] of [["blocked_external", "failed"], ["user_stop", "stopped"], ["time_cap", "ok"]] as const) {
    const r = await run("probe-runner", `ops_stop ${reason} "시험 ${reason}"; exit 3`).done;
    assert.equal(r.code, 3, r.stderr);
    const row = await last("probe-runner");
    assert.deepEqual([row.stop_reason, row.state, row.exit_code, row.stop_detail], [reason, state, 3, `시험 ${reason}`]);
    assert.ok(row.run_id && row.finished_at && row.heartbeat_at);
  }
});

test("runner 작업이 이유를 안 남기면 unknown — 종료 코드로 지어내지 않는다", async () => {
  assert.equal((await run("probe-runner", "exit 3").done).code, 3);
  assert.deepEqual([(await last("probe-runner")).stop_reason, (await last("probe-runner")).state], ["unknown", "failed"]);
  assert.equal((await run("probe-runner", "exit 0").done).code, 0);
  assert.deepEqual([(await last("probe-runner")).stop_reason, (await last("probe-runner")).state], ["unknown", "ok"]);
});

test("exit_code 작업 — 0 완료 · 그 외 오류 · 130 끊김, 종료 코드는 그대로 돌려준다", async () => {
  for (const [code, reason] of [[0, "completed"], [4, "error"], [75, "error"], [130, "killed"]] as const) {
    const r = await run("probe-exit", `exit ${code}`).done;
    assert.equal(r.code, code);
    const row = await last("probe-exit");
    assert.deepEqual([row.stop_reason, row.exit_code], [reason, code]);
  }
});

test("신호로 끝난 명령은 같은 신호로 끝나고 이유는 killed", async () => {
  const r = await run("probe-exit", "kill -TERM $$; sleep 5").done;
  assert.equal(r.signal, "SIGTERM");
  assert.equal((await last("probe-exit")).stop_reason, "killed");
});

test("실행 중 생존 신호·진척이 기록되고, 끝난 뒤에도 진척이 남는다", async () => {
  const p = run("probe-runner", `ops_progress 2 5 VOD vod:9; sleep 1.2; ops_progress 3 5 VOD vod:10; ops_stop completed 끝`, { OPS_HEARTBEAT_MS: "300" });
  await delay(900);
  const mid = await last("probe-runner");
  assert.equal(mid.state, "running");
  assert.equal((mid.progress as { done: number }).done, 2);
  assert.equal((await p.done).code, 0);
  const end = await last("probe-runner");
  assert.deepEqual([end.state, (end.progress as { done: number; last_item: string }).done, (end.progress as { last_item: string }).last_item], ["ok", 3, "vod:10"]);
});

test("DB 가 안 되면 파일에 남기고, 다음 실행이 옮긴다 — 두 번 옮겨도 한 행", async () => {
  const before = (await rows()).length;
  const r = await run("probe-runner", `ops_stop blocked_external "DB 막힘 흉내"; exit 3`, { OPS_DATABASE_URL: "postgres://postgres@127.0.0.1:9/postgres" }).done;
  assert.equal(r.code, 3);
  assert.match(r.stderr, /실행 기록을 DB 에 못 썼다/);
  const file = join(root, "out", "ops", "runs.jsonl");
  assert.ok(existsSync(file));
  const lost = JSON.parse(readFileSync(file, "utf8").trim().split("\n").at(-1)!).record;
  assert.equal((await rows()).length, before);
  await run("probe-exit", "exit 0").done; // 다음 실행이 시작하며 옮긴다
  const moved = await rows(`run_id = '${lost.run_id}'`);
  assert.deepEqual([moved.length, moved[0]!.stop_reason, moved[0]!.state], [1, "blocked_external", "failed"]);
  assert.equal(readFileSync(file, "utf8").trim(), "");
  // 같은 기록이 파일에 다시 남아 있어도(옮기다 끊긴 경우) 행은 늘지 않는다.
  writeFileSync(file, JSON.stringify({ seq: 9, record: lost }) + "\n");
  await run("probe-exit", "exit 0").done;
  assert.equal((await rows(`run_id = '${lost.run_id}'`)).length, 1);
});

test("앞 실행이 생존 신호 없이 running 으로 남았으면 다음 실행이 lost 로 닫는다", async () => {
  await pg.database.query(`INSERT INTO job_run (job, ops_job, run_id, state, started_at, heartbeat_at)
    VALUES ('probe-runner', 'probe-runner', gen_random_uuid(), 'running', now() - interval '1 hour', now() - interval '30 minutes')`);
  await run("probe-runner", "ops_stop completed x; exit 0").done;
  const closed = await rows(`ops_job = 'probe-runner' AND state = 'lost'`);
  assert.equal(closed.length, 1);
  assert.equal(closed[0]!.stop_reason, "lost");
});

test("DB 주소는 실행기만 읽는다 — 자식 환경에 내려가지 않고 실행 ID 는 내려간다", async () => {
  mkdirSync(join(root, "apps", "web"), { recursive: true });
  writeFileSync(join(root, "apps", "web", ".env.local"), `DATABASE_URL=${pg.url}\n`);
  const out = join(root, "child-env.txt");
  const r = await run("probe-exit", `echo "\${DATABASE_URL:-없음} \${OPS_RUN_ID:-없음}" > ${out}`, { OPS_DATABASE_URL: "" }).done;
  assert.equal(r.code, 0, r.stderr);
  const [dbUrl, runId] = readFileSync(out, "utf8").trim().split(" ");
  assert.equal(dbUrl, "없음");
  assert.equal((await rows(`run_id = '${runId}'`)).length, 1); // .env.local 로 DB 에 기록했다
});
