/** Isolated UI QA: localhost server, disposable snapshots, no production DB or scheduler mutations. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { freePort } from "./lib/disposable-postgres.ts";
import { JOBS, evaluateJob, type Snapshot, type Unit } from "../packages/core/lib/ops/model.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), "office-browser-")), port = await freePort();
const dist = `.next-office-qa-${process.pid}`;
const at = new Date().toISOString();
const unit: Unit = { loaded: true, enabled: true, active: true, running: false, failed: false,
  startedAt: at, finishedAt: at, nextAt: new Date(Date.now() + 3600_000).toISOString() };
let fixture: Snapshot = { version: 1, at, mode: "scheduled", jobs: JOBS.map(j => evaluateJob(j,
  { id: j.id, job: j.id, startedAt: at, finishedAt: at, state: j.id === "fco-club" ? "running" : "ok", processed: 12, error: null }, unit, false, Date.now())),
  alerts: [{ id: "test:failure", room: "research", title: "테스트 조사 지연", detail: "검증 전용 알림입니다.", severity: "warning" }],
  incidents: [{ id: "test:failure", room: "research", title: "테스트 조사 지연", detail: "검증 전용", severity: "warning", openedAt: at, resolvedAt: null }],
  recent: [{ id: "test1", job: JOBS[0].id, startedAt: at, finishedAt: at, state: "ok", processed: 12, error: null }],
  completed24h: 24, processed24h: 288, sources: { database: true, systemd: true, local: true },
  queue: { pending: 3, owned: 1, deferred: 2, updatedAt: at }, backfill: { requests: 3, from: "2026-09-01", to: "2026-10-01", latestAt: at },
  health: { at, verdict: "ok", totalBytes: 123_000_000, reasons: [] } };
const persist = () => writeFile(join(scratch, "ops/office/snapshot.json"), JSON.stringify(fixture));
await mkdir(join(scratch, "ops/office"), { recursive: true }); await persist();
const app = spawn(process.execPath, [join(root, "node_modules/next/dist/bin/next"), "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
  cwd: join(root, "apps/web"), stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, NEXT_DIST_DIR: dist, ADMIN_AUTH_MODE: "basic", ADMIN_USER: "office-test", ADMIN_PASSWORD: "disposable-office-test",
    OPS_OUT_ROOT: scratch, CK_OUT_ROOT: scratch, DATABASE_URL: "postgres://invalid:invalid@127.0.0.1:1/unused" },
});
let log = ""; app.stdout?.on("data", chunk => { log = (log + chunk).slice(-8000); }); app.stderr?.on("data", chunk => { log = (log + chunk).slice(-8000); });
const browser = await chromium.launch();
try {
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (app.exitCode !== null) throw new Error(log);
    try { const response = await fetch(`${base}/admin/office/status`); if (response.status === 401) break; } catch { /* Starting. */ }
    if (i === 99) throw new Error(`Server failed to start: ${log}`);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.equal((await fetch(`${base}/admin/office/status`)).status, 401, "status endpoint must be protected");
  const context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, httpCredentials: { username: "office-test", password: "disposable-office-test" } });
  const page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto(`${base}/admin/office`);
  await page.locator(".of-connection").filter({ hasText: "자동 관측 중" }).waitFor();
  assert.match(await page.locator(".of-game-resources").innerText(), /288/);
  assert.equal(await page.locator(".of-room").count(), 6);
  assert.equal(await page.locator(".of-agent-character").count(), JOBS.length);
  assert.ok(await page.locator(".of-world-speech").count() <= 2, "ambient speech is limited to two useful signals");
  assert.equal(await page.locator(".of-world-speech p:nth-child(2)").count(),0,"overview uses brief one-sentence speech");
  assert.equal(await page.locator(".of-equipment").count(), 0, "world is the default view");
  await page.getByRole("button",{name:"스케줄러 일정표",exact:true}).click();
  await page.getByRole("dialog",{name:"스케줄러 일정표",exact:true}).waitFor();
  await page.getByRole("button",{name:"향후 24시간",exact:true}).click();
  assert.ok(await page.locator(".of-scheduled-event[data-estimated=false]").count()>0,"observed next runs are shown");
  assert.ok(await page.locator(".of-scheduled-event[data-estimated=true]").count()>0,"recurrences are explicitly estimates");
  await page.getByLabel("일정 부서 필터").selectOption("fc");
  assert.ok((await page.locator(".of-scheduled-event small").allTextContents()).every(t=>t.includes("FC 온라인")));
  await page.getByLabel("반복 예상 포함").uncheck();
  assert.equal(await page.locator(".of-scheduled-event[data-estimated=true]").count(),0);
  await page.locator(".of-scheduled-event").first().click();
  assert.equal(await page.locator(".of-scheduler").count(),0);
  assert.equal(await page.locator(".of-equipment").count(),1,"schedule opens the real job equipment panel");
  await page.keyboard.press("Escape");
  await page.getByRole("button",{name:"스케줄러 일정표",exact:true}).click();
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".of-scheduler").count(),0);
  assert.match(await page.locator(":focus").getAttribute("aria-label")??"",/스케줄러 일정표/);

  const arm=page.locator(".of-bot.is-working .of-robot-arm.left").first();
  assert.equal(await arm.evaluate(el=>getComputedStyle(el).animationName), "of-type-left");
  const pose=await arm.evaluate(el=>getComputedStyle(el).transform);
  await page.waitForTimeout(170);
  assert.notEqual(await arm.evaluate(el=>getComputedStyle(el).transform),pose,"working arms physically move");
  const boxes=await page.locator(".of-world-speech").evaluateAll(nodes=>nodes.map(n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};}));
  for(let i=0;i<boxes.length;i++) for(let j=i+1;j<boxes.length;j++){const a=boxes[i],b=boxes[j];assert.ok(a.x+a.w<=b.x||b.x+b.w<=a.x||a.y+a.h<=b.y||b.y+b.h<=a.y,"speech must not overlap");}
  const worker=page.locator('.of-agent-character[data-job="fco-club"]');
  assert.equal(await worker.getAttribute("data-location"),"desk");
  fixture={...fixture,jobs:fixture.jobs.map(j=>j.id==="fco-club"?{...j,state:"healthy",lastSuccessAt:new Date().toISOString()}:j)};await persist();
  await page.getByRole("button",{name:"상태 새로고침"}).click();
  await page.waitForFunction(()=>document.querySelector('[data-job="fco-club"].of-agent-character')?.getAttribute("data-walking")==="true");
  const walkingPose=await worker.evaluate(el=>getComputedStyle(el).transform);
  await page.waitForTimeout(300);
  assert.notEqual(await worker.evaluate(el=>getComputedStyle(el).transform),walkingPose,"worker actually walks across the room");
  await page.waitForFunction(()=>document.querySelector('[data-job="fco-club"].of-agent-character')?.getAttribute("data-walking")==="false");
  assert.equal(await worker.getAttribute("data-location"),"lounge");
  await worker.hover();
  await page.locator('.of-world-speech[data-job="fco-club"]').waitFor();
  assert.equal(await page.locator(".of-world-speech").count(),1,"hover gives one speaker the floor");
  assert.match(await page.locator('.of-world-speech[data-job="fco-club"]').innerText(),/마쳤어요/);
  fixture={...fixture,jobs:fixture.jobs.map(j=>j.id==="fco-club"?{...j,state:"working"}:j)};await persist();
  await page.getByRole("button",{name:"상태 새로고침"}).click();
  await page.waitForFunction(()=>document.querySelector('[data-job="fco-club"].of-agent-character')?.getAttribute("data-walking")==="true");
  await page.waitForFunction(()=>document.querySelector('[data-job="fco-club"].of-agent-character')?.getAttribute("data-walking")==="false");
  assert.equal(await worker.getAttribute("data-location"),"desk");
  await page.locator(".of-agent-character").first().focus(); await page.keyboard.press("Enter");
  assert.match(await page.locator(".of-equipment").innerText(), /마지막 성공/);
  await page.getByRole("button", {name:"최근 행동",exact:true}).click();
  assert.match(await page.locator(".of-equipment-content").innerText(), /12건 처리 완료/);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".of-equipment").count(),0);
  const initialCamera=await page.locator(".of-scene").getAttribute("viewBox");
  await page.locator(".of-hotbar").getByRole("button", { name: "자동 조사" }).click();
  assert.notEqual(await page.locator(".of-scene").getAttribute("viewBox"),initialCamera);
  await page.locator(".of-hotbar").getByRole("button", { name: "자동 조사" }).click();
  assert.equal(await page.locator(".of-scene").getAttribute("viewBox"),initialCamera,"repeat department selection returns to overview");
  await page.getByRole("button",{name:"지도 확대",exact:true}).click();
  await page.getByRole("button",{name:/전체 사무실로 돌아가기/}).click();
  assert.equal(await page.locator(".of-scene").getAttribute("viewBox"),initialCamera);
  await page.getByRole("button",{name:"지도 확대",exact:true}).click();
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".of-scene").getAttribute("viewBox"),initialCamera);
  const scroll=await page.evaluate(()=>scrollY);
  await page.locator(".of-world-surface").hover({position:{x:10,y:150}});await page.mouse.wheel(0,-100);await page.waitForTimeout(80);
  assert.notEqual(await page.locator(".of-scene").getAttribute("viewBox"),initialCamera);
  assert.equal(await page.evaluate(()=>scrollY),scroll,"wheel zoom does not scroll the admin page");
  await page.keyboard.press("0");
  await page.getByRole("button", { name: "알림함" }).click();
  await page.getByRole("dialog").waitFor();
  await page.getByRole("button", { name: "확인 표시", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "확인함", exact: true }).isDisabled(), true);
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("dialog").count(), 0);
  assert.match(await page.locator(":focus").innerText(), /알림함/);
  await page.getByRole("button", { name: "애니메이션 멈추기" }).click();
  assert.equal(await arm.evaluate(el=>getComputedStyle(el).animationName), "none");
  await page.getByRole("button", { name: "집중 모드", exact: true }).click();
  assert.equal(await page.locator(".of-focus").count(), 1); await page.keyboard.press("Escape");
  assert.equal(await page.locator(".of-focus").count(), 0);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "mobile must not overflow");
  await page.getByRole("button",{name:"스케줄러 일정표",exact:true}).click();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,"mobile timetable fits");
  const scheduleBox=await page.locator(".of-scheduler").boundingBox();
  assert.ok(scheduleBox&&scheduleBox.y+scheduleBox.height<=844,"mobile schedule footer stays in viewport");
  await page.getByRole("button",{name:"일정표 닫기",exact:true}).click();
  await page.locator(".of-hotbar").getByRole("button", { name: "백필 아카이브" }).click();
  await page.locator('.of-world-speech[data-room="backfill"]').click();
  assert.match(await page.locator(".of-equipment").innerText(), /2026-09-01/);
  await page.getByRole("button",{name:"장비창 닫기"}).click();
  fixture = { ...fixture, at: new Date(Date.now() - 600_000).toISOString() }; await persist();
  await page.getByRole("button", { name: "상태 새로고침" }).click();
  await page.locator(".of-attention").filter({ hasText: "상태 수집이 멈췄습니다" }).waitFor();
  assert.equal(await page.locator(".of-bot.is-working").count(),0,"stale telemetry must not animate work");
  fixture = { ...fixture, at: new Date().toISOString(), mode: "on-demand" }; await persist();
  await page.getByRole("button", { name: "상태 새로고침" }).click();
  await page.locator(".of-connection").filter({ hasText: "화면 관측 중" }).waitFor({ state: "attached" });
  await page.getByRole("button", { name: "알림함" }).click();
  assert.match(await page.getByRole("dialog").innerText(), /화면을 열 때만 확인 중/);
  await page.keyboard.press("Escape");
  await page.route("**/admin/office/status", route => route.fulfill({ status: 503, body: "offline" }));
  await page.getByRole("button", { name: "상태 새로고침" }).click();
  await page.locator(".of-attention").filter({ hasText: "연결 확인 필요" }).waitFor();
  assert.match(await page.locator(".of-game-resources").innerText(), /288/, "failed refresh retains last snapshot");
  assert.deepEqual(errors, [], "no hydration or runtime errors");
  console.log("Office browser QA passed: auth, 14 characters, quiet ambient speech and hover conversations, walking desk/lounge transitions, animated arms, equipment history, camera, keyboard, alerts, timetable filters/estimates/job selection, mobile, stale and offline.");
} finally {
  await browser.close();
  if (app.exitCode === null) { app.kill("SIGTERM"); await once(app, "exit"); }
  await rm(scratch, { recursive: true, force: true });
  await rm(join(root, "apps/web", dist), { recursive: true, force: true });
}
