/**
 * 실행 기록 저장 — job_run(0088) 에 run_id 로 upsert, DB 가 안 되면 out/ops/runs.jsonl 에 남겼다가 다음 성공 때 옮긴다.
 *
 * ★ 같은 실행을 두 번 만들지 않는다: 언제나 run_id 로 upsert 하고, 끝난 행을 진행 중 기록으로 되돌리지 않는다.
 *   파일 기록은 실행마다 마지막 것(seq 가 가장 큰 것)만 옮긴다. 여러 번 옮겨도, 일부가 이미 DB 에 있어도 행은 하나다.
 * ★ DB 관문으로 멈춘 작업이 자기 멈춤을 DB 에 못 쓰는 경우가 이 파일이 있는 이유다(2026-10 디스크 가득 참 사고).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Sql } from "postgres";

export type RunState = "running" | "ok" | "failed" | "stopped" | "skipped" | "lost";
export interface RunRecord {
  run_id: string; ops_job: string; job: string; trigger: string | null; host: string;
  started_at: string; state: RunState; finished_at: string | null; heartbeat_at: string | null;
  progress: unknown; stop_reason: string | null; stop_detail: string | null; exit_code: number | null;
  processed: number; api_calls: number; error: string | null; detail: unknown;
}

export async function upsertRun(sql: Sql, r: RunRecord): Promise<void> {
  const json = (v: unknown) => v === null || v === undefined ? null : sql.json(v as never);
  // 끝난 행은 진행 중 기록으로 덮지 않는다. 단, 다음 실행이 lost 로 닫은 행에 진짜 최종 기록이 늦게 오면 받는다.
  await sql`
    INSERT INTO job_run (run_id, ops_job, job, trigger, host, started_at, state, finished_at, heartbeat_at, progress,
      stop_reason, stop_detail, exit_code, processed, api_calls, error, detail)
    VALUES (${r.run_id}, ${r.ops_job}, ${r.job}, ${r.trigger}, ${r.host}, ${r.started_at}, ${r.state}, ${r.finished_at}, ${r.heartbeat_at},
      ${json(r.progress)}, ${r.stop_reason}, ${r.stop_detail}, ${r.exit_code}, ${r.processed}, ${r.api_calls}, ${r.error}, ${json(r.detail)})
    ON CONFLICT (run_id) WHERE run_id IS NOT NULL DO UPDATE SET
      state = EXCLUDED.state, finished_at = EXCLUDED.finished_at,
      heartbeat_at = GREATEST(job_run.heartbeat_at, EXCLUDED.heartbeat_at), progress = coalesce(EXCLUDED.progress, job_run.progress),
      stop_reason = EXCLUDED.stop_reason, stop_detail = EXCLUDED.stop_detail, exit_code = EXCLUDED.exit_code,
      processed = EXCLUDED.processed, api_calls = EXCLUDED.api_calls, error = EXCLUDED.error, detail = coalesce(EXCLUDED.detail, job_run.detail)
    WHERE job_run.finished_at IS NULL OR (job_run.state = 'lost' AND EXCLUDED.finished_at IS NOT NULL)`;
}

/** 같은 작업의 앞 실행이 생존 신호 없이 running 으로 남았으면 lost 로 닫는다(그 실행기는 이미 죽었다). */
export async function closeLost(sql: Sql, opsJob: string, exceptRunId: string, staleMin: number): Promise<number> {
  const rows = await sql`
    UPDATE job_run SET state = 'lost', stop_reason = 'lost', finished_at = heartbeat_at,
      stop_detail = '생존 신호가 끊긴 뒤 최종 기록이 오지 않았다 — 다음 실행이 닫음'
    WHERE ops_job = ${opsJob} AND state = 'running' AND run_id <> ${exceptRunId}
      AND heartbeat_at < now() - make_interval(mins => ${staleMin}) RETURNING id`;
  return rows.length;
}

// ── 파일 대체 기록 ─────────────────────────────────────────────────────

/** 여러 실행기가 같은 파일을 쓰므로 짧게 잠근다(mkdir 은 원자적이다). 60초 넘은 잠금은 죽은 실행기의 것으로 본다. */
function withLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock.d`;
  mkdirSync(dirname(file), { recursive: true });
  const deadline = Date.now() + 10_000;
  for (;;) {
    try { mkdirSync(lock); break; } catch {
      try { if (Date.now() - statSync(lock).mtimeMs > 60_000) { rmdirSync(lock); continue; } } catch { continue; }
      if (Date.now() > deadline) throw new Error(`실행 기록 파일 잠금을 못 잡았다: ${lock}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try { return fn(); } finally { try { rmdirSync(lock); } catch { /* 이미 정리됨 */ } }
}

export function appendPending(file: string, seq: number, r: RunRecord) {
  withLock(file, () => appendFileSync(file, JSON.stringify({ seq, record: r }) + "\n"));
}

/** 파일에 남은 기록을 옮긴다. 옮긴 실행은 파일에서 지운다. 옮긴 실행 수를 돌려준다. */
export async function flushPending(sql: Sql, file: string): Promise<number> {
  if (!existsSync(file)) return 0;
  const latest = withLock(file, () => {
    const map = new Map<string, { seq: number; record: RunRecord }>();
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as { seq: number; record: RunRecord };
        const prev = map.get(e.record.run_id);
        if (!prev || e.seq >= prev.seq) map.set(e.record.run_id, e);
      } catch { /* 반쯤 쓴 줄은 건너뛴다 — 다음 줄이 같은 실행의 더 새 기록이다 */ }
    }
    return map;
  });
  const done = new Set<string>();
  for (const [id, e] of latest) { await upsertRun(sql, e.record); done.add(id); }
  // 옮기는 사이 다른 실행기가 덧붙인 줄은 남긴다 — 옮긴 실행의 "옮긴 seq 이하" 줄만 지운다.
  withLock(file, () => {
    const keep = readFileSync(file, "utf8").split("\n").filter((line) => {
      if (!line.trim()) return false;
      try { const e = JSON.parse(line) as { seq: number; record: RunRecord }; const sent = latest.get(e.record.run_id); return !(sent && done.has(e.record.run_id) && e.seq <= sent.seq); }
      catch { return false; }
    });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, keep.length ? keep.join("\n") + "\n" : "");
    renameSync(tmp, file);
  });
  return done.size;
}

export const pendingFile = (root: string) => join(root, "out", "ops", "runs.jsonl");
