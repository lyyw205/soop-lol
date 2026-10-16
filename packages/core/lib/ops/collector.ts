import { execFile } from "node:child_process";
import { access, open, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { db } from "../db/client.ts";
import { JOBS, evaluateJob, type Job, type Run, type Snapshot, type Unit, type Alert } from "./model.ts";

const exec = promisify(execFile);
export function opsRoot() {
  // Explicit path also supports a web host mounting the collector's read-only output.
  return process.env.OPS_OUT_ROOT || process.env.CK_OUT_ROOT || "";
}
async function exists(path: string) { try { await access(path); return true; } catch { return false; } }
async function json(path: string) { return JSON.parse(await readFile(path, "utf8")); }
async function tailJson(path: string) {
  const file = await open(path, "r");
  try {
    const size = (await file.stat()).size;
    const buffer = Buffer.alloc(Math.min(size, 16_384));
    await file.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
    const lines = buffer.toString("utf8").trim().split("\n");
    for (const line of lines.reverse()) { try { return JSON.parse(line); } catch { /* Ignore an incomplete append. */ } }
    return null;
  } finally { await file.close(); }
}
const timestamp = (s: string | undefined): string | null => {
  if (!s || s === "n/a") return null;
  const time = Date.parse(s);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};
export function parseUnits(output: string, now: number, uptimeSec: number): Map<string, Unit> {
  const rows = new Map(output.trim().split(/\n\s*\n/).map(block => {
    const values = Object.fromEntries(block.split("\n").map(line => { const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1)]; }));
    return [values.Id, values];
  }));
  const units = new Map<string, Unit>();
  for (const spec of JOBS.filter(j => j.unit)) {
    const service = rows.get(`${spec.unit}.service`) ?? {};
    const trigger = rows.get(`${spec.unit}.${spec.trigger ?? "timer"}`) ?? {};
    const mono = durationUsec(trigger.NextElapseUSecMonotonic);
    const nextAt = timestamp(trigger.NextElapseUSecRealtime) ?? (mono > 0 ? new Date(now - uptimeSec * 1000 + mono / 1000).toISOString() : null);
    units.set(spec.id, {
      loaded: trigger.LoadState === "loaded", enabled: ["enabled", "enabled-runtime"].includes(trigger.UnitFileState),
      active: trigger.ActiveState === "active", running: ["active", "activating"].includes(service.ActiveState),
      failed: service.ActiveState === "failed" || (!!service.ExecMainStartTimestamp && !!service.Result && service.Result !== "success"),
      startedAt: timestamp(service.ExecMainStartTimestamp), finishedAt: timestamp(service.ExecMainExitTimestamp), nextAt,
    });
  }
  return units;
}
/** systemctl show prints monotonic durations as "6h 37min 13.956660s", not integer microseconds. */
export function durationUsec(value: string | undefined): number {
  if (!value || value === "infinity") return 0;
  if (/^\d+$/.test(value)) return Number(value);
  const units: Record<string, number> = { us: 1, ms: 1000, s: 1e6, min: 60e6, h: 3600e6, d: 86400e6, w: 604800e6 };
  return [...value.matchAll(/(\d+(?:\.\d+)?)\s*(us|ms|min|s|h|d|w)\b/g)].reduce((sum, m) => sum + Number(m[1]) * units[m[2]], 0);
}
async function readUnits(now: number) {
  const names = JOBS.filter(j => j.unit).flatMap(j => [`${j.unit}.service`, `${j.unit}.${j.trigger ?? "timer"}`]);
  const [{ stdout }, uptime] = await Promise.all([
    exec("systemctl", ["--user", "show", ...names, "--no-pager", "--timestamp=us", "-p", "Id,LoadState,UnitFileState,ActiveState,Result,ExecMainStartTimestamp,ExecMainExitTimestamp,NextElapseUSecRealtime,NextElapseUSecMonotonic"],
      { timeout: 5000, maxBuffer: 128 * 1024, env: { ...process.env, LC_ALL: "C", TZ: "UTC" } }),
    readFile("/proc/uptime", "utf8"),
  ]);
  return parseUnits(stdout, now, Number(uptime.split(" ")[0]));
}
/**
 * 작업마다 실행 이력을 읽는다. 감싼 실행(0088)은 ops_job = 등록부 id, 감싸기 이전·상주 루프 기록은 job = 엔진 이름(legacyNames).
 * 결과의 Run.job 은 언제나 등록부 id 다 — 화면이 작업 카드와 이력을 같은 키로 잇는다.
 */
function runSources() {
  // ★ 불리언 배열은 postgres.js 가 boolean[] 로 못 넘긴다("cannot cast type boolean to boolean[]") — 'ops'/'legacy' 문자열로 넘긴다.
  const ids: string[] = [], names: string[] = [], legacy: string[] = [];
  for (const spec of JOBS) {
    ids.push(spec.id); names.push(spec.id); legacy.push("ops");
    for (const n of spec.legacyNames) { ids.push(spec.id); names.push(n); legacy.push("legacy"); }
  }
  return { ids, names, legacy };
}
async function readRuns() {
  // Bound both server execution time and response size. Existing per-job index covers these reads.
  const { ids, names, legacy } = runSources();
  return db().begin(async sql => {
    await sql`SET LOCAL statement_timeout = '8s'`;
    const rows = await sql`
      WITH src AS (SELECT * FROM unnest(${ids}::text[], ${names}::text[], ${legacy}::text[]) AS t(id, name, legacy))
      SELECT src.id AS job, j.id::text, j.started_at AS "startedAt", j.finished_at AS "finishedAt", j.state, j.processed,
        CASE WHEN j.error IS NULL THEN NULL ELSE '실행 실패 · 서비스 로그 확인' END AS error,
        j.stop_reason AS "stopReason", j.stop_detail AS "stopDetail", j.heartbeat_at AS "heartbeatAt", j.progress, j.exit_code AS "exitCode"
      FROM src
      CROSS JOIN LATERAL (SELECT * FROM job_run
        WHERE (src.legacy = 'ops' AND ops_job = src.name) OR (src.legacy = 'legacy' AND ops_job IS NULL AND job = src.name)
        ORDER BY started_at DESC LIMIT 8) j
      ORDER BY j.started_at DESC`;
    const totals = await sql`
      WITH src AS (SELECT * FROM unnest(${names}::text[], ${legacy}::text[]) AS t(name, legacy))
      SELECT coalesce(sum(t.completed), 0)::int AS completed, coalesce(sum(t.processed), 0)::bigint::text AS processed
      FROM src CROSS JOIN LATERAL (
        SELECT count(*) FILTER (WHERE state = 'ok') AS completed, coalesce(sum(processed), 0) AS processed
        FROM job_run WHERE ((src.legacy = 'ops' AND ops_job = src.name) OR (src.legacy = 'legacy' AND ops_job IS NULL AND job = src.name))
          AND started_at >= now() - interval '24 hours'
      ) t`;
    const success = await sql`
      WITH src AS (SELECT * FROM unnest(${ids}::text[], ${names}::text[], ${legacy}::text[]) AS t(id, name, legacy))
      SELECT src.id, max(j.finished_at) AS at FROM src
      LEFT JOIN LATERAL (SELECT finished_at FROM job_run
        WHERE ((src.legacy = 'ops' AND ops_job = src.name) OR (src.legacy = 'legacy' AND ops_job IS NULL AND job = src.name)) AND state = 'ok'
        ORDER BY started_at DESC LIMIT 1) j ON true
      GROUP BY src.id`;
    return { recent: JSON.parse(JSON.stringify(rows)) as Run[], completed: Number(totals[0].completed), processed: Number(totals[0].processed),
      success: new Map(success.map(r => [String(r.id), r.at ? new Date(r.at).toISOString() : null])) };
  });
}
async function readBackfill(): Promise<Snapshot["backfill"]> {
  return db().begin(async sql => {
    await sql`SET LOCAL statement_timeout = '5s'`;
    const rows = await sql`SELECT count(*)::int AS requests, max(requested_at) AS latest,
      min(from_date)::text AS "from", max(to_date)::text AS "to" FROM ck_backfill_request`;
    return { requests: rows[0].requests, latestAt: rows[0].latest ? new Date(rows[0].latest).toISOString() : null, from: rows[0].from, to: rows[0].to };
  });
}
const RESEARCH_IDLE_MIN = 30, RESEARCH_STUCK_MIN = 180;
const hours = (msec: number) => msec < 3_600_000 ? `${Math.round(msec / 60_000)}분` : `${(msec / 3_600_000).toFixed(1)}시간`;
/** 대기 중인 조사가 멈췄으면 그 설명, 아니면 null. 진척 = 실행이 남긴 progress.at 또는 마지막 성공. */
export function researchStall(job: Job, queue: NonNullable<Snapshot["queue"]>, now: number): string | null {
  const t = (s: string | null | undefined) => s ? Date.parse(s) : NaN;
  const progressAt = Math.max(...[t(job.progress?.at), t(job.lastSuccessAt)].filter(Number.isFinite), -Infinity);
  const waiting = `대기 ${queue.pending}건 · 작업 중 ${queue.owned}건${queue.oldestPendingAt ? ` · 가장 오래 기다린 ${hours(now - t(queue.oldestPendingAt))}` : ""}`;
  if (job.state === "working") {
    const since = Number.isFinite(progressAt) ? Math.max(progressAt, t(job.lastAt) || -Infinity) : t(job.lastAt);
    return Number.isFinite(since) && now - since > RESEARCH_STUCK_MIN * 60_000
      ? `실행 중이지만 ${hours(now - since)}째 진척이 없습니다 · ${waiting}` : null;
  }
  const since = Math.max(progressAt, t(job.lastAt) || -Infinity);
  if (Number.isFinite(since) && now - since <= RESEARCH_IDLE_MIN * 60_000) return null;
  return `조사 정지 — ${waiting} · 마지막 진척 ${Number.isFinite(progressAt) ? `${hours(now - progressAt)} 전` : "기록 없음"}`;
}
export async function collectSnapshot(mode: Snapshot["mode"] = "on-demand"): Promise<Snapshot> {
  const now = Date.now(), at = new Date(now).toISOString(), root = opsRoot();
  const queuePath = join(root, "ck/auto/queue.json");
  const [runs, units, queueResult, healthResult, backfillResult, localResult, stopResult, writeBlock] = await Promise.allSettled([
    readRuns(), readUnits(now),
    root ? Promise.all([json(queuePath), stat(queuePath)]) : Promise.reject(new Error("local source not configured")),
    root ? tailJson(join(root, "ops/usage.jsonl")) : Promise.resolve(null), readBackfill(),
    // This is an explicitly mounted runtime data directory, never a bundled application asset.
    root ? stat(/* turbopackIgnore: true */ root) : Promise.reject(new Error("local source not configured")),
    Promise.all(JOBS.map(j => root && j.stopFile ? exists(join(root, j.stopFile)) : false)), root ? exists(join(root, "ops/write-blocked.json")) : Promise.resolve(false),
  ]);
  const recent = runs.status === "fulfilled" ? runs.value.recent : [];
  const jobs = JOBS.map((spec, i) => evaluateJob(spec, recent.find(r => r.job === spec.id), units.status === "fulfilled" ? units.value.get(spec.id) : undefined,
    stopResult.status === "fulfilled" && stopResult.value[i], now, runs.status === "fulfilled" ? runs.value.success.get(spec.id) : null));
  const alerts: Alert[] = jobs.filter(j => ["failed", "delayed"].includes(j.state)).map(j => ({
    id: `job:${j.id}:${j.state}`, jobId: j.id, room: j.room, title: `${j.name} · ${j.state === "failed" ? "실패" : "지연"}`,
    detail: j.message, severity: j.state === "failed" ? "error" : "warning",
  }));
  if (runs.status === "rejected") alerts.push({ id: "source:db", title: "실행 DB 연결 확인 필요", detail: "실행 이력과 처리량을 읽지 못했습니다. DB 연결과 테이블을 확인하세요.", severity: "error" });
  if (units.status === "rejected") alerts.push({ id: "source:systemd", title: "자동 실행 상태 미관측", detail: "이 호스트에서 사용자 systemd를 읽지 못했습니다. 수집기를 작업 실행 호스트에 설치하세요.", severity: "warning" });
  const queue = queueResult.status === "fulfilled" ? (() => {
    const [q, stats] = queueResult.value;
    if (q.version !== 1 || !q.jobs || typeof q.jobs !== "object") return null;
    const items = Object.values(q.jobs) as { owner?: string; not_before: number }[];
    const pending = items.filter(j => !j.owner && j.not_before <= now);
    // not_before 는 등록 시각이거나 재시도 시각이다 — 가장 이른 값이 "가장 오래 기다린" 근사다.
    const oldest = pending.length ? Math.min(...pending.map(j => j.not_before)) : null;
    return { pending: pending.length, owned: items.filter(j => j.owner).length,
      deferred: items.filter(j => !j.owner && j.not_before > now).length, updatedAt: stats.mtime.toISOString(),
      oldestPendingAt: oldest !== null && Number.isFinite(oldest) ? new Date(oldest).toISOString() : null };
  })() : null;
  // 조사 작업은 최근 실행만으로 정상이 아니다 — 대기가 있는데 진척이 없으면 "조사 정지"다(목록 확인이 매시간 성공해도 가리지 않는다).
  //   대기 파일의 갱신 시각은 쓰지 않는다 — 목록 확인이 매시간 고쳐 써서 정지를 가린다.
  const worker = jobs.find(j => j.research && j.trigger === "path");
  if (worker && queue && queue.pending + queue.owned > 0 && worker.state !== "paused") {
    const stall = researchStall(worker, queue, now);
    if (stall) {
      Object.assign(worker, { state: "delayed", message: stall, action: "조사 작업자(ck-auto-worker)와 실행 로그를 확인한다" });
      alerts.push({ id: "queue:stalled", room: "research", jobId: worker.id, title: `${worker.displayGroup ?? worker.name} · 조사 정지`, detail: stall, severity: "warning" });
    }
  }
  const rawHealth = healthResult.status === "fulfilled" ? healthResult.value : null;
  const health: Snapshot["health"] = rawHealth && Number.isFinite(Date.parse(rawHealth.at)) && ["ok", "warn", "block"].includes(rawHealth.verdict)
    ? { at: rawHealth.at, verdict: rawHealth.verdict, totalBytes: typeof rawHealth.totalBytes === "number" ? rawHealth.totalBytes : null,
      reasons: Array.isArray(rawHealth.reasons) ? rawHealth.reasons.map(String).slice(0, 8) : [] } : null;
  if (!health || now - Date.parse(health.at) > 100 * 60_000)
    alerts.push({ id: "health:stale", title: "DB 용량 점검 기록 확인 필요", detail: health ? "마지막 운영 점검이 100분 이상 지났습니다." : "운영 점검 기록을 찾을 수 없습니다.", severity: "warning" });
  if (health && health.verdict !== "ok") alerts.push({ id: "health:verdict", title: health.verdict === "block" ? "DB 운영 점검 · 중단 신호" : "DB 운영 점검 · 확인 필요", detail: health.reasons.join(" · ").slice(0, 1000) || "운영 점검 로그를 확인하세요.", severity: health.verdict === "block" ? "error" : "warning" });
  if (writeBlock.status === "fulfilled" && writeBlock.value) alerts.push({ id: "health:write-block", title: "DB 쓰기 차단 표시", detail: "조사·수집의 DB 쓰기가 차단된 기록이 있습니다. 원인 해소를 확인해야 합니다.", severity: "error" });
  if (backfillResult.status === "rejected") alerts.push({ id: "source:backfill", room: "backfill", title: "백필 요청 조회 실패", detail: "요청 범위를 읽지 못했습니다. 진행률 0으로 간주하지 않습니다.", severity: "warning" });
  return { version: 1, at, mode, jobs, alerts, incidents: [], recent: recent.slice(0, 30),
    completed24h: runs.status === "fulfilled" ? runs.value.completed : null, processed24h: runs.status === "fulfilled" ? runs.value.processed : null,
    sources: { database: runs.status === "fulfilled", systemd: units.status === "fulfilled", local: localResult.status === "fulfilled" }, queue,
    backfill: backfillResult.status === "fulfilled" ? backfillResult.value : null, health };
}
