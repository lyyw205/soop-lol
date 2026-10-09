import { verifyAdminBrowser } from './lib/verify-admin-browser.ts';
import { verifyPriorityBrowser } from './lib/verify-priority-browser.ts';
import {verifyUnknownBrowser} from './lib/verify-unknown-browser.ts';
/** Real Next actions + Chromium + disposable PostgreSQL. No production connection accepted. */
import assert from 'node:assert/strict';
import { chromium, type Locator } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import postgres from 'postgres';
import { disposablePostgres, freePort } from './lib/disposable-postgres.ts';
import { applyAll } from './lib/migrations.ts';
import * as ck from '../packages/core/lib/db/ck.ts';
import { createStreamer } from '../packages/core/lib/db/streamers.ts';
import { db,closeDb } from '../packages/core/lib/db/client.ts';

const root=new URL('..',import.meta.url).pathname;
const prebuiltDist=process.env.CK_BROWSER_DIST;
if(prebuiltDist && !/^\.next-[a-zA-Z0-9-]+$/.test(prebuiltDist)) throw new Error('CK_BROWSER_DIST must name an existing .next-* build directory');
if(prebuiltDist) await readFile(join(root,'apps/web',prebuiltDist,'BUILD_ID'));
const pg=await disposablePostgres(), port=await freePort();
const scratch=await mkdtemp(join(tmpdir(),'soop-ck-browser-'));
const dist=prebuiltDist ?? `.next-ck-test-${process.pid}`, logPath=join(scratch,'next.log');
const setup=postgres(pg.url,{max:1});
process.env.DATABASE_URL=pg.url;process.env.DATABASE_POOL_MAX='3';
let app:ReturnType<typeof spawn>|undefined;
let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
const errors:string[]=[];
async function submit(form:Locator, button:string) {
  const response = form.page().waitForResponse(r => r.request().method() === 'POST' && !!r.request().headers()['next-action']);
  await form.getByRole('button',{name:button,exact:true}).click();
  // RSC may keep streaming after the action has settled; verify the visible result instead of waiting for transport EOF.
  assert.ok((await response).ok());
  await form.getByRole('button',{name:button,exact:true}).waitFor();
  await form.locator('[role=status]').waitFor();
  return await form.locator('[role=status]').innerText();
}
try {
  await applyAll(s=>setup.unsafe(s),root,{includeModules:true});
  console.log("Browser test: disposable database ready");
  const a=await createStreamer({slug:'ck-browser-a',display_name:'검사 A'}),b=await createStreamer({slug:'ck-browser-b',display_name:'검사 B'});
  const lead=await ck.upsertEventLead({source:'vod_title',source_key:'vod:browser',url:'https://example.test/ck',title:'CK browser fixture',observed_at:new Date()});
  for(const n of [1,2]) await ck.upsertMatchFromScan({ played_at_precision: "datetime",match_id:`browser:M${n}`,source_url:'https://example.test/ck',played_at:new Date(`2026-09-20T0${n}:00:00Z`),winning_team:n===1?100:200,result_evidence:`M${n} evidence`,series_id:'browser',series_game_no:n,participants:[
    {participant_id:1,team_id:100,streamer_id:a.id,observed_name:'A',champion_id:n===1?268:143,kills:n===1?5:9,deaths:1,assists:3},
    {participant_id:2,team_id:200,streamer_id:b.id,observed_name:'B',champion_id:64,kills:3,deaths:5,assists:1},
  ]});
  await ck.mergeLeadCandidates(lead,[{id:'c1',at:[0,100],conclusion:'unresolved',why:'auto'}]);
  const log=createWriteStream(logPath);
  app=spawn(process.execPath,[join(root,'node_modules/next/dist/bin/next'),...(prebuiltDist ? ['start'] : ['dev','--webpack']),'--hostname','127.0.0.1','--port',String(port)],{
    cwd:join(root,'apps/web'),env:{...process.env,DATABASE_URL:pg.url,ADMIN_USER:'ck_test',ADMIN_PASSWORD:'disposable-only',NEXT_DIST_DIR:dist,CK_OUT_ROOT:join(scratch,'out'),NEXT_TELEMETRY_DISABLED:'1'},stdio:['ignore','pipe','pipe'],
  });
  app.stdout!.pipe(log);app.stderr!.pipe(log);
  const base=`http://127.0.0.1:${port}`, url=`${base}/admin/ck/${lead}`;
  const deadline=Date.now()+90_000;
  while(Date.now()<deadline){
    if(app.exitCode!==null) throw new Error('Next exited');
    try{const response=await fetch(base+'/admin/ck',{headers:{authorization:'Basic '+Buffer.from('ck_test:disposable-only').toString('base64')}});if(response.ok)break}catch{}
    await new Promise(r=>setTimeout(r,200));
  }
  browser=await chromium.launch();
  const context=await browser.newContext({httpCredentials:{username:'ck_test',password:'disposable-only'},viewport:{width:1440,height:1100}});
  const p=await context.newPage();p.on('pageerror',e=>errors.push(e.message));await p.goto(url);
  await p.locator('.ck-review-queue-item[data-kind="match"]').first().waitFor();
  const choose=async(n:number,page=p)=>{
    await page.getByRole('button',{name:`시각 미상 경기 browser:M${n}`,exact:true}).click();
    await page.getByRole('combobox',{name:'편집할 세트'}).selectOption(`browser:M${n}`);
    await page.getByRole('tab',{name:'경기',exact:true}).click();
    await page.getByRole('heading',{name:`browser:M${n}`,exact:true}).waitFor();
  };
  const meta=p.locator('form:has(.ck-review-match-summary)');
  const roster=()=>p.locator('form:has(input[name=roster])');
  const row=(id:number)=>p.locator(`[data-participant-id="${id}"]`);
  const openRoster=()=>p.getByRole('tab',{name:'로스터',exact:true}).click();
  const nextAction=async(page:typeof p,run:()=>Promise<unknown>)=>{
    const response=page.waitForResponse(r=>r.request().method()==='POST'&&!!r.request().headers()['next-action']);
    await run();assert.ok((await response).ok());
    await page.locator('form:has(.ck-review-match-summary) [role=status]').waitFor();
  };
  // 편집 세트는 참고 사진과 따로 고르고, 로스터 초안이 다른 경기로 새지 않는다.
  await choose(1);await openRoster();await row(1).getByRole('button',{name:'참가자 1 KDA'}).click();
  await row(1).locator('input[placeholder=K]').fill('77');
  await choose(2);await openRoster();await row(1).getByRole('button',{name:'참가자 1 KDA'}).click();
  assert.equal(await row(1).locator('input[placeholder=K]').inputValue(),'9');
  await choose(1);await openRoster();await row(1).getByRole('button',{name:'참가자 1 KDA'}).click();
  assert.equal(await row(1).locator('input[placeholder=K]').inputValue(),'77', '경기 간 이동에도 해당 경기 초안 유지');
  await p.getByRole('tab',{name:'경기',exact:true}).click();
  await openRoster(); assert.equal(await row(1).locator('input[placeholder=K]').inputValue(),'77', '탭 간 이동에도 초안 유지');
  await row(1).getByRole('button',{name:'참가자 1 챔피언'}).click();
  await row(1).locator('input[placeholder="챔피언 이름 입력"]').fill('');
  assert.match(await submit(roster(),'변경사항 저장'),/저장했습니다/);
  assert.equal((await ck.getMatchDetail('browser:M1'))!.participants[0].champion_id,0);
  await row(1).getByRole('button',{name:'참가자 1 KDA'}).click();
  assert.equal(await row(1).locator('input[placeholder=K]').inputValue(),'77', 'saved roster stays visible');
  await row(1).locator('input[placeholder=K]').fill('78');
  assert.match(await submit(roster(),'변경사항 저장'),/저장했습니다/);
  assert.equal((await ck.getMatchDetail('browser:M1'))!.participants[0].kills,78, 'immediate repeated roster save uses the new base');

  const oldStats=await db()`SELECT count(*)::int AS n FROM champion_stat WHERE streamer_id=${a.id} AND champion_id=268`;
  assert.equal(oldStats[0].n,0);
  // 결과 근거 문장·후보 판단은 사람 검수 화면에 없다 — 조사 기록은 CLI(ck:record)로 본다.
  // 사람은 공개될 값만 고친다: 승자를 바꾸면 참가자 승패(outcome)가 같이 맞춰져야 한다.
  await choose(1);
  await nextAction(p,()=>meta.getByRole('button',{name:'2팀',exact:true}).click());
  assert.equal((await ck.getMatchDetail('browser:M1'))!.match.winning_team,200);
  const wins=await db()`SELECT bool_and((mp.outcome='win')=(mp.team_id=m.winning_team)) AS ok FROM match_participant mp JOIN match m USING(match_id) WHERE m.match_id='browser:M1'`;
  assert.equal(wins[0].ok,true);
  const changes=await ck.listReviewChanges({match_id:'browser:M1'});
  assert.ok(changes.some(c=>c.field==='winning_team'&&c.after===200),'화면에서 고친 값은 수정 이력에 남는다');
  await p.setViewportSize({width:390,height:844});await choose(2);
  const durationCell=meta.locator('dt',{hasText:'길이'}).locator('..');
  await durationCell.getByRole('button').click();
  await durationCell.getByRole('textbox',{name:'경기 길이 초'}).fill('1800');
  await nextAction(p,()=>durationCell.getByRole('textbox',{name:'경기 길이 초'}).press('Enter'));
  await p.reload();await choose(2);assert.equal(await meta.locator('input[name=game_duration]').inputValue(),'1800');
  const publicParticipants=await db()`SELECT count(*)::int AS n FROM core_public.match_participant WHERE match_id='browser:M1'`;
  assert.equal(publicParticipants[0].n,2);
  const publicWins=await db()`SELECT bool_and((a_outcome='win') = (pa.team_id=m.winning_team)) AS ok
    FROM core_public.streamer_encounter e JOIN match m USING(match_id)
    JOIN match_participant pa ON pa.match_id=m.match_id AND pa.streamer_id=e.streamer_a_id
    WHERE m.match_id='browser:M1'`;
  assert.equal(publicWins[0].ok,true);
  await verifyPriorityBrowser(context,base,lead);
  await verifyAdminBrowser(context,base,a.id);
  await verifyUnknownBrowser(context,base,a.id,b.id);
  assert.deepEqual(errors,[]);
  console.log('Next + Chromium: selection, save, normalized values, RSC refresh, winner/outcome, review history, mobile reload passed');
} catch(error){console.error((await readFile(logPath,'utf8').catch(()=>'' )).slice(-7000));throw error}
finally {
  await browser?.close();
  if(app && app.exitCode===null){app.kill('SIGTERM');await Promise.race([once(app,'exit'),new Promise(r=>setTimeout(r,5000))]);if(app.exitCode===null)app.kill('SIGKILL')}
  await setup.end();await closeDb();await pg.stop();if(!prebuiltDist)await rm(join(root,'apps/web',dist),{recursive:true,force:true});await rm(scratch,{recursive:true,force:true});
}
