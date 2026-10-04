import assert from 'node:assert/strict';
import type {BrowserContext, Locator} from 'playwright';
import * as ck from '../../packages/core/lib/db/ck.ts';
import {db} from '../../packages/core/lib/db/client.ts';
import {profileHref} from '../../packages/core/lib/site-paths.ts';

export async function verifyUnknownBrowser(context: BrowserContext, base: string, a: string, b: string) {
  const fixture=(id:string,series:string):ck.CkMatchInput=>({ played_at_precision: "datetime",match_id:id,series_id:series,series_game_no:Number(id.split(':').at(-1))||1,set_order_known:true,
    played_at:new Date('2026-09-21T00:00:00Z'),winning_team:100,result_evidence:'browser unknown',participants:[
      {participant_id:1,team_id:100,observed_name:'브라우저 미확인',champion_id:34,kills:3,deaths:8,assists:7},
      {participant_id:2,team_id:200,streamer_id:b,champion_id:143,kills:1,deaths:2,assists:3}]});
  for(const n of [1,2,3,4]) await ck.upsertMatchFromScan(fixture(`unknown-browser:${n}`,'확인한 시리즈'));
  await ck.upsertMatchFromScan(fixture('unknown-browser:other','다른 시리즈'));
  await ck.upsertMatchFromScan(fixture('unknown-browser:hidden','숨긴 시리즈'));
  await db()`UPDATE match SET visibility='hidden' WHERE match_id='unknown-browser:hidden'`;
  const p=await context.newPage(),q=await context.newPage(),publicPage=await context.newPage();
  const errors:string[]=[];
  for(const page of [p,q,publicPage]){page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(/same key|unique.*key/i.test(m.text()))errors.push(m.text())})}
  await p.goto(base+'/admin/ck/unknown');await q.goto(base+'/admin/ck/unknown');
  const form=(page:typeof p)=>page.locator('li').filter({has:page.locator('strong',{hasText:'브라우저 미확인'})}).locator('form');
  for (const page of [p,q]) await page.locator('strong',{hasText:'브라우저 미확인'}).click();
  const first=form(p),stale=form(q);
  for (const f of [first,stale]) for (const summary of await f.locator('details > summary').all()) await summary.click();
  await first.getByRole('button',{name:'선택한 0자리 연결'}).waitFor();
  assert.equal(await first.locator('input[name=targets]').count(),5);
  assert.equal(await first.locator('input[name=targets]:checked').count(),0);
  await ck.upsertMatchFromScan(fixture('unknown-browser:late','나중에 추가된 시리즈'));
  await first.getByRole('checkbox',{name:'확인한 시리즈 — 연결 가능한 4자리 선택',exact:true}).check();
  await stale.getByRole('checkbox',{name:'확인한 시리즈 — 연결 가능한 4자리 선택',exact:true}).check();
  await first.locator('[name=streamer_slug]').selectOption('ck-browser-a');
  await stale.locator('[name=streamer_slug]').selectOption('ck-browser-b');
  const submit=async(form:Locator,count=4)=>{
    const response=form.page().waitForResponse(r=>r.request().method()==='POST' && !!r.request().headers()['next-action']);
    await form.getByRole('button',{name:`선택한 ${count}자리 연결`,exact:true}).click();assert.ok((await response).ok());
    await form.locator('fieldset:not([disabled])').waitFor();
    await form.locator('[role=status]').waitFor();return form.locator('[role=status]').innerText();
  };
  assert.match(await submit(first),/4자리를 연결했습니다/);
  assert.match(await submit(stale),/다른 검수자/);
  assert.equal(await stale.locator('input[name=targets]:checked').count(),4);
  assert.equal(await stale.locator('[name=streamer_slug]').inputValue(),'ck-browser-b');
  for(const n of [1,2,3,4]){
    const detail=(await ck.getMatchDetail(`unknown-browser:${n}`))!;
    assert.equal(detail.participants[0].streamer_id,a);assert.equal(detail.participants[0].kills,3);assert.ok(detail.match.reviewed_at);
  }
  assert.equal(await ck.upsertMatchFromScan(fixture('unknown-browser:1','확인한 시리즈')),false);
  for(const id of ['other','hidden','late'])assert.equal((await ck.getMatchDetail(`unknown-browser:${id}`))!.participants[0].streamer_id,null);
  await p.setViewportSize({width:390,height:844});await p.reload();await p.locator('strong',{hasText:'브라우저 미확인'}).click();for(const summary of await form(p).locator('details > summary').all()) await summary.click();assert.equal(await form(p).locator('input[name=targets]').count(),2);
  await form(p).getByRole('checkbox',{name:'다른 시리즈 — 연결 가능한 1자리 선택',exact:true}).check();
  await form(p).locator('[name=streamer_slug]').selectOption('ck-browser-a');
  assert.match(await submit(form(p),1),/1자리를 연결했습니다/);
  await p.reload();assert.equal((await ck.getMatchDetail('unknown-browser:other'))!.participants[0].streamer_id,a);
  // A later match failure rolls back the first; correcting selection permits a retry on mobile.
  for(const n of [1,2]) {
    const f=fixture(`unknown-failure:${n}`,'실패 복구 시리즈');
    f.participants[0].observed_name='실패 복구';
    if(n===2) f.participants.push({participant_id:3,team_id:200,streamer_id:a,champion_id:64});
    await ck.upsertMatchFromScan(f);
  }
  await p.reload();
  const failure=p.locator('li').filter({has:p.locator('strong',{hasText:'실패 복구'})}).locator('form');
  await p.locator('strong').filter({ hasText: /^실패 복구$/ }).click();
  for(const summary of await failure.locator('details > summary').all()) await summary.click();
  await failure.getByRole('checkbox',{name:'실패 복구 시리즈 — 연결 가능한 2자리 선택',exact:true}).check();
  await failure.locator('[name=streamer_slug]').selectOption('ck-browser-a');
  assert.match(await submit(failure,2),/이번 연결은 모두 취소/);
  assert.equal(await failure.locator('input[name=targets]:checked').count(),2);
  assert.equal((await ck.getMatchDetail('unknown-failure:1'))!.participants[0].streamer_id,null);
  await failure.locator('input[name=targets]').nth(1).uncheck();
  assert.equal(await failure.locator('input[name=targets]:checked').count(),1);
  assert.equal(JSON.parse(await failure.locator('input[name=targets]:checked').inputValue()).match_id,'unknown-failure:1');
  assert.match(await submit(failure,1),/1자리를 연결했습니다/);
  assert.equal((await ck.getMatchDetail('unknown-failure:1'))!.participants[0].streamer_id,a);
  // Public roster: two identical unknown labels still render two separate seats, with no profile links.
  const dup=fixture('unknown-browser:duplicate','중복 이름 시리즈');
  dup.participants=[{participant_id:1,team_id:100,observed_name:'동명 미확인',champion_id:0},
    {participant_id:2,team_id:100,observed_name:'동명 미확인',champion_id:0},{participant_id:3,team_id:200,streamer_id:b,champion_id:143}];
  await ck.upsertMatchFromScan(dup);
  await publicPage.setViewportSize({width:390,height:844});
  await publicPage.goto(base+profileHref('lol','ck-browser-b',{tab:'games'}));
  const duplicate=publicPage.locator('.match-details[data-match-id="unknown-browser:duplicate"]');
  await duplicate.locator('..').locator('summary').click();
  assert.equal(await duplicate.locator('.match-details-unidentified').count(),2);
  assert.equal(await duplicate.locator('.match-details-unidentified a').count(),0);
  assert.equal(await duplicate.locator('.match-details-player').count(),3);
  // The same public page also reads the freshly linked four-set roster.
  const linked=publicPage.locator('.match-details[data-match-id="unknown-browser:1"]');
  await linked.locator('..').locator('summary').click();
  assert.equal(await linked.getByRole('link',{name:'검사 A',exact:true}).count(),1);
  await linked.getByRole('button',{name:/2세트/}).click();
  assert.equal(await publicPage.locator('.match-details[data-match-id="unknown-browser:2"] .match-details-player').count(),2);
  assert.deepEqual(errors,[]);
  await p.close();await q.close();await publicPage.close();
  console.log('Unknown browser: explicit four-seat selection, new/hidden/unselected isolation, two tabs, draft retention, mobile/public roster and duplicate labels passed');
}
