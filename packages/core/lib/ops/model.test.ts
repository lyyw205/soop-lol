import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JOBS, evaluateJob, reconcileIncidents, type Unit, type Run, type Snapshot } from "./model.ts";
import { durationUsec, parseUnits, researchStall } from "./collector.ts";
import { readSnapshot, saveSnapshot } from "./storage.ts";

const now = Date.parse("2026-10-14T10:00:00Z"), iso = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
const spec = JOBS.find(j => j.id === "lol-rank")!;
const unit: Unit = { loaded: true, enabled: true, active: true, running: false, failed: false, startedAt: null, finishedAt: null, nextAt: iso(60) };
const run: Run = { id: "1", job: spec.id, startedAt: iso(-15), finishedAt: iso(-10), state: "ok", processed: 0, error: null };
test("registration is not an execution; uninstalled and first-run waiting differ", () => {
  const pending = evaluateJob(spec, undefined, unit, false, now);
  assert.equal(pending.state, "healthy"); assert.equal(pending.lastAt, null); assert.equal(pending.lastSuccessAt, null);
  assert.equal(evaluateJob(spec, undefined, { ...unit, loaded: false, enabled: false, active: false }, false, now).state, "unconfigured");
  assert.equal(evaluateJob(spec, undefined, undefined, false, now).state, "unknown");
});
test("zero results can succeed; partial failure stays failed; crashed run becomes overdue", () => {
  assert.equal(evaluateJob(spec, run, unit, false, now).state, "healthy");
  assert.equal(evaluateJob(spec, { ...run, state: "failed", processed: 17 }, unit, false, now).state, "failed");
  assert.equal(evaluateJob(spec, { ...run, state: "running", startedAt: iso(-120) }, unit, false, now).state, "delayed");
});
test("deliberate research stop is distinct from a stuck job", () => {
  assert.equal(evaluateJob(spec, { ...run, state: "running", startedAt: iso(-120) }, unit, true, now).state, "paused");
  assert.equal(evaluateJob(spec, run, { ...unit, enabled: false, active: false }, false, now).state, "paused");
  assert.equal(evaluateJob(spec, run, { ...unit, active: false }, false, now).state, "delayed");
});
test("fresh service failure wins over an older successful DB result", () => {
  assert.equal(evaluateJob(spec, run, { ...unit, failed: true, startedAt: iso(-5) }, false, now).state, "failed");
});
test("past deadlines and missing periodic executions alert; obsolete loop evidence stays unknown", () => {
  assert.equal(evaluateJob(spec, run, { ...unit, nextAt: iso(-20) }, false, now).state, "delayed");
  assert.equal(evaluateJob(spec, { ...run, startedAt: iso(-1600) }, unit, false, now).state, "delayed");
  assert.equal(evaluateJob(JOBS.find(j => j.id === "worker-loop")!, { ...run, startedAt: iso(-1600) }, undefined, false, now).state, "unknown");
});
test("systemd human-readable monotonic timers turn into real timestamps", () => {
  assert.equal(durationUsec("6h 37min 13.956660s"), 23833956660);
  assert.equal(durationUsec("1min 500ms"), 60500000);
  const result = parseUnits("Id=soop-schedule-poll.timer\nLoadState=loaded\nActiveState=active\nUnitFileState=enabled\nNextElapseUSecRealtime=\nNextElapseUSecMonotonic=2h 5min\n\nId=soop-schedule-poll.service\nLoadState=loaded\nActiveState=inactive\nResult=success\nExecMainStartTimestamp=Wed 2026-10-14 09:50:00 UTC\nExecMainExitTimestamp=Wed 2026-10-14 09:51:00 UTC", now, 7200);
  assert.equal(result.get("schedule-poll")?.nextAt, iso(5));
  assert.equal(result.get("schedule-poll")?.startedAt, iso(-10));
});
test("incidents deduplicate, resolve and reopen without erasing history", () => {
  const alert = { id: "one", title: "test", detail: "test", severity: "warning" as const };
  let rows = reconcileIncidents([], [alert], iso(0));
  rows = reconcileIncidents(rows, [alert], iso(1)); assert.equal(rows.length, 1); assert.equal(rows[0].openedAt, iso(0));
  rows = reconcileIncidents(rows, [], iso(2)); assert.equal(rows[0].resolvedAt, iso(2));
  rows = reconcileIncidents(rows, [alert], iso(3)); assert.equal(rows.length, 2); assert.equal(rows[0].openedAt, iso(3));
});
test("atomic snapshots retain unresolved failures during a telemetry outage", async () => {
  const root = await mkdtemp(join(tmpdir(), "office-model-"));
  try {
    const failed = evaluateJob(spec, { ...run, state: "failed" }, unit, false, now);
    const snapshot: Snapshot = { version: 1, mode: "scheduled", at: iso(0), jobs: [failed],
      alerts: [{ id: "job:failure", jobId: spec.id, title: "실패", detail: "실행 실패", severity: "error" }], incidents: [], recent: [run],
      sources: { database: true, systemd: true, local: true }, completed24h: 0, processed24h: 0, queue: null, backfill: null, health: null };
    await saveSnapshot(snapshot, root);
    await saveSnapshot({ ...snapshot, at: iso(1), alerts: [], jobs: [{ ...failed, state: "unknown" }] }, root);
    let saved = await readSnapshot(root); assert.equal(saved?.alerts.length, 1); assert.equal(saved?.incidents[0].resolvedAt, null);
    await saveSnapshot({ ...snapshot, at: iso(2), alerts: [], jobs: [{ ...failed, state: "healthy" }] }, root);
    saved = await readSnapshot(root); assert.equal(saved?.alerts.length, 0); assert.equal(saved?.incidents[0].resolvedAt, iso(2));
  } finally { await rm(root, { recursive: true, force: true }); }
});

// ── 재설계 2단계: 작업 목록은 등록부, 멈춘 이유·생존 신호·조사 정지 ──
test("화면 작업 목록은 등록부에서 온다 — 롤 자동 조사는 목록 확인·조사가 따로, 같은 묶음 이름", () => {
  const poll = JOBS.find(j => j.id === "ck-auto-lol-poll")!, work = JOBS.find(j => j.id === "ck-auto-lol-work")!;
  assert.equal(poll.displayGroup, work.displayGroup);
  assert.deepEqual([work.unit, work.trigger, work.stopFile, work.critical, work.research], ["ck-auto-worker", "path", "ck/auto/STOP", true, true]);
  assert.ok(JOBS.find(j => j.id === "worker-loop")!.legacyNames.includes("engine_a_rank") === false);
  assert.ok(JOBS.find(j => j.id === "lol-rank")!.legacyNames.includes("engine_a_rank"));
});
test("같은 종료 코드 3 이라도 멈춘 이유가 다르면 화면 상태·문구가 다르다", () => {
  const ended = { ...run, exitCode: 3, finishedAt: iso(-5), startedAt: iso(-10) };
  const blocked = evaluateJob(spec, { ...ended, state: "failed", stopReason: "blocked_external", stopDetail: "운영 DB 점검" }, unit, false, now);
  const stopped = evaluateJob(spec, { ...ended, state: "stopped", stopReason: "user_stop" }, unit, false, now);
  const capped = evaluateJob(spec, { ...ended, state: "ok", stopReason: "time_cap" }, unit, false, now);
  assert.deepEqual([blocked.state, stopped.state, capped.state], ["failed", "paused", "healthy"]);
  assert.match(blocked.message, /외부 차단 · 운영 DB 점검/);
  assert.ok(blocked.action && stopped.action);
  assert.equal(evaluateJob(spec, { ...ended, state: "failed", stopReason: "unknown" }, unit, false, now).state, "unknown");
});
test("생존 신호가 끊긴 running 행은 실행 중으로 두지 않는다", () => {
  const stale = evaluateJob(spec, { ...run, state: "running", finishedAt: null, startedAt: iso(-30), heartbeatAt: iso(-20) }, unit, false, now);
  assert.equal(stale.state, "failed"); assert.match(stale.message, /생존 신호가 20분 전에 끊겼습니다/);
  assert.equal(evaluateJob(spec, { ...run, state: "running", finishedAt: null, startedAt: iso(-30), heartbeatAt: iso(-1) }, unit, false, now).state, "working");
});
test("핵심 작업의 정지는 차별점 위험으로 보이고, 수동 작업은 오래 안 돌아도 이상이 아니다", () => {
  const work = JOBS.find(j => j.id === "ck-auto-lol-work")!;
  assert.match(evaluateJob(work, undefined, { ...unit, nextAt: null }, true, now).message, /차별점 위험/);
  const backfill = JOBS.find(j => j.id === "ck-backfill")!;
  assert.equal(evaluateJob(backfill, undefined, undefined, false, now).state, "healthy");
  assert.equal(evaluateJob(backfill, { ...run, job: backfill.id, startedAt: iso(-5000), finishedAt: iso(-4000), stopReason: "completed" }, undefined, false, now).state, "healthy");
});
test("조사 정지 — 목록 확인이 매시간 고쳐 써도 진척이 없으면 정지로 본다", () => {
  const work = JOBS.find(j => j.id === "ck-auto-lol-work")!;
  const queue = { pending: 4, owned: 0, deferred: 0, updatedAt: iso(-1), oldestPendingAt: iso(-300) };
  const idle = evaluateJob(work, { ...run, job: work.id, startedAt: iso(-200), finishedAt: iso(-190), stopReason: "completed" }, { ...unit, nextAt: null }, false, now);
  assert.match(researchStall(idle, queue, now) ?? "", /조사 정지 — 대기 4건 .* 가장 오래 기다린 5\.0시간/);
  const fresh = { ...idle, lastAt: iso(-10) };
  assert.equal(researchStall(fresh, queue, now), null);
  const stuck = { ...idle, state: "working" as const, lastAt: iso(-400), progress: { done: 2, at: iso(-200) } };
  assert.match(researchStall(stuck, queue, now) ?? "", /실행 중이지만 3\.2시간째 진척이 없습니다/);
});
test("등록부에서 빠지거나 이름이 바뀐 작업의 경보는 해소 확인 대기로 붙잡지 않는다", async () => {
  const root = await mkdtemp(join(tmpdir(), "office-retired-"));
  try {
    const healthy = evaluateJob(spec, run, unit, false, now);
    const base: Snapshot = { version: 1, mode: "scheduled", at: iso(0), jobs: [healthy], incidents: [], recent: [],
      alerts: [{ id: "job:engine_c_backfill:delayed", jobId: "engine_c_backfill", title: "옛 이름", detail: "지연", severity: "warning" }],
      sources: { database: true, systemd: true, local: true }, completed24h: 0, processed24h: 0, queue: null, backfill: null, health: null };
    await saveSnapshot(base, root);
    const next = await saveSnapshot({ ...base, at: iso(1), alerts: [] }, root);
    assert.ok(next.incidents.every(i => i.resolvedAt), "옛 id 경보가 열린 채로 남았다");
  } finally { await rm(root, { recursive: true, force: true }); }
});
