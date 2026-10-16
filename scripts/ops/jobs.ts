/**
 * 자동화 등록부(ops/jobs/*.json) — 읽기·형식 검사·설치 계획.
 *
 *   node scripts/ops/jobs.ts list                          # 작업·설치 묶음 목록
 *   node scripts/ops/jobs.ts plan --bundle default,ck-auto # 설치기가 읽는 계획(hook·link·enable 줄)
 *   node scripts/ops/jobs.ts plan --job ops-office
 *   node scripts/ops/jobs.ts status-units                  # --status 가 볼 타이머·경로 유닛
 *   node scripts/ops/jobs.ts sync [--check]                # 운영 화면이 읽는 생성 파일(packages/core/lib/ops/jobs.generated.ts)
 *
 * 작업 하나 = 파일 하나. 이 파일과 그 유닛을 지우면 설치기·검사에서 함께 빠진다(목록을 따로 고치지 않는다).
 * 등록부는 **이미 있는 유닛을 설명**한다 — 유닛을 만들거나 바꾸지 않는다(docs/AUTOMATION-REDESIGN-PLAN.md §5.1).
 * 정합성 검사는 scripts/verify-automation.ts(npm run verify:automation).
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { GROUPS, INSTALLS, RECORDS, RESOURCES, ROOM_IDS, type RegistryJob } from "../../packages/core/lib/ops/registry.ts";

export { GROUPS, INSTALLS, RESOURCES };
export type Job = RegistryJob;

const KEYS = new Set<string>(["id", "title", "display_group", "group", "install", "install_hook", "units", "run", "schedule", "record", "office",
  "locks", "resources", "skills", "stop_files", "publication", "critical", "job_run_names", "docs", "notes", "remove"]);

export const jobsDir = (root: string) => join(root, "ops", "jobs");

/** 등록부를 읽는다. 형식 오류는 던지지 않고 모아서 돌려준다 — 검사가 한 번에 전부 보여 주게. */
export function loadJobs(root: string): { jobs: Job[]; errors: string[] } {
  const errors: string[] = [];
  const jobs: Job[] = [];
  const dir = jobsDir(root);
  if (!existsSync(dir)) return { jobs, errors: [`등록부 폴더가 없다: ops/jobs`] };
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const at = `ops/jobs/${file}`;
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(join(dir, file), "utf8")); } catch (e) { errors.push(`${at}: JSON 이 아니다 — ${(e as Error).message}`); continue; }
    const j = raw as Record<string, unknown>;
    const bad = (m: string) => errors.push(`${at}: ${m}`);
    for (const k of Object.keys(j)) if (!KEYS.has(k)) bad(`모르는 칸 "${k}"`);
    const str = (k: string, required = true) => {
      if (j[k] === undefined) { if (required) bad(`"${k}" 가 없다`); return; }
      if (typeof j[k] !== "string" || !(j[k] as string).trim()) bad(`"${k}" 는 빈 값이 아닌 문자열이다`);
    };
    const arr = (k: string, required = true) => {
      if (j[k] === undefined) { if (required) bad(`"${k}" 가 없다`); return; }
      if (!Array.isArray(j[k]) || (j[k] as unknown[]).some((x) => typeof x !== "string" || !x.trim())) bad(`"${k}" 는 문자열 배열이다`);
    };
    for (const k of ["id", "title", "group", "install", "run", "schedule", "record"]) str(k);
    for (const k of ["display_group", "install_hook", "publication", "notes"]) str(k, false);
    for (const k of ["units", "locks", "resources", "docs", "remove"]) arr(k);
    for (const k of ["skills", "stop_files", "job_run_names"]) arr(k, false);
    if (j.critical !== undefined && typeof j.critical !== "boolean") bad(`"critical" 은 true/false 다`);
    if (typeof j.id === "string" && `${j.id}.json` !== file) bad(`id(${j.id}) 가 파일 이름과 다르다`);
    if (typeof j.group === "string" && !(GROUPS as readonly string[]).includes(j.group)) bad(`group 은 ${GROUPS.join("·")} 중 하나다 — ${j.group}`);
    if (typeof j.install === "string" && !(INSTALLS as readonly string[]).includes(j.install)) bad(`install 은 ${INSTALLS.join("·")} 중 하나다 — ${j.install}`);
    if (typeof j.record === "string" && !(RECORDS as readonly string[]).includes(j.record)) bad(`record 는 ${RECORDS.join("·")} 중 하나다 — ${j.record}`);
    if (j.office !== undefined) {
      const o = j.office as Record<string, unknown>;
      if (!o || typeof o !== "object") bad(`"office" 는 객체다`);
      else {
        for (const k of Object.keys(o)) if (!["room", "cadence", "max_age_min", "max_run_min"].includes(k)) bad(`office 의 모르는 칸 "${k}"`);
        if (!(ROOM_IDS as readonly string[]).includes(o.room as string)) bad(`office.room 은 ${ROOM_IDS.join("·")} 중 하나다 — ${o.room}`);
        if (typeof o.cadence !== "string" || !o.cadence) bad(`office.cadence 가 없다`);
        if (!Number.isInteger(o.max_run_min) || (o.max_run_min as number) <= 0) bad(`office.max_run_min 은 양의 정수(분)다`);
        if (o.max_age_min !== undefined && (!Number.isInteger(o.max_age_min) || (o.max_age_min as number) <= 0)) bad(`office.max_age_min 은 양의 정수(분)다`);
      }
    }
    for (const r of Array.isArray(j.resources) ? j.resources : []) if (!(RESOURCES as readonly string[]).includes(r as string)) bad(`모르는 자원 "${r}" — ${RESOURCES.join("·")}`);
    if (Array.isArray(j.remove) && j.remove.length === 0) bad(`"remove" 가 비었다 — 지우는 절차를 적는다`);
    jobs.push(j as unknown as Job);
  }
  const seen = new Map<string, string>();
  for (const job of jobs) for (const u of job.units ?? []) {
    const name = basename(u);
    if (seen.has(name)) errors.push(`유닛 ${name} 을 두 작업(${seen.get(name)}, ${job.id})이 같이 적었다`);
    seen.set(name, job.id);
  }
  return { jobs, errors };
}

const installable = (j: Job) => j.install !== "manual" && j.install !== "none";
const triggers = (j: Job) => j.units.map((u) => basename(u)).filter((n) => n.endsWith(".timer") || n.endsWith(".path"));

/** 설치 계획 — 설치기(scripts/systemd/install.sh)가 이 줄들대로만 움직인다. */
export function installPlan(jobs: Job[], pick: { bundles?: string[]; ids?: string[] }): string[] {
  const chosen = jobs.filter((j) => installable(j) && ((pick.bundles ?? []).includes(j.install) || (pick.ids ?? []).includes(j.id)));
  for (const b of pick.bundles ?? []) {
    if (!(INSTALLS as readonly string[]).includes(b) || b === "manual" || b === "none") throw new Error(`설치 묶음이 아니다: ${b} — ${INSTALLS.filter((x) => x !== "manual" && x !== "none").join("·")}`);
  }
  for (const id of pick.ids ?? []) {
    const j = jobs.find((x) => x.id === id);
    if (!j) throw new Error(`등록부에 없는 작업: ${id}`);
    if (!installable(j)) throw new Error(`${id} 는 설치하지 않는 작업이다(install: ${j.install})`);
  }
  const lines: string[] = [];
  for (const hook of [...new Set(chosen.flatMap((j) => j.install_hook ? [j.install_hook] : []))]) lines.push(`hook\t${hook}`);
  for (const j of chosen) for (const u of j.units) lines.push(`link\t${u}`);
  for (const j of chosen) for (const t of triggers(j)) lines.push(`enable\t${t}`);
  return lines;
}

/** --status 가 볼 행: 작업 id · 깨우는 유닛(타이머·경로) · 서비스 유닛. */
export function statusUnits(jobs: Job[]): string[] {
  return jobs.filter(installable).flatMap((j) => triggers(j).map((t) => {
    const service = j.units.map((u) => basename(u)).find((n) => n.endsWith(".service") && (n.slice(0, -8) === t.replace(/\.(timer|path)$/, "")))
      ?? j.units.map((u) => basename(u)).find((n) => n.endsWith(".service")) ?? "";
    return `${j.id}\t${t}\t${service}`;
  }));
}

export const GENERATED = join("packages", "core", "lib", "ops", "jobs.generated.ts");
/** 운영 화면이 읽는 생성 파일 내용 — 지우는 절차·문서 같은 사람용 칸은 뺀다. */
export function generated(jobs: Job[]): string {
  const keep = jobs.map(({ docs: _d, notes: _n, remove: _r, ...rest }) => rest);
  return `/** 생성 파일 — 손으로 고치지 않는다. 원본은 ops/jobs/*.json, 생성은 \`node scripts/ops/jobs.ts sync\`(verify:automation 이 어긋남을 잡는다). */
import type { RegistryJob } from "./registry.ts";

export const REGISTRY: Omit<RegistryJob, "docs" | "notes" | "remove">[] = ${JSON.stringify(keep, null, 2)};
`;
}

function main() {
  const root = join(import.meta.dirname, "..", "..");
  const [command, ...args] = process.argv.slice(2);
  const { jobs, errors } = loadJobs(root);
  if (errors.length) { console.error(`등록부 오류 ${errors.length}건 — npm run verify:automation\n  ${errors.join("\n  ")}`); process.exit(2); }
  const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1]!.split(",").filter(Boolean) : []; };
  if (command === "plan") {
    try { console.log(installPlan(jobs, { bundles: opt("--bundle"), ids: opt("--job") }).join("\n")); }
    catch (e) { console.error((e as Error).message); process.exit(2); }
  } else if (command === "status-units") {
    console.log(statusUnits(jobs).join("\n"));
  } else if (command === "sync") {
    const path = join(root, GENERATED), text = generated(jobs);
    const current = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (args.includes("--check")) { if (current !== text) { console.error(`${GENERATED} 가 등록부와 다르다 — node scripts/ops/jobs.ts sync`); process.exit(1); } }
    else if (current !== text) { writeFileSync(path, text); console.log(`${GENERATED} 갱신(작업 ${jobs.length}개)`); }
  } else if (command === "list") {
    for (const b of INSTALLS) {
      const of = jobs.filter((j) => j.install === b);
      if (of.length) console.log(`${b}\n${of.map((j) => `  ${j.id.padEnd(22)} ${j.title}`).join("\n")}`);
    }
  } else {
    console.error("사용법: node scripts/ops/jobs.ts list | plan --bundle <묶음,...> [--job <id,...>] | status-units | sync [--check]");
    process.exit(2);
  }
}
if (import.meta.main) main();
