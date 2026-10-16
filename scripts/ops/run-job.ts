/**
 * 감싸는 실행기 — 작업 하나의 실행을 job_run 한 행으로 남긴다: 시작 · 60초마다 생존 신호와 진척 · 끝 · 멈춘 이유.
 *
 *   node scripts/ops/run-job.ts --job <등록부 id> -- <원래 명령 …>
 *   (유닛의 ExecStart 앞에 붙는다. 사람이 띄우는 백필도 같은 방식: … --job ck-backfill -- scripts/ck-backfill.sh …)
 *
 * ★ 원래 명령은 그대로 돈다 — 인자·작업 폴더·환경을 바꾸지 않고(OPS_RUN_ID·OPS_RUN_DIR·OPS_JOB 만 더한다),
 *   종료 코드와 신호 종료를 그대로 돌려준다. 같은 프로세스 그룹이라 systemd 정지·Ctrl-C 는 자식이 직접 받는다.
 * ★ 기록의 주인은 이 실행기 하나다. 워커(runJob)는 감싸기 아래에서 job_run 에 쓰지 않고 result.json 만 남긴다.
 * ★ 멈춘 이유: 등록부 record 가 runner 면 작업이 쓴 stop.json(없으면 unknown — 추측하지 않는다),
 *   exit_code 면 종료 코드(0 완료 · 신호 종료 · 그 외 오류). 같은 종료 코드 3 이 여러 이유를 뜻하는 실행기는 runner 다.
 * ★ DB 주소는 이 실행기만 apps/web/.env.local 에서 읽는다 — 자식 환경에 넣지 않는다(조사 세션까지 비밀번호가 내려가지 않게).
 * ★ DB 가 안 되면 out/ops/runs.jsonl 에 남기고, 다음 실행이 시작할 때 옮긴다.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { constants, hostname } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import postgres, { type Sql } from "postgres";

import { HEARTBEAT_STALE_MIN } from "../../packages/core/lib/ops/model.ts";
import { readProgress, readResult, readStop } from "../../packages/core/lib/ops/run-files.ts";
import { loadJobs } from "./jobs.ts";
import { appendPending, closeLost, flushPending, pendingFile, upsertRun, type RunRecord, type RunState } from "./run-record.ts";

const ROOT = process.env.OPS_ROOT || join(import.meta.dirname, "..", "..");
const BEAT_MS = Number(process.env.OPS_HEARTBEAT_MS ?? 60_000);

function args() {
  const argv = process.argv.slice(2), sep = argv.indexOf("--");
  const head = sep < 0 ? argv : argv.slice(0, sep), cmd = sep < 0 ? [] : argv.slice(sep + 1);
  const i = head.indexOf("--job");
  const job = i >= 0 ? head[i + 1] : undefined;
  if (!job || !cmd.length) { console.error("사용법: node scripts/ops/run-job.ts --job <등록부 id> -- <명령 …>"); process.exit(2); }
  return { job, cmd };
}

function databaseUrl(): string | null {
  if (process.env.OPS_RECORD_DB === "0") return null;
  if (process.env.OPS_DATABASE_URL) return process.env.OPS_DATABASE_URL;
  const file = join(ROOT, "apps", "web", ".env.local");
  if (existsSync(file)) { const v = parseEnv(readFileSync(file, "utf8")).DATABASE_URL; if (v) return v; }
  return process.env.DATABASE_URL ?? null;
}

const STATE: Record<string, RunState> = { completed: "ok", no_work: "ok", time_cap: "ok", budget: "ok", skipped: "skipped", user_stop: "stopped" };

async function main() {
  const { job, cmd } = args();
  const { jobs, errors } = loadJobs(ROOT);
  const spec = jobs.find((j) => j.id === job);
  // 등록부가 깨져도 원래 작업은 돌린다 — 기록만 unknown 으로 남는다. 등록부에 없는 id 는 기록 칸을 잃으므로 거부한다.
  if (!spec) { console.error(`[run-job] 등록부에 없는 작업: ${job}${errors.length ? ` (등록부 오류 ${errors.length}건)` : ""}`); process.exit(2); }
  if (spec.record === "none") { console.error(`[run-job] ${job} 는 record: none — 감싸지 않는 작업이다`); process.exit(2); }

  const runId = randomUUID();
  const dir = join(ROOT, "out", "ops", "runs", job, runId);
  mkdirSync(dir, { recursive: true });
  const file = pendingFile(ROOT);
  const url = databaseUrl();
  const sql: Sql | null = url ? postgres(url, { max: 1, prepare: false, connect_timeout: 10, idle_timeout: 5, onnotice: () => {} }) : null;
  let seq = 0, dbOk = !!sql;
  const now = () => new Date().toISOString();
  const rec: RunRecord = {
    run_id: runId, ops_job: job, job, trigger: process.env.INVOCATION_ID ? "systemd" : "manual", host: hostname(),
    started_at: now(), state: "running", finished_at: null, heartbeat_at: now(), progress: null, stop_reason: null, stop_detail: null,
    exit_code: null, processed: 0, api_calls: 0, error: null, detail: null,
  };
  // 기록 실패가 작업을 막지 않는다 — DB 가 안 되면 파일로. 한 번 실패하면 이 실행 동안은 파일만 쓴다(매분 10초씩 기다리지 않게).
  async function save() {
    const snapshot = { ...rec };
    seq += 1;
    if (sql && dbOk) {
      try { await withTimeout(upsertRun(sql, snapshot), 15_000); return; }
      catch (e) { dbOk = false; console.error(`[run-job] 실행 기록을 DB 에 못 썼다 — ${file} 에 남긴다: ${(e as Error).message}`); }
    }
    try { appendPending(file, seq, snapshot); } catch (e) { console.error(`[run-job] 실행 기록 파일도 못 썼다: ${(e as Error).message}`); }
  }
  await save();
  if (sql && dbOk) {
    try {
      await withTimeout(closeLost(sql, job, runId, HEARTBEAT_STALE_MIN), 15_000);
      const moved = await withTimeout(flushPending(sql, file), 30_000);
      if (moved) console.error(`[run-job] 파일에 남았던 실행 기록 ${moved}건을 DB 로 옮겼다`);
    } catch (e) { console.error(`[run-job] 앞 기록 정리 실패(작업은 계속): ${(e as Error).message}`); }
  }

  const child = spawn(cmd[0]!, cmd.slice(1), {
    stdio: "inherit", env: { ...process.env, OPS_RUN_ID: runId, OPS_RUN_DIR: dir, OPS_JOB: job },
  });
  // 신호는 자식이 직접 받는다(같은 그룹·같은 cgroup). 이 실행기만 따로 죽임당했으면 3초 뒤 자식에게 넘긴다.
  let signalled: NodeJS.Signals | null = null;
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, () => {
    signalled = sig;
    setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill(sig); }, 3000).unref();
  });
  const beat = setInterval(() => {
    rec.heartbeat_at = now();
    const p = readProgress(dir); if (p) rec.progress = p;
    void save();
  }, BEAT_MS);

  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
    child.once("error", (e) => { console.error(`[run-job] 명령을 실행하지 못했다: ${e.message}`); resolve([127, null]); });
    child.once("exit", (c, s) => resolve([c, s]));
  });
  clearInterval(beat);
  const exitCode = code ?? 128 + (signal ? constants.signals[signal] : 0);

  const stop = readStop(dir), result = readResult(dir), progress = readProgress(dir);
  let reason: string, detail: string;
  if (spec.record === "runner") {
    if (stop) { reason = stop.reason; detail = stop.detail ?? ""; }
    else if (signal || signalled) { reason = "killed"; detail = `신호 ${signal ?? signalled} · 실행기가 이유를 남기기 전에 끊겼다`; }
    else { reason = "unknown"; detail = `종료 코드 ${exitCode} · 실행기가 멈춘 이유를 남기지 않았다`; }
  } else if (signal || exitCode === 130 || exitCode === 143) { reason = "killed"; detail = `신호 ${signal ?? signalled ?? `종료 코드 ${exitCode}`}`; }
  else if (exitCode === 0) { reason = "completed"; detail = ""; }
  else { reason = "error"; detail = `종료 코드 ${exitCode}`; }

  Object.assign(rec, {
    state: reason === "unknown" ? (exitCode === 0 ? "ok" : "failed") : STATE[reason] ?? "failed",
    finished_at: now(), heartbeat_at: now(), progress: progress ?? rec.progress,
    stop_reason: reason, stop_detail: detail || null, exit_code: exitCode,
    processed: Number(result?.processed ?? 0) || 0, api_calls: Number(result?.api_calls ?? 0) || 0,
    error: typeof result?.error === "string" ? result.error : null,
    detail: result ? { ...(result.engine ? { engine: result.engine } : {}), ...(result.detail && typeof result.detail === "object" ? result.detail as object : {}) } : null,
  } satisfies Partial<RunRecord>);
  await save();
  if (sql) await sql.end({ timeout: 5 }).catch(() => {});
  // 원래 명령의 끝을 그대로 돌려준다 — 신호로 끝났으면 같은 신호로 끝나야 systemd 가 같은 결과를 본다.
  if (signal) { for (const s of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.removeAllListeners(s); process.kill(process.pid, signal); }
  process.exit(exitCode);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`시간 초과(${ms / 1000}초)`)), ms).unref())]);
}

await main();
