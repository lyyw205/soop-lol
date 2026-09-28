/** 폐기 가능한 DB에서 진행·lead 정본·재개를 검증한다. 실제 DATABASE_URL을 사용하지 않는다. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync,writeFileSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { applyAll } from './lib/migrations.ts';
import { freePort } from './lib/disposable-postgres.ts';
import { autoQueueReason } from '../packages/core/lib/metrics/ck-backfill.ts';

const database=await PGlite.create({extensions:{pg_trgm,pgcrypto}});
const port=await freePort();
const server=new PGLiteSocketServer({db:database,port,host:'127.0.0.1'});
await server.start();
process.env.DATABASE_URL=`postgres://postgres@127.0.0.1:${port}/postgres`;
process.env.DATABASE_POOL_MAX='1';
const {db,closeDb}=await import('../packages/core/lib/db/client.ts');
const ck=await import('../packages/core/lib/db/ck.ts');
const b=await import('../packages/core/lib/db/ck-backfill.ts');
try {
 await applyAll(sql=>database.exec(sql),join(import.meta.dirname,'..'));
 const [s]=await db()<{id:string}[]>`INSERT INTO streamer(slug,display_name,watch) VALUES('backfill-test','백필검증',true) RETURNING id`;
 await db()`INSERT INTO streamer_channel(streamer_id,platform,channel_id) VALUES(${s.id},'soop','backfill-channel')`;
 const target=await b.resolveBackfillTarget('백필검증');
 const p=await b.ensureBackfillProgress(target,new Date('2026-09-28T01:00:00Z'));
 assert.equal(p.upper_before.toISOString(),'2026-09-25T15:00:00.000Z');
 assert.equal((await b.ensureBackfillProgress({...target,watch:false},new Date('2026-10-01'))).upper_before.toISOString(),p.upper_before.toISOString());
 const vod=(id:number)=>({title_no:id,ended_at:'2026-09-25T03:00:00Z',title:`VOD ${id}`,channel_id:target.channel_id,duration_sec:100,url:`https://vod.sooplive.com/player/${id}`});
 const old=await ck.upsertEventLead({source:'vod_title',source_key:'vod:3',title:'원래 제목',observed_at:new Date(),raw:{keep:'preserved'},state:'ignored',note:'원래 메모'});
 await b.markBackfillVod(p,target,vod(3));await b.markBackfillVod(p,target,vod(2));await b.markBackfillVod(p,target,vod(1));
 assert.equal((await b.reconcileBackfill(target.channel_id))?.cursor_at,null,'큐만 만든 뒤 cursor는 그대로');
 const rows=await db()`SELECT id,raw,state,note FROM event_lead WHERE source='vod_title' AND source_key='vod:3'`;
 assert.equal(rows[0].id,old);assert.equal(rows[0].raw.keep,'preserved');assert.equal(rows[0].note,'원래 메모');assert.equal(rows[0].state,'ignored');
 assert.equal(autoQueueReason(rows[0].raw),null,'표시만 있는 lead_only도 자동 제외');
 const same=await ck.upsertEventLead({source:'vod_title',source_key:'vod:3',title:'조사 제목',observed_at:new Date(),raw:{vod_total_sec:100}});
 assert.equal(same,old);
 assert.equal((await b.backfillLeads(['vod:3'])).get('vod:3')?.raw.backfill.progress_id,p.id,'ck:merge와 같은 upsert 후 표시 보존');
 const scan={status:'done' as const,failed:[],requested:[[0,100] as [number,number]],sampled:[[0,100] as [number,number]],opened:[0,100]};
 await ck.markLeadScan(old,scan);
 // 이후 VOD가 먼저 완료돼도 중간 구멍을 넘어가지 않는다.
 const leads=await db()<{id:string;source_key:string}[]>`SELECT id,source_key FROM event_lead WHERE source='vod_title'`;
 const id2=leads.find(x=>x.source_key==='vod:2')!.id, id1=leads.find(x=>x.source_key==='vod:1')!.id;
 await ck.markLeadScan(id1,scan);
 assert.equal(Number((await b.reconcileBackfill(target.channel_id))?.cursor_vod),3);
 await ck.markLeadScan(id2,{...scan,requested:[[0,50]],sampled:[[0,50]]});
 assert.equal(Number((await b.reconcileBackfill(target.channel_id))?.cursor_vod),3,'부분 범위 done은 차단');
 await ck.markLeadScan(id2,scan);
 assert.equal(Number((await b.reconcileBackfill(target.channel_id))?.cursor_vod),1,'저장 후 cursor 갱신 전 중단 복구');
 assert.equal(Number((await b.reconcileBackfill(target.channel_id))?.cursor_vod),1,'재확인 멱등');
 const auto=await ck.upsertEventLead({source:'vod_title',source_key:'vod:99',channel_id:target.channel_id,title:'auto',observed_at:new Date(),raw:{scan:{status:'running'}}});
 await ck.markLeadScan(old,{...scan,status:'running'});
 assert.deepEqual((await b.listAutoRunningLeads([target.channel_id])).map(r=>r.source_key),['vod:99']);
 await assert.rejects(b.markBackfillVod(p,target,vod(99)),/이관/);
 assert.ok(auto);
 await b.markBackfillVod(p,target,{...vod(100),ended_at:'2026-09-24T03:00:00Z'});
 await b.recordBackfillAccess(p,100,'temporary','timeout');
 assert.equal(Number((await b.reconcileBackfill(target.channel_id))?.cursor_vod),1);
 await b.recordBackfillAccess(p,100,'unavailable','삭제 안내 확인');
 assert.equal(Number((await b.reconcileBackfill(target.channel_id))?.cursor_vod),100);
 await b.recordBackfillAccess(p,100,'retry','명시적 재확인');
 assert.equal((await b.markedBackfillVods(p)).find(v=>v.title_no===100)?.raw.backfill_access.status,'retry');
 // 실제 CLI plan/checkpoint를 실행한다. HTTP만 fixture로 대체한다.
 const dir=mkdtempSync(join(tmpdir(),'ck-backfill-cli-'));
 try {
  await db()`INSERT INTO streamer(slug,display_name,watch) VALUES('backfill-cli','백필CLI',false)`;
  await db()`INSERT INTO streamer_channel(streamer_id,platform,channel_id)
    SELECT id,'soop','backfill-cli-channel' FROM streamer WHERE slug='backfill-cli'`;
  const target2=await b.resolveBackfillTarget('backfill-cli');
  await b.ensureBackfillProgress(target2,new Date('2026-09-26T00:00:00Z'));
  const fixture=join(dir,'http.mjs'), queue=join(dir,'queue.json');
  writeFileSync(fixture, `globalThis.fetch=async input=>{
    const u=new URL(input); if(u.hostname!=='api-channel.sooplive.com')throw Error('unexpected HTTP '+u);
    const to=u.searchParams.get('endDate');
    const rows=to>='2026-09-25'?[202,201].map(titleNo=>({titleNo,titleName:'fixture',regDate:'2026-09-25 12:00:00',ucc:{totalFileDuration:3600000},count:{}})):[];
    return Response.json({contents:rows,meta:{totalItems:rows.length,totalPages:rows.length?1:0}});
  };`);
  const cli=async(...args:string[])=>{
    await closeDb();
    return promisify(execFile)(process.execPath,['--import',fixture,join(import.meta.dirname,'ck-backfill.ts'),...args],
      {env:{...process.env,CK_BACKFILL_LOCKED:'1',SOOP_PACE:'0.0001'},timeout:30000});
  };
  await cli('plan','--streamer','backfill-cli','--limit','1','--write',queue);
  assert.deepEqual(JSON.parse(readFileSync(queue,'utf8')).queue.map((v:any)=>v.title_no),[202]);
  assert.equal((await b.getBackfillProgress(target2.channel_id))?.cursor_at,null);
  await cli('plan','--streamer','backfill-cli','--limit','1','--write',queue);
  assert.deepEqual(JSON.parse(readFileSync(queue,'utf8')).queue.map((v:any)=>v.title_no),[202],'queue-only crash resumes same VOD');
  const [lead202]=await db()<{id:string}[]>`SELECT id FROM event_lead WHERE source='vod_title' AND source_key='vod:202'`;
  await ck.markLeadScan(lead202.id,{...scan,requested:[[0,3600]],sampled:[[0,3600]]});
  await cli('plan','--streamer','backfill-cli','--limit','1','--write',queue);
  assert.deepEqual(JSON.parse(readFileSync(queue,'utf8')).queue.map((v:any)=>v.title_no),[201],'saved DB result recovers cursor without checkpoint');
  await cli('access','--streamer','backfill-cli','--vod','201','--status','unavailable','--reason','삭제 안내 fixture');
  await cli('checkpoint','--streamer','backfill-cli');
  await cli('plan','--streamer','backfill-cli','--write',queue);
  assert.equal(JSON.parse(readFileSync(queue,'utf8')).queue.length,0);
  assert.equal((await b.getBackfillProgress(target2.channel_id))?.exhausted,true);
 } finally {rmSync(dir,{recursive:true,force:true});}
 const [rls]=await db()`SELECT relrowsecurity FROM pg_class WHERE relname='ck_backfill_progress'`;
 assert.equal(rls.relrowsecurity,true);
 console.log('백필 DB 검증 통과: 고정 상한·정규화 lead·raw 보존·연속 진행·중단 복구·자동 제외·접근 상태');
} finally {await closeDb();await server.stop();await database.close();}
