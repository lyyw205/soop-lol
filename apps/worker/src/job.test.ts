import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { DbGateBlocked } from "@soop-lol/core/lib/db/write-block";

import { runJob, type JobDeps } from "./job.ts";

const ctx = { riot: { callCount: 0 } } as never;
const readOnly = Object.assign(new Error("cannot execute INSERT in a read-only transaction"), { code: "25006" });

function fakeDeps(over: Partial<JobDeps> = {}) {
  const calls = { start: 0, finish: 0, notes: [] as string[] };
  const deps: JobDeps = {
    startJob: (async () => { calls.start++; return 1n; }) as never,
    finishJob: (async () => { calls.finish++; }) as never,
    assertDbWritable: async () => ({ verdict: "ok", reasons: [] }),
    noteWriteBlocked: (e, source) => { const hit = (e as { code?: string }).code === "25006"; if (hit) calls.notes.push(source); return hit; },
    ...over,
  };
  return { deps, calls };
}

test("★ 시작 기록에서 쓰기가 막혀도 표시를 남기고 원래 오류를 올린다 (2026-10-12 검토 재현)", async () => {
  const { deps, calls } = fakeDeps({ startJob: (async () => { throw readOnly; }) as never });
  let ran = false;
  await assert.rejects(runJob(ctx, "engine_e_fco", async () => { ran = true; return { processed: 1 }; }, deps), /read-only transaction/);
  assert.deepEqual(calls.notes, ["worker engine_e_fco"]);
  assert.equal(ran, false);
});

test("엔진이 쓰기에 막히면 표시를 남기고, 실행 기록(역시 쓰기)은 시도하지 않는다", async () => {
  const { deps, calls } = fakeDeps();
  await assert.rejects(runJob(ctx, "engine_a_rank", async () => { throw readOnly; }, deps), /read-only/);
  assert.deepEqual([calls.notes, calls.finish], [["worker engine_a_rank"], 0]);
});

test("공개 큐 적재는 점검에서 막히면 시작 기록도 쓰지 않는다", async () => {
  const { deps, calls } = fakeDeps({ assertDbWritable: async (label) => { throw new DbGateBlocked(`${label}: 멈춤`); } });
  await assert.rejects(runJob(ctx, "engine_c_backfill", async () => ({ processed: 1 }), deps), DbGateBlocked);
  assert.equal(calls.start, 0);
  // 작은 정기 수집은 점검을 거치지 않는다.
  const fc = fakeDeps({ assertDbWritable: async () => { throw new Error("부르면 안 된다"); } });
  assert.equal((await runJob(ctx, "engine_e_fco", async () => ({ processed: 2 }), fc.deps)).processed, 2);
});

test("★ 작업자도 ops:usage 와 같은 운영 점검 설정(토큰·한도)을 읽는다", () => {
  const scripts = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")).scripts as Record<string, string>;
  const opsEnv = "--env-file-if-exists=$HOME/.config/soop-lol/ops.env";
  assert.ok(scripts["ops:usage"].includes(opsEnv));
  assert.ok(scripts.worker.includes(opsEnv), "npm run worker 가 ops.env 를 읽지 않으면 공개 큐 적재 전 점검이 관리 상태·디스크를 못 본다");
});

// ── 감싸기 아래(scripts/ops/run-job.ts) — 실행 기록의 주인은 실행기, 여기는 결과·멈춘 이유 파일만 ──
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const wrappedDir = () => mkdtempSync(join(tmpdir(), "runjob-wrapped-"));
const readJson = (dir: string, name: string) => JSON.parse(readFileSync(join(dir, name), "utf8"));

test("감싸기 아래에서는 job_run 에 쓰지 않고 결과·완료 이유를 파일로 넘긴다", async () => {
  const dir = wrappedDir();
  try {
    const { deps, calls } = fakeDeps({ runDir: dir });
    await runJob(ctx, "engine_a_rank", async () => ({ processed: 7, detail: { snapshots: 7 } }), deps);
    assert.deepEqual([calls.start, calls.finish], [0, 0]);
    assert.equal(readJson(dir, "stop.json").reason, "completed");
    assert.deepEqual([readJson(dir, "result.json").engine, readJson(dir, "result.json").processed], ["engine_a_rank", 7]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("감싸기 아래 부분 실패는 종료 코드 3 그대로 + 이유 error(부분 실패)", async () => {
  const dir = wrappedDir(), before = process.exitCode;
  try {
    const { deps } = fakeDeps({ runDir: dir });
    await runJob(ctx, "engine_e_fco", async () => ({ processed: 25, failed: 5 }), deps);
    assert.equal(process.exitCode, 3);
    assert.deepEqual([readJson(dir, "stop.json").reason, /부분 실패 5건/.test(readJson(dir, "stop.json").detail)], ["error", true]);
  } finally { process.exitCode = before; rmSync(dir, { recursive: true, force: true }); }
});

test("감싸기 아래 쓰기 차단·DB 점검 멈춤은 오류가 아니라 외부 차단으로 남는다", async () => {
  const dir = wrappedDir();
  try {
    const { deps, calls } = fakeDeps({ runDir: dir });
    await assert.rejects(runJob(ctx, "engine_a_rank", async () => { throw readOnly; }, deps), /read-only/);
    assert.equal(readJson(dir, "stop.json").reason, "blocked_external");
    assert.deepEqual(calls.notes, ["worker engine_a_rank"]);
    const gated = fakeDeps({ runDir: dir, assertDbWritable: async (label) => { throw new DbGateBlocked(`${label}: 멈춤`); } });
    await assert.rejects(runJob(ctx, "engine_c_backfill", async () => ({ processed: 1 }), gated.deps), DbGateBlocked);
    assert.match(readJson(dir, "stop.json").detail, /운영 DB 점검/);
    assert.equal(readJson(dir, "stop.json").reason, "blocked_external");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
