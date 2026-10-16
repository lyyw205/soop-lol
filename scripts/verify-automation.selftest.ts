/**
 * verify:automation 을 **검사한다** — 통과가 뜻을 가지려면 일부러 넣은 위반을 잡아야 하고,
 * 작업 하나를 정해진 절차대로 지우면 통과해야 한다("빼기 쉽게"가 실제로 성립하는지).
 *
 *   npm run verify:automation   (검사 뒤에 이어서 돈다)
 *
 * 저장소를 건드리지 않도록 임시 복사본에서 돈다. ★ 이 시험도 실제 작업 이름을 되도록 모른다 —
 * 위반은 가짜 작업(probe)에 넣고, 지우기 시나리오는 운영 화면에 묶이지 않은 설치 작업을 골라서 한다.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { loadJobs } from "./ops/jobs.ts";
import { verifyAutomation } from "./verify-automation.ts";

const REPO = join(import.meta.dirname, "..");
const COPY = ["ops", "scripts", "docs", ".claude/skills", "CLAUDE.md", "packages/core/lib/ops", "packages/core/package.json"];

function copy(): string {
  const root = mkdtempSync(join(tmpdir(), "verify-automation-"));
  for (const p of COPY) cpSync(join(REPO, p), join(root, p), { recursive: true, filter: (s) => !s.includes("__pycache__") && !s.includes("node_modules") });
  return root;
}
const write = (root: string, rel: string, text: string) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
const job = (over: Record<string, unknown> = {}) => JSON.stringify({
  id: "probe", title: "시험 작업", group: "ops", install: "default",
  units: ["scripts/systemd/probe.service", "scripts/systemd/probe.timer"], run: "scripts/probe.sh --go", schedule: "매시", record: "runner",
  locks: [], resources: ["disk"], docs: [], remove: ["이 파일과 유닛을 지운다"], ...over,
}, null, 2);
/** 규칙을 지키는 가짜 작업 하나 — 위반은 여기서 한 칸씩 망가뜨린다. */
function addProbe(root: string, over: Record<string, unknown> = {}) {
  write(root, "ops/jobs/probe.json", job(over));
  write(root, "scripts/probe.sh", "#!/bin/bash\nsource scripts/ops/ops-stop.sh\n[[ -n $1 ]] || { ops_stop error 인자; exit 1; }\necho probe\nops_stop completed 끝\nexit 0\n");
  write(root, "scripts/systemd/probe.service", `[Service]\nType=oneshot\nExecStart=${WRAP}probe -- %h/repos/soop-lol/scripts/probe.sh --go\n`);
  write(root, "scripts/systemd/probe.timer", "[Timer]\nOnCalendar=hourly\n");
  sync(root);
}
const WRAP = "%h/.local/node/bin/node %h/repos/soop-lol/scripts/ops/run-job.ts --job ";
/** 등록부를 고친 뒤의 정해진 절차 — 운영 화면이 읽는 생성 파일을 다시 만든다. */
const sync = (root: string) => {
  // 등록부에 형식 오류가 있으면 생성기는 거부한다(그 오류는 검사가 따로 잡는다).
  try { execFileSync(process.execPath, [join(root, "scripts/ops/jobs.ts"), "sync"], { stdio: "ignore" }); } catch { /* 형식 위반 사례 */ }
};
async function errorsOf(root: string, opts = {}) { return (await verifyAutomation(root, opts)).errors; }
const expectError = async (root: string, pattern: RegExp, opts = {}) => {
  const errors = await errorsOf(root, opts);
  assert.ok(errors.some((e) => pattern.test(e)), `잡아야 할 위반을 놓쳤다: ${pattern}\n받은 오류: ${errors.join("\n") || "(없음)"}`);
};
const dryInstall = (root: string, ...args: string[]) =>
  execFileSync("bash", [join(root, "scripts/systemd/install.sh"), "--dry-run", ...args], { encoding: "utf8", env: { ...process.env, HOME: join(root, "home") } });

describe("verify:automation 자가시험", () => {
  test("지금 저장소 복사본과 규칙을 지키는 가짜 작업은 통과한다", async () => {
    const root = copy();
    try {
      assert.deepEqual(await errorsOf(root), []);
      addProbe(root);
      assert.deepEqual(await errorsOf(root), []);
      // 설치기는 등록부에서 목록을 받는다 — 새 작업이 묶음에 바로 들어간다(설치기를 고치지 않았다).
      assert.match(dryInstall(root), /ln -sf .*scripts\/systemd\/probe\.timer/);
      assert.match(dryInstall(root), /enable --now probe\.timer/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  const cases: [string, (root: string) => void, RegExp][] = [
    ["주인 없는 유닛", (r) => write(r, "scripts/systemd/stray.timer", "[Timer]\nOnCalendar=daily\n"), /주인 없는 유닛: scripts\/systemd\/stray\.timer/],
    ["없는 스킬", (r) => addProbe(r, { skills: ["no-such-skill"] }), /스킬이 없다 — \.claude\/skills\/no-such-skill/],
    ["없는 문서", (r) => addProbe(r, { docs: ["docs/NO-SUCH.md"] }), /문서가 없다 — docs\/NO-SUCH\.md/],
    ["id 와 파일 이름이 다름", (r) => addProbe(r, { id: "probe-x" }), /id\(probe-x\) 가 파일 이름과 다르다/],
    ["모르는 칸", (r) => addProbe(r, { exit_codes: { 3: "user_stop" } }), /모르는 칸 "exit_codes"/],
    ["유닛과 run 이 어긋남", (r) => addProbe(r, { run: "scripts/probe.sh --other" }), /probe\.service 의 ExecStart 가 등록부 run 과 다르다/],
    ["run 이 ExecStart 의 일부만 적음", (r) => addProbe(r, { run: "scripts/probe.sh --g" }), /probe\.service 의 ExecStart 가 등록부 run 과 다르다/],
    ["타이머의 짝 서비스가 다른 작업에 있음", (r) => addProbe(r, { units: ["scripts/systemd/probe.timer"] }), /probe\.timer 이 깨우는 probe\.service 이 이 작업의 units 에 없다/],
    ["실행기가 스킬을 안 부름", (r) => { write(r, ".claude/skills/probe-skill/SKILL.md", "---\nname: probe-skill\n---\n"); addProbe(r, { skills: ["probe-skill"] }); }, /실행기 scripts\/probe\.sh 가 스킬 probe-skill 를 부르지 않는다/],
    ["설치 작업인데 깨우는 유닛이 없음", (r) => addProbe(r, { units: ["scripts/systemd/probe.service"] }), /깨우는 유닛\(\.timer·\.path\)이 없다/],
    ["설치기 하드코딩", (r) => appendFileSync(join(r, "scripts/systemd/install.sh"), "\nDATA=(soop-rank)\n"), /설치기에 유닛 이름이 직접 적혀 있다: soop-rank/],
    ["기록하는 작업인데 감싸지 않음", (r) => { addProbe(r); write(r, "scripts/systemd/probe.service", "[Service]\nExecStart=%h/repos/soop-lol/scripts/probe.sh --go\n"); }, /probe\.service 이 감싸는 실행기를 거치지 않는다/],
    ["다른 작업 id 로 기록", (r) => { addProbe(r); write(r, "scripts/systemd/probe.service", `[Service]\nExecStart=${WRAP}lol-rank -- %h/repos/soop-lol/scripts/probe.sh --go\n`); }, /다른 작업 id\(lol-rank\)로 기록한다/],
    ["record none 인데 감쌈", (r) => { addProbe(r, { record: "none" }); }, /record: none 인데 probe\.service 이 감싸는 실행기를 거친다/],
    ["runner 셸의 종료 지점에 이유가 없음", (r) => { addProbe(r); write(r, "scripts/probe.sh", "#!/bin/bash\necho probe\nexit 3\n"); }, /scripts\/probe\.sh:3 종료 지점에 멈춘 이유\(ops_stop\)가 없다/],
    ["등록부를 고치고 생성 파일을 안 만듦", (r) => { addProbe(r); write(r, "ops/jobs/probe.json", job({ title: "이름만 바꿈" })); }, /jobs\.generated\.ts 가 등록부와 다르다/],
    ["같은 옛 기록 이름을 두 작업이 가짐", (r) => addProbe(r, { job_run_names: ["engine_a_rank"] }), /job_run_names engine_a_rank 를 .* 도 적었다/],
  ];
  for (const [name, inject, pattern] of cases) test(`잡는다: ${name}`, async () => {
    const root = copy();
    try { inject(root); await expectError(root, pattern); } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("잡는다(--host): 등록부에 없는 설치 링크 · 깨진 링크 · 저장소 사본", async () => {
    const root = copy();
    try {
      const host = join(root, "home");
      mkdirSync(host, { recursive: true });
      write(root, "scripts/systemd/gone.timer", "[Timer]\n");
      symlinkSync(join(root, "scripts/systemd/gone.timer"), join(host, "gone.timer"));
      symlinkSync(join(root, "scripts/systemd/deleted.service"), join(host, "deleted.service"));
      const { jobs } = loadJobs(root);
      const someUnit = basename(jobs.find((j) => j.units.length)!.units[0]!);
      writeFileSync(join(host, someUnit), "[Unit]\n");
      const errors = await errorsOf(root, { host: true, hostDir: host });
      assert.ok(errors.some((e) => /설치된 유닛 gone\.timer 가 등록부에 없다/.test(e)), errors.join("\n"));
      assert.ok(errors.some((e) => /설치 링크가 깨졌다: .*deleted\.service/.test(e)), errors.join("\n"));
      assert.ok(errors.some((e) => new RegExp(`설치된 ${someUnit.replace(".", "\\.")} 가 저장소 링크가 아니라 사본이다`).test(e)), errors.join("\n"));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("작업 하나를 remove 절차대로 지우면 통과하고 설치기에서도 빠진다", async () => {
    const root = copy();
    try {
      // 설치 작업 하나를 고른다 — 지우는 절차: 등록부·유닛 삭제 → 생성 파일 다시 만들기(remove 의 마지막 단계).
      const { jobs } = loadJobs(root);
      const victim = jobs.find((j) => j.units.length && !(j.job_run_names ?? []).length)!;
      assert.ok(victim, "지울 작업이 없다");
      assert.ok(victim.remove.length > 0);
      const bundle = victim.install;
      const before = dryInstall(root, "--bundle", bundle);
      for (const u of victim.units) assert.ok(before.includes(basename(u)));
      rmSync(join(root, "ops/jobs", `${victim.id}.json`));
      for (const u of victim.units) rmSync(join(root, u));
      sync(root);
      assert.deepEqual(await errorsOf(root), []);
      let after = "";
      try { after = dryInstall(root, "--bundle", bundle); } catch { /* 묶음이 비면 설치기는 "설치할 유닛이 없다"로 끝난다 */ }
      for (const u of victim.units) assert.ok(!after.includes(basename(u)), `${basename(u)} 가 아직 설치 계획에 있다`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
