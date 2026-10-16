/**
 * 운영 화면 수집기를 실제 Postgres(PGlite, 마이그레이션 전부)에 대고 돌린다 — 실행 이력 질의가 진짜 DB 에서 도는지.
 * ★ 2026-10-16 불리언 배열 인자가 운영 DB 에서 "cannot cast type boolean to boolean[]" 로 실패했다. 질의 모양만 보는
 *   단위 시험은 이것을 못 잡는다 — 그래서 실제 DB 에서 감싼 실행(ops_job)과 옛 기록(job = 엔진 이름)을 둘 다 읽어 본다.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { disposablePglite } from "../lib/disposable-pglite.ts";
import { applyAll } from "../lib/migrations.ts";

const REPO = join(import.meta.dirname, "..", "..");
let pg: Awaited<ReturnType<typeof disposablePglite>>;
let root: string;
const saved = { DATABASE_URL: process.env.DATABASE_URL, DATABASE_POOL_MAX: process.env.DATABASE_POOL_MAX, OPS_OUT_ROOT: process.env.OPS_OUT_ROOT, PATH: process.env.PATH };

before(async () => {
  pg = await disposablePglite();
  await applyAll((s) => pg.database.exec(s), REPO);
  root = mkdtempSync(join(tmpdir(), "collector-db-"));
  Object.assign(process.env, { DATABASE_URL: pg.url, DATABASE_POOL_MAX: "1", OPS_OUT_ROOT: root, PATH: root });
});
after(async () => {
  const { closeDb } = await import("../../packages/core/lib/db/client.ts");
  await closeDb();
  await pg.stop();
  rmSync(root, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

test("감싼 실행과 옛 엔진 기록을 같은 작업 이력으로 읽고, 멈춘 이유가 화면 상태가 된다", async () => {
  await pg.database.exec(`
    INSERT INTO job_run (job, state, started_at, finished_at, processed) VALUES ('engine_a_rank', 'ok', now() - interval '2 hours', now() - interval '2 hours', 30);
    INSERT INTO job_run (job, ops_job, run_id, state, started_at, finished_at, heartbeat_at, stop_reason, stop_detail, exit_code)
      VALUES ('lol-rank', 'lol-rank', gen_random_uuid(), 'failed', now() - interval '10 minutes', now() - interval '9 minutes', now() - interval '9 minutes',
        'blocked_external', '운영 DB 점검', 3);
    INSERT INTO job_run (job, state, started_at, finished_at, processed) VALUES ('engine_b_live', 'ok', now() - interval '5 minutes', now() - interval '4 minutes', 2);`);
  const { collectSnapshot } = await import("../../packages/core/lib/ops/collector.ts");
  const s = await collectSnapshot();
  assert.equal(s.sources.database, true, JSON.stringify(s.alerts));
  const rank = s.recent.filter((r) => r.job === "lol-rank");
  assert.equal(rank.length, 2, "감싼 실행 + 옛 engine_a_rank 기록");
  assert.equal(rank[0]!.stopReason, "blocked_external");
  const job = s.jobs.find((j) => j.id === "lol-rank")!;
  assert.equal(job.state, "failed");
  assert.match(job.message, /외부 차단 · 운영 DB 점검/);
  assert.ok(s.jobs.find((j) => j.id === "lol-rank")!.lastSuccessAt, "옛 성공 기록도 마지막 성공으로 읽는다");
  assert.ok(s.recent.some((r) => r.job === "worker-loop"), "상주 루프의 엔진 기록(engine_b_live)이 루프 작업 이력으로 보인다");
  assert.equal(s.completed24h, 2);
});
