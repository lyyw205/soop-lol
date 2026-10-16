/**
 * 자동화 등록부(ops/jobs/*.json)가 실제와 맞는지 검사한다 — 규칙을 문서가 아니라 검사로 강제한다(verify:modules 와 같은 방식).
 *
 *   npm run verify:automation            # 저장소만 본다(CI·다른 PC 에서도 같은 결과)
 *   npm run verify:automation -- --host  # + 이 PC 에 설치된 사용자 systemd 유닛과 대조
 *
 * 실패시키는 것:
 *   - 등록부 형식 오류, 없는 유닛·문서·스킬·실행 파일·준비 명령
 *   - 주인 없는 유닛(scripts/systemd 의 유닛 파일이 어느 작업에도 없음), 타이머·경로에 짝 서비스가 없음
 *   - 유닛의 ExecStart 와 등록부 run 이 다름(둘 중 하나만 고친 흔적)
 *   - 조사 작업의 실행기가 등록부 skills 를 부르지 않음
 *   - 기록하는 작업(record runner·exit_code)의 서비스가 감싸는 실행기(scripts/ops/run-job.ts --job <id>)를 거치지 않음, record none 인데 감쌈
 *   - record runner 실행기 셸의 종료(exit) 지점에 멈춘 이유(ops_stop)가 없음 — 의도한 예외는 그 줄에 "# ops:" 로 적는다
 *   - 운영 화면이 읽는 생성 파일(packages/core/lib/ops/jobs.generated.ts)이 등록부와 다름
 *   - 설치기(scripts/systemd/install.sh)에 유닛 이름을 직접 적음 — 설치 목록은 등록부에서만 온다
 *   - (--host) 저장소 유닛을 가리키는데 등록부에 없는 설치 링크, 깨진 링크
 * 자가시험: scripts/verify-automation.selftest.ts(임시 복사본에 위반을 넣어 잡는지 본다).
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

import { GENERATED, generated, loadJobs, type Job } from "./ops/jobs.ts";

const UNIT_EXT = /\.(service|timer|path)$/;

export async function verifyAutomation(root: string, opts: { host?: boolean; hostDir?: string } = {}) {
  const errors: string[] = [];
  const info: string[] = [];
  const { jobs, errors: formatErrors } = loadJobs(root);
  errors.push(...formatErrors);
  const at = (j: Job) => `ops/jobs/${j.id}.json`;
  const has = (rel: string) => existsSync(join(root, rel));
  const installable = (j: Job) => j.install !== "manual" && j.install !== "none";

  for (const j of jobs) {
    for (const u of j.units ?? []) if (!has(u)) errors.push(`${at(j)}: 유닛 파일이 없다 — ${u}`);
    for (const d of j.docs ?? []) if (!has(d)) errors.push(`${at(j)}: 문서가 없다 — ${d}`);
    for (const s of j.skills ?? []) if (!has(`.claude/skills/${s}/SKILL.md`)) errors.push(`${at(j)}: 스킬이 없다 — .claude/skills/${s}/SKILL.md`);
    // run·준비 명령 속 저장소 경로(scripts/…)는 실제로 있어야 한다.
    for (const cmd of [j.run, j.install_hook].filter((x): x is string => typeof x === "string")) {
      for (const p of cmd.split(/\s+/).filter((t) => /^scripts\/\S+\.\w+$/.test(t))) if (!has(p)) errors.push(`${at(j)}: 명령의 파일이 없다 — ${p}`);
    }
    const names = (j.units ?? []).map((u) => basename(u));
    if (installable(j) && !names.some((n) => /\.(timer|path)$/.test(n))) errors.push(`${at(j)}: 설치 작업(install: ${j.install})인데 깨우는 유닛(.timer·.path)이 없다`);
    if (!installable(j) && names.length) errors.push(`${at(j)}: install: ${j.install} 인데 유닛이 있다 — 설치기가 영영 잇지 않는다`);
    for (const u of j.units ?? []) {
      if (!has(u)) continue;
      const name = basename(u);
      const text = readFileSync(join(root, u), "utf8");
      if (/\.(timer|path)$/.test(name)) {
        // 타이머·경로가 깨우는 서비스: Unit= 이 있으면 그것, 없으면 같은 이름 .service. 같은 작업에 있어야 한다.
        const target = text.match(/^Unit=(\S+)/m)?.[1] ?? name.replace(UNIT_EXT, ".service");
        if (!names.includes(target)) errors.push(`${at(j)}: ${name} 이 깨우는 ${target} 이 이 작업의 units 에 없다`);
      }
      if (name.endsWith(".service")) {
        const exec = text.match(/^ExecStart=(.*)$/m)?.[1];
        if (!exec) { errors.push(`${at(j)}: ${name} 에 ExecStart 가 없다`); continue; }
        const wrapper = new RegExp(`^%h/\\.local/node/bin/node %h/repos/soop-lol/scripts/ops/run-job\\.ts --job (\\S+) -- `).exec(exec);
        if (j.record === "none" && wrapper) errors.push(`${at(j)}: record: none 인데 ${name} 이 감싸는 실행기를 거친다`);
        if (j.record !== "none" && !wrapper) errors.push(`${at(j)}: ${name} 이 감싸는 실행기를 거치지 않는다 — ExecStart=%h/.local/node/bin/node %h/repos/soop-lol/scripts/ops/run-job.ts --job ${j.id} -- …`);
        if (wrapper && wrapper[1] !== j.id) errors.push(`${at(j)}: ${name} 이 다른 작업 id(${wrapper[1]})로 기록한다`);
        const norm = exec.replaceAll("%h/repos/soop-lol/", "").replace(/\s+/g, " ");
        const want = j.run.replace(/\s+/g, " ").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        // 앞뒤가 공백·줄 끝이어야 한다 — "rank" 자리에 "ran" 을 적어도 부분 문자열로 통과하지 않게.
        if (!new RegExp(`(^|\\s)${want}(\\s|$)`).test(norm)) errors.push(`${at(j)}: ${name} 의 ExecStart 가 등록부 run 과 다르다\n      run:       ${j.run}\n      ExecStart: ${exec}`);
      }
    }
    // 조사 작업: 실행기(run 의 첫 스크립트)가 등록부의 스킬을 실제로 부른다.
    const runner = j.run.split(/\s+/).find((t) => /^scripts\/\S+\.(sh|ts|mjs)$/.test(t));
    if (runner && has(runner)) {
      const src = readFileSync(join(root, runner), "utf8");
      for (const s of j.skills ?? []) if (!src.includes(s)) errors.push(`${at(j)}: 실행기 ${runner} 가 스킬 ${s} 를 부르지 않는다`);
      if (j.record === "runner" && runner.endsWith(".sh")) for (const miss of exitsWithoutReason(src)) errors.push(`${at(j)}: ${runner}:${miss.line} 종료 지점에 멈춘 이유(ops_stop)가 없다 — ${miss.text}`);
    }
    // 워커 명령은 runJob 이 이유를 남긴다(apps/worker/src/job.ts). 그 밖의 실행기는 셸이어야 검사할 수 있다.
    if (j.record === "runner" && !(runner?.endsWith(".sh")) && !/(^|\s)worker -- /.test(j.run)) errors.push(`${at(j)}: record: runner 인데 이유를 남기는 실행기를 확인할 수 없다(셸 또는 워커 명령)`);
  }

  // 주인 없는 유닛 — 지운 작업의 유닛이 남거나, 등록 없이 유닛만 추가된 경우.
  const owned = new Set(jobs.flatMap((j) => j.units ?? []));
  const unitDir = join(root, "scripts", "systemd");
  for (const f of existsSync(unitDir) ? readdirSync(unitDir).filter((f) => UNIT_EXT.test(f)) : []) {
    if (!owned.has(`scripts/systemd/${f}`)) errors.push(`주인 없는 유닛: scripts/systemd/${f} — ops/jobs 의 어느 작업에도 없다(지운 작업의 흔적이거나 등록이 빠졌다)`);
  }

  // 운영 화면은 생성 파일을 읽는다 — 등록부를 고치고 sync 를 안 했으면 화면이 옛 목록을 보인다.
  if (!formatErrors.length) {
    const path = join(root, GENERATED);
    if (!existsSync(path) || readFileSync(path, "utf8") !== generated(jobs)) errors.push(`${GENERATED} 가 등록부와 다르다 — node scripts/ops/jobs.ts sync`);
  }
  const legacy = new Map<string, string>();
  for (const j of jobs) for (const n of j.job_run_names ?? []) {
    if (legacy.has(n)) errors.push(`${at(j)}: job_run_names ${n} 를 ${legacy.get(n)} 도 적었다 — 한 기록이 두 작업 이력으로 보인다`);
    legacy.set(n, j.id);
  }
  const unseen = jobs.filter((j) => installable(j) && !j.office).map((j) => j.id);
  if (unseen.length) info.push(`운영 화면 카드가 없는 설치 작업: ${unseen.join(", ")} (office 칸 — 의도면 그대로)`);

  // 설치기는 등록부에서만 목록을 받는다 — 주석이 아닌 줄에 유닛 이름이 있으면 하드코딩이다.
  const installer = join(root, "scripts", "systemd", "install.sh");
  if (existsSync(installer)) {
    const code = readFileSync(installer, "utf8").split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
    const unitNames = [...owned].map((u) => basename(u));
    const bare = [...new Set(unitNames.map((n) => n.replace(UNIT_EXT, "")))].filter((n) => /^(soop|t7)-/.test(n));
    for (const n of [...unitNames, ...bare]) if (new RegExp(`(^|[^\\w-])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`).test(code)) {
      errors.push(`설치기에 유닛 이름이 직접 적혀 있다: ${n} — scripts/systemd/install.sh 는 등록부(scripts/ops/jobs.ts plan)만 읽는다`);
    }
  }

  if (opts.host) {
    const dir = opts.hostDir ?? join(homedir(), ".config", "systemd", "user");
    const repoUnits = resolve(root, "scripts", "systemd");
    const known = new Set(jobs.flatMap((j) => (j.units ?? []).map((u) => basename(u))));
    for (const f of existsSync(dir) ? readdirSync(dir).filter((f) => UNIT_EXT.test(f)) : []) {
      const p = join(dir, f);
      if (lstatSync(p).isSymbolicLink()) {
        const raw = readlinkSync(p);
        const target = isAbsolute(raw) ? raw : resolve(dir, raw);
        if (!target.startsWith(repoUnits + "/")) continue;
        if (!existsSync(target)) errors.push(`설치 링크가 깨졌다: ${p} → ${target}(지운 작업이면 install.sh --disable-job 뒤 링크를 지운다)`);
        else if (!known.has(basename(target))) errors.push(`설치된 유닛 ${f} 가 등록부에 없다`);
      } else if (known.has(f)) {
        errors.push(`설치된 ${f} 가 저장소 링크가 아니라 사본이다 — 저장소 파일을 고쳐도 반영되지 않는다(install.sh 로 다시 잇는다)`);
      }
    }
    for (const j of jobs.filter(installable)) {
      const trig = (j.units ?? []).map((u) => basename(u)).filter((n) => /\.(timer|path)$/.test(n));
      const state = trig.map((t) => { try { return execFileSync("systemctl", ["--user", "is-enabled", t], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return "not-found"; } });
      const on = state.every((s) => s === "enabled");
      info.push(`${on ? "설치됨  " : "미설치  "} ${j.id.padEnd(22)} (묶음 ${j.install})${on ? "" : ` — ${trig.map((t, i) => `${t}: ${state[i]}`).join(", ")}`}`);
    }
  }
  return { jobs, errors, info };
}

/** 셸에서 주석이 아닌 exit 줄 중 같은 줄·바로 앞 줄에 ops_stop 이 없고 "# ops:" 예외 표시도 없는 것. */
export function exitsWithoutReason(src: string): { line: number; text: string }[] {
  const lines = src.split("\n"), out: { line: number; text: string }[] = [];
  let prev = "";
  lines.forEach((l, i) => {
    if (/^\s*#/.test(l) || !l.trim()) return;
    if (/(^|[\s;&|{(])exit(\s|;|$)/.test(l) && !l.includes("ops_stop") && !prev.includes("ops_stop") && !l.includes("# ops:")) out.push({ line: i + 1, text: l.trim().slice(0, 100) });
    prev = l;
  });
  return out;
}

async function main() {
  const host = process.argv.includes("--host");
  const root = join(import.meta.dirname, "..");
  const { jobs, errors, info } = await verifyAutomation(root, { host });
  for (const line of info) console.log(`  · ${line}`);
  if (errors.length) {
    console.error(`\n✗ verify:automation — ${errors.length}건\n  ${errors.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`✓ verify:automation — 작업 ${jobs.length}개 · 유닛 ${jobs.reduce((n, j) => n + j.units.length, 0)}개 · 주인 없는 유닛 0${host ? " · 이 PC 설치 대조 포함" : ""}`);
}
if (import.meta.main) await main();
