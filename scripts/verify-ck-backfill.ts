/**
 * 폐기 가능한 DB 에서 수동 백필을 끝까지 돌려 본다. 실제 DATABASE_URL 을 쓰지 않는다.
 *
 * 가짜인 것은 SOOP HTTP 하나뿐이고, **실제 SOOP 처럼** 동작한다:
 *   startDate·endDate 를 둘 다 줄 때만 거르고, 한쪽만 주면 채널 전체를 준다(2026-09-28 실측).
 *   예전 fixture 는 endDate 하나로 걸러 줘서, 실제로는 첫날 이후 멈추는 백필이 검증을 통과했다.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync,writeFileSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { loadMigrations } from './lib/migrations.ts';
import { freePort } from './lib/disposable-postgres.ts';
import { vodWork } from '../packages/core/lib/metrics/ck-vod-status.ts';

const database=await PGlite.create({extensions:{pg_trgm,pgcrypto}});
const port=await freePort();
const server=new PGLiteSocketServer({db:database,port,host:'127.0.0.1'});
await server.start();
process.env.DATABASE_URL=`postgres://postgres@127.0.0.1:${port}/postgres`;
process.env.DATABASE_POOL_MAX='1';
const {db,closeDb}=await import('../packages/core/lib/db/client.ts');
const ck=await import('../packages/core/lib/db/ck.ts');
const b=await import('../packages/core/lib/db/ck-backfill.ts');
const dir=mkdtempSync(join(tmpdir(),'ck-backfill-verify-'));
const apply=async(pred:(file:string)=>boolean)=>{
 for (const m of loadMigrations(join(import.meta.dirname,'..')).filter(m=>pred(m.file))) await database.exec(`BEGIN;\n${m.sql}\nCOMMIT;`);
};
try {
 // ── 1. 0046 이 옛 백필 기록을 정리한다: 표시는 버리고, 접근 상태는 사유째 raw.access 로 옮긴다 ──
 await apply(f=>f<'0046');
 const [s]=await db()<{id:string}[]>`INSERT INTO streamer(slug,display_name,watch) VALUES('backfill-cli','백필CLI',true) RETURNING id`;
 await db()`INSERT INTO streamer_channel(streamer_id,platform,channel_id) VALUES(${s.id},'soop','bf-channel')`;
 await db()`INSERT INTO ck_backfill_progress(streamer_id,channel_id,upper_before) VALUES(${s.id},'bf-channel','2026-09-26T00:00:00+09:00')`;
 await ck.upsertEventLead({source:'vod_title',source_key:'vod:900',channel_id:'bf-channel',title:'옛 백필',observed_at:new Date(),
  raw:{keep:1,backfill:{progress_id:'x'},backfill_access:{status:'unavailable',reason:'삭제 안내 확인',checked_at:'2026-09-27T00:00:00Z'}}});
 await apply(f=>f>='0046');
 const [legacy]=await db()`SELECT raw FROM event_lead WHERE source_key='vod:900'`;
 assert.deepEqual(legacy.raw,{keep:1,access:{status:'unavailable',reason:'삭제 안내 확인',checked_at:'2026-09-27T00:00:00Z'}});
 assert.equal((await db()`SELECT to_regclass('ck_backfill_progress') AS t`)[0].t,null);
 assert.equal((await db()`SELECT relrowsecurity FROM pg_class WHERE relname='ck_backfill_request'`)[0].relrowsecurity,true);
 // 0049: 옛 watch=true 는 롤 감시로 옮겨지고, 칸은 사라지고, 없는 게임은 거부된다.
 assert.deepEqual((await db()`SELECT game_code FROM streamer_watch WHERE streamer_id=${s.id}`).map((r:any)=>r.game_code),['lol']);
 assert.equal((await db()`SELECT count(*)::int n FROM information_schema.columns WHERE table_name='streamer' AND column_name='watch'`)[0].n,0);
 assert.equal((await db()`SELECT relrowsecurity FROM pg_class WHERE relname='streamer_watch'`)[0].relrowsecurity,true);
 await assert.rejects(db()`INSERT INTO streamer_watch(streamer_id,game_code) VALUES(${s.id},'valorant')`);
 await db()`INSERT INTO streamer_watch(streamer_id,game_code) VALUES(${s.id},'fconline')`;
 const wl=await import('../packages/core/lib/db/watchlist.ts');
 assert.deepEqual((await wl.listWatched('lol')).map(r=>r.slug),['backfill-cli'],'게임별로 따로 나온다');
 assert.deepEqual((await wl.listWatched('fconline')).map(r=>r.slug),['backfill-cli']);
 await wl.setWatched(s.id,'fconline',false);
 assert.equal((await wl.listWatched('fconline')).length,0,'한 게임을 빼도 다른 게임은 남는다');
 assert.equal((await wl.listWatched('lol')).length,1);
 assert.throws(()=>wl.parseWatchGame('valorant'));

 // ── 2. 가짜 SOOP: 양쪽 날짜가 있어야 거르고, 60개씩 페이지를 나눈다 ──
 const row=(titleNo:number,regDate:string,sec=3600,titleName=`VOD ${titleNo}`)=>({titleNo,titleName,regDate,ucc:{totalFileDuration:sec*1000},count:{}});
 const rows=[row(305,'2026-09-21 12:00:00'),row(303,'2026-09-20 19:00:00'),row(304,'2026-09-20 05:17:05'),row(302,'2026-09-19 12:00:00'),
  row(301,'2026-09-18 12:00:00'),row(306,'2026-09-19 20:00:00',3600,'김민교x칸 LCK T1 vs HLE #LckWatchParty'),row(300,'2026-09-17 12:00:00'),
  ...Array.from({length:130},(_,i)=>row(1000+i,'2026-09-05 12:00:00',600))];
 const fixture=join(dir,'http.mjs');
 writeFileSync(fixture,`const rows=${JSON.stringify(rows)};
 globalThis.fetch=async input=>{
  const u=new URL(input); if(u.hostname!=='api-channel.sooplive.com')throw Error('unexpected HTTP '+u);
  const from=u.searchParams.get('startDate'), to=u.searchParams.get('endDate'), page=Number(u.searchParams.get('page'));
  const hit=from&&to ? rows.filter(r=>r.regDate.slice(0,10)>=from&&r.regDate.slice(0,10)<=to) : rows;
  const pages=Math.ceil(hit.length/60);
  return Response.json({contents:hit.slice((page-1)*60,page*60),meta:{totalItems:hit.length,totalPages:pages}});
 };`);
 // PGlite 소켓 서버는 연결을 하나만 받는다. 자식 CLI 를 부르기 전에 이쪽 연결을 놓는다.
 const cli=async(...args:string[])=>{await closeDb();return new Promise<{code:number;out:string}>(resolve=>{
  execFile(process.execPath,['--import',fixture,join(import.meta.dirname,'ck-backfill.ts'),...args],
   {cwd:dir,env:{...process.env,CK_BACKFILL_LOCKED:'1',SOOP_PACE:'0.0001'},timeout:30000},
   (e,stdout,stderr)=>resolve({code:e ? Number((e as any).code ?? 1) : 0,out:stdout+stderr}));
 });};
 const queue=join(dir,'queue.json'), current=join(dir,'current.json');
 const plan=()=>JSON.parse(readFileSync(queue,'utf8'));
 const leadId=async(n:number)=>(await db()<{id:string}[]>`SELECT id FROM event_lead WHERE source_key=${`vod:${n}`}`)[0].id;
 const full=(end:number)=>({status:'done' as const,failed:[],requested:[[0,end] as [number,number]],sampled:[[0,end] as [number,number]],opened:[0]});

 // 자동 조사가 이미 끝낸 VOD(끝 1초 모자람)와, 목록에서 사라진 미완료 VOD 를 미리 둔다.
 await ck.upsertEventLead({source:'vod_title',source_key:'vod:302',channel_id:'bf-channel',title:'자동이 끝냄',observed_at:new Date('2026-09-19T02:00:00Z')});
 await ck.markLeadScan(await leadId(302),full(3599));
 await ck.upsertEventLead({source:'vod_title',source_key:'vod:299',channel_id:'bf-channel',title:'삭제된 듯',observed_at:new Date('2026-09-19T01:00:00Z')});
 await ck.markLeadScan(await leadId(299),{status:'running',requested:[[0,100]]});
 await ck.upsertEventLead({source:'vod_title',source_key:'vod:301',channel_id:'bf-channel',title:'원래 제목',observed_at:new Date('2026-09-18T02:00:00Z'),raw:{keep:'x'},state:'ignored',note:'메모'});

 // ── 3. 기간 요청: 기간 밖(300·305)은 빼고, 완료(302)는 건너뛰고, 밤샘 방송(304)은 종료일로 들어간다 ──
 assert.match((await cli('plan','--streamer','백필CLI','--from','2026-09-18','--write',queue)).out,/함께/);
 assert.equal((await cli('plan','--streamer','백필CLI','--write',queue)).code,1,'처음엔 기간이 필요하다');
 assert.equal((await cli('plan','--streamer','백필CLI','--from','2026-09-18','--to','2026-09-20','--write',queue)).code,0);
 assert.deepEqual(plan().queue,[303,304,301],'LCK Watch Party(306)는 큐에 안 들어간다');
 assert.equal(plan().vods.find((v:any)=>v.title_no===306).excluded,'LCK Watch Party');
 assert.deepEqual(plan().missing.map((m:any)=>m.vod),[299],'목록에서 사라진 미완료 VOD 를 알린다');
 const [kept]=await db()`SELECT raw,state,note FROM event_lead WHERE source_key='vod:301'`;
 assert.deepEqual([kept.raw,kept.state,kept.note],[{keep:'x'},'ignored','메모'],'기존 lead 는 건드리지 않는다');
 assert.equal(vodWork((await b.vodRaws([302])).get(302),3600).reason,null,'자동·백필이 같은 판정');

 // ── 4. 하나씩: running 이어도 범위가 늘면 진척, 그대로면 멈춘다 ──
 assert.match((await cli('next','--queue',queue,'--current',current)).out,/다음 VOD 303/);
 await ck.markLeadScan(await leadId(303),{status:'running',requested:[[0,1000]],opened:[0]});
 assert.equal((await cli('after','--current',current)).code,0);
 assert.match((await cli('next','--queue',queue,'--current',current)).out,/다음 VOD 303 \[running\]/,'running 은 같은 VOD 를 잇는다');
 await ck.markLeadScan(await leadId(303),{status:'running',requested:[[0,1000]],note:'메모만'} as never);
 const stuck=await cli('after','--current',current);
 assert.equal(stuck.code,4);assert.match(stuck.out,/진척 없음/);
 await ck.markLeadScan(await leadId(303),full(3600));
 assert.match((await cli('next','--queue',queue,'--current',current)).out,/다음 VOD 304/,'시작 직전에 DB 를 다시 읽는다');
 assert.equal((await cli('access','--vod','304','--status','unavailable','--reason','비공개 안내 확인')).code,0);
 assert.equal((await cli('after','--current',current)).code,0,'접근 불가 확인도 진척');
 assert.match((await cli('next','--queue',queue,'--current',current)).out,/다음 VOD 301/);

 // ── 5. 멈춘 뒤 이어서: 기간을 안 줘도 마지막 요청을 쓰고, 끝낸 것은 다시 안 본다 ──
 await ck.markLeadScan(await leadId(301),{status:'running',requested:[[0,500]],opened:[0]});
 assert.equal((await cli('plan','--streamer','백필CLI','--write',queue)).code,0);
 assert.deepEqual([plan().from,plan().to,plan().queue],['2026-09-18','2026-09-20',[301]]);
 assert.deepEqual((await b.listRunningLeads(['bf-channel'])).map(r=>r.source_key).sort(),['vod:299','vod:301'],'멈춘 VOD 는 자동 조사도 이어받는다');
 const st=JSON.parse((await cli('status','--streamer','백필CLI')).out);
 assert.deepEqual(st.last_plan.pending.map((p:any)=>p.vod),[301]);
 assert.equal((await cli('access','--vod','304','--status','retry','--reason','사용자 재확인')).code,0);
 assert.equal((await cli('plan','--streamer','백필CLI','--write',queue)).code,0);
 assert.deepEqual(plan().queue,[304,301],'retry 는 다시 조사 대상');

 // ── 6. 페이지가 여러 장이어도 끝까지 받는다(130개 = 3페이지) ──
 assert.equal((await cli('plan','--streamer','백필CLI','--from','2026-09-01','--to','2026-09-06','--write',queue)).code,0);
 assert.equal(plan().vods.length,130);
 assert.equal((await b.getBackfillRequest('bf-channel'))?.from_date,'2026-09-01');
 console.log('백필 DB 검증 통과: 게임별 감시 명단 이관·옛 기록 정리·실제 SOOP 날짜 규칙·페이지·공통 판정·목록 밖 대조·진척 판정·재개·접근 상태');
} finally {rmSync(dir,{recursive:true,force:true});await closeDb();await server.stop();await database.close();}
