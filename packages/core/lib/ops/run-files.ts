/**
 * 감싸는 실행기(scripts/ops/run-job.ts)와 그 아래 작업이 주고받는 실행 폴더의 파일 — $OPS_RUN_DIR/{stop,progress,result}.json.
 *
 *   stop.json     — 멈춘 이유. 작업이 끝나기 직전 그 분기에서 쓴다(마지막에 쓴 것이 이긴다). 종료 코드에서 번역하지 않는다.
 *   progress.json — 진척. 작업이 원할 때 쓴다. 실행기가 생존 신호와 함께 기록한다.
 *   result.json   — 워커 엔진 결과(처리 건수·API 호출·상세). 감싸기 아래에서는 runJob 이 job_run 에 직접 쓰지 않고 여기에 남긴다.
 *
 * 셸 작업은 같은 형식을 scripts/ops/ops-stop.sh 의 ops_stop·ops_progress 로 쓴다.
 * $OPS_RUN_DIR 이 없으면(감싸지 않고 손으로 돌림) 아무것도 하지 않는다.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Progress, StopReason } from "./model.ts";

export const STOP_REASONS: readonly StopReason[] = ["completed", "no_work", "skipped", "user_stop", "time_cap", "blocked_external",
  "no_progress", "budget", "lock_busy", "error", "killed", "lost", "unknown"];

export interface StopFile { reason: StopReason; detail?: string; at?: string }
export interface ResultFile { engine?: string; processed?: number; api_calls?: number; error?: string | null; detail?: unknown }

function atomicWrite(dir: string, name: string, value: unknown) {
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${name}.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(value) + "\n");
  renameSync(tmp, join(dir, name));
}
const runDir = () => process.env.OPS_RUN_DIR || "";

export function writeStop(reason: StopReason, detail = "", dir = runDir()) {
  if (dir) atomicWrite(dir, "stop.json", { reason, detail, at: new Date().toISOString() } satisfies StopFile);
}
export function writeProgress(progress: Omit<Progress, "at">, dir = runDir()) {
  if (dir) atomicWrite(dir, "progress.json", { ...progress, at: new Date().toISOString() });
}
export function writeResult(result: ResultFile, dir = runDir()) {
  if (dir) atomicWrite(dir, "result.json", result);
}

function readJson(path: string): unknown {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}
/** 형식이 틀리면 null — 실행기는 그때 이유를 지어내지 않고 unknown 으로 남긴다. */
export function readStop(dir: string): StopFile | null {
  const v = readJson(join(dir, "stop.json")) as Partial<StopFile> | null;
  if (!v || typeof v.reason !== "string" || !STOP_REASONS.includes(v.reason as StopReason)) return null;
  return { reason: v.reason as StopReason, detail: typeof v.detail === "string" ? v.detail.slice(0, 500) : "", at: typeof v.at === "string" ? v.at : undefined };
}
export function readProgress(dir: string): Progress | null {
  const v = readJson(join(dir, "progress.json")) as Record<string, unknown> | null;
  if (!v || typeof v !== "object") return null;
  const num = (x: unknown) => typeof x === "number" && Number.isFinite(x) ? x : undefined;
  const str = (x: unknown) => typeof x === "string" ? x.slice(0, 200) : undefined;
  return { done: num(v.done), total: num(v.total), unit: str(v.unit), last_item: str(v.last_item), at: str(v.at) };
}
export function readResult(dir: string): ResultFile | null {
  const v = readJson(join(dir, "result.json")) as ResultFile | null;
  return v && typeof v === "object" ? v : null;
}
