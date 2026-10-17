/** 실제 R2 + 격리 PGlite/Next 통합 검사. 이 실행에서 발급한 파일 ID만 마지막에 삭제한다. */
import sharp from "sharp";
import { readFile } from "node:fs/promises";
import { r2Storage } from "../packages/core/lib/storage/r2.ts";
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { applyAll } from "./lib/migrations.ts";
import { freePort } from "./lib/disposable-postgres.ts";
import { SESSION_COOKIE } from "../packages/core/lib/auth/session.ts";

const root = join(import.meta.dirname, "..");
const memory = await PGlite.create({ extensions: { pg_trgm, pgcrypto } });
const port = await freePort();
const server = new PGLiteSocketServer({ db: memory, host: "127.0.0.1", port });
await server.start();
process.env.DATABASE_URL = `postgres://postgres@127.0.0.1:${port}/postgres`;
process.env.DATABASE_POOL_MAX = "1";
process.env.ADMIN_AUTH_MODE = "member";
process.env.COMMUNITY_UPLOAD_ENABLED = "true";
const uploaded = new Set<string>();
let origin = "http://localhost:3000";
const { closeDb } = await import("../packages/core/lib/db/client.ts");
const { loginWithIdentity, createSession, setNickname } = await import("../packages/core/lib/db/member.ts");
let app: ChildProcess | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let appLog = "";
try {
  await applyAll((sql) => memory.exec(sql), root);
  async function member(subject: string, nickname: string) {
    const m = await loginWithIdentity("google", subject);
    assert.equal(m.kind, "ok");
    if (m.kind !== "ok") throw new Error("unexpected blocked fixture");
    const session = await createSession(m.memberId);
    await setNickname(session.token, nickname, { agreed: true });
    return { id: m.memberId, token: session.token };
  }
  const other = await member("media-author", "영상검증회원");
  // Release the single PGlite socket before the Next process connects.
  await closeDb();
  const appPort = await freePort();
  const base = `http://127.0.0.1:${appPort}`;
  origin=base;
  app = spawn(process.execPath, [join(root, "node_modules/next/dist/bin/next"), "dev", "--webpack", "--hostname", "127.0.0.1", "--port", String(appPort)], {
    cwd: join(root, "apps/web"), env: { ...process.env, NEXT_DIST_DIR: ".next-attachment-check", NEXT_TELEMETRY_DISABLED: "1", BOT_GUARD: "off", SITE_ORIGIN: origin },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Next startup timeout")), 120_000);
    const read = (data: Buffer) => {
      appLog += data.toString();
      if (/Ready in/.test(appLog)) { clearTimeout(timer); resolve(); }
    };
    app!.stdout!.on("data", read); app!.stderr!.on("data", read);
    app!.once("exit", () => { clearTimeout(timer); reject(new Error("Next exited before ready")); });
  });
  browser = await chromium.launch({ headless: true, args:['--disable-features=LocalNetworkAccessChecks'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  await context.addCookies([{ name: SESSION_COOKIE, value: other.token, url: origin }]);
  // 격리 서버의 임의 포트는 운영 CORS에 등록하지 않는다.
  // 실제 R2 전송은 그대로 수행하고 이 검사에서만 응답 Origin을 격리 서버에 맞춘다.
  // 운영 localhost Origin의 CORS는 아래 실제 OPTIONS로 별도 검증한다.
  await context.route('**/*.r2.cloudflarestorage.com/**',async route=>{
    const req=route.request();
    const response=await route.fetch({headers:{...req.headers(),origin:'http://localhost:3000'}});
    await route.fulfill({response,headers:{...response.headers(),'access-control-allow-origin':origin}});
  });
  context.on('response',async response=>{
    if(response.url()===origin+'/api/community/attachments'&&response.request().method()==='POST'&&response.ok()){
      const reservation=await response.json();uploaded.add(reservation.id);
      const preflight=await fetch(reservation.url,{method:'OPTIONS',headers:{Origin:'http://localhost:3000','Access-Control-Request-Method':'PUT','Access-Control-Request-Headers':'content-type'}});
      assert.ok(preflight.ok);assert.equal(preflight.headers.get('access-control-allow-origin'),'http://localhost:3000');
    }
  });
  const page=await context.newPage();
  page.on('console',m=>{if(m.type()==='error')console.log('Console',m.text().replace(/https?:\/\/[^\s]+/g,'[url]').slice(0,500));});
  page.on('pageerror',e=>console.log('Page error',e.message.slice(0,300)));
  await page.goto(origin+'/community?write=1');
  await page.waitForLoadState('networkidle',{timeout:30000});
  await page.locator('input[name="title"]').fill('첨부파일 브라우저 검증');
  await page.locator('textarea[name="body"]').fill('이미지·GIF·MP4 첨부 테스트입니다.');
  const png=await sharp({create:{width:320,height:180,channels:3,background:'#acc8ed'}}).png().toBuffer();
  const gif=await sharp({create:{width:120,height:80,channels:3,background:'#c8aa6e'}}).gif().toBuffer();
  const video=await readFile(join(root,'scripts/fixtures/attachment-frame.mp4'));
  await page.getByRole('button',{name:'본문 미리보기',exact:true}).click();
  await page.getByRole('button',{name:'미리보기 닫기',exact:true}).click();
  await page.locator('input[type="file"]').setInputFiles([
    {name:'사진.png',mimeType:'image/png',buffer:png},
    {name:'움짤.gif',mimeType:'image/gif',buffer:gif},
    {name:'영상.mp4',mimeType:'video/mp4',buffer:video},
  ]);
  await page.getByRole('status').filter({hasText:'파일을 첨부했습니다'}).waitFor({timeout:120000});
  assert.equal(await page.locator('.cm-upload-list li').count(),3);
  await page.getByRole('button',{name:'본문 미리보기',exact:true}).click();
  await page.waitForFunction(()=>Array.from(document.querySelectorAll('.cm-attachments img')).every(i=>(i as HTMLImageElement).naturalWidth>0));
  await page.getByRole('button',{name:'등록',exact:true}).click();
  await page.waitForURL(url=>/^\/community\/\d+$/.test(url.pathname),{timeout:60000});
  await page.waitForFunction(()=>document.querySelectorAll('.cm-attachments img').length===2&&Array.from(document.querySelectorAll('.cm-attachments img')).every(i=>(i as HTMLImageElement).naturalWidth>0));
  assert.equal(await page.locator('.cm-attachments video').count(),1);
  await page.locator('video').evaluate(async (v:HTMLVideoElement)=>{v.muted=true;await v.play();});
  await page.waitForFunction(()=>{const v=document.querySelector('video');return !!v&&v.currentTime>0.2;});
  await page.locator('video').evaluate((v:HTMLVideoElement)=>v.pause());
  await page.screenshot({path:'/tmp/attachments-desktop.png',fullPage:true});
  const postUrl=page.url();
  await page.getByRole('link',{name:'수정',exact:true}).click();await page.waitForURL(url=>url.searchParams.get('edit')==='1');
  await page.locator('.cm-upload-list li').first().waitFor();assert.equal(await page.locator('.cm-upload-list li').count(),3);
  const removed=await page.locator('input[name="attachments"]').inputValue();
  await page.getByRole('button',{name:'사진.png 첨부 취소'}).click();
  await page.getByRole('button',{name:'수정 완료',exact:true}).click();await page.waitForURL(url=>!url.searchParams.has('edit'));
  assert.equal(await page.locator('.cm-attachments img').count(),1);
  const denied=await context.request.get(base+'/api/community/attachments/'+removed.split(',')[0],{maxRedirects:0});assert.equal(denied.status(),404);
  await context.clearCookies();await page.goto(postUrl);
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.waitForFunction(()=>{const i=document.querySelector('.cm-attachments img') as HTMLImageElement;return i?.naturalWidth>0;});
  await page.screenshot({path:'/tmp/attachments-mobile.png',fullPage:true});
  const noAuth=await context.request.post(base+'/api/community/attachments',{headers:{origin:base,host:new URL(base).host},data:{name:'x.png',mime:'image/png',bytes:12}});assert.equal(noAuth.status(),400);
  console.log('PASS real browser/R2 PNG + GIF + MP4 uploads, preview, save, playback, edit/remove, public read, mobile, login enforcement');

} catch(e) {
  console.log('App diagnostics',appLog.slice(-3500).replace(/https?:\/\/[^\s]+/g,'[url]'));
  throw e;
} finally {
  await browser?.close();
  for(const id of uploaded)await r2Storage.remove(id);
  console.log(`Removed ${uploaded.size} test uploads from the dedicated bucket`);
  if (app && app.exitCode === null) {
    const exited = new Promise<void>((resolve) => app!.once("exit", () => resolve()));
    app.kill("SIGTERM"); await exited;
  }
  await closeDb(); await server.stop(); await memory.close();
}
