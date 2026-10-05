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
 // 전체 탐색 범위가 이미 찍힌 뒤의 경기 저장도 진척이다. 같은 경기 재제출은 아니다.
 await ck.markLeadScan(await leadId(303),{status:'running',requested:[[0,3600]],opened:[0],
   resume:{next_action:'두 번째 경기 결과 확인',next_at:1800,context:['앞 경기 저장 완료']}});
 assert.equal((await cli('next','--queue',queue,'--current',current)).code,0);
 await ck.upsertMatchFromScan({match_id:'backfill:progress',played_at:new Date('2026-09-20T00:00:00Z'),played_at_precision:'date',
  winning_team:100,participants:[{streamer_id:s.id,participant_id:1,team_id:100,champion_id:103}]});
 await db()`INSERT INTO match_pov(match_id,lead_id,role,source) VALUES('backfill:progress',${await leadId(303)}::uuid,'created','own')`;
 assert.equal((await cli('after','--current',current)).code,0,'새 시점 저장은 진척');
 assert.equal((await cli('next','--queue',queue,'--current',current)).code,0);
 const resume=JSON.parse(readFileSync(join(dir,'resume.json'),'utf8'));
 assert.deepEqual(resume.saved_matches.map((m:any)=>m.match_id),['backfill:progress']);
 assert.equal(resume.scan.resume.next_at,1800); assert.equal(resume.identities[0].display_name,'백필CLI');
 assert.equal((await cli('after','--current',current)).code,4,'같은 저장을 다시 세지 않는다');
 // 새 프로세스로 재실행해도 열람뿐인 세션의 횟수는 유지한다. DB 완료 도장은 바꾸지 않는다.
 const guardDir=join(dir,'guards'),guardFile=join(guardDir,'lol-303.json');
 for(let n=1;n<=3;n++){
  assert.equal((await cli('next','--queue',queue,'--current',current,'--guard-dir',guardDir)).code,0);
  await ck.markLeadScan(await leadId(303),{status:'running',opened:[100+n]});
  assert.equal((await cli('after','--current',current,'--guard-dir',guardDir)).code,n===3?4:0);
  assert.equal(JSON.parse(readFileSync(guardFile,'utf8')).no_outcome_sessions,n);
 }
 assert.equal((await cli('after','--current',current,'--guard-dir',guardDir)).code,4);
 assert.equal(JSON.parse(readFileSync(guardFile,'utf8')).no_outcome_sessions,3,'after 중복 호출은 두 번 세지 않음');
 assert.equal((await cli('next','--queue',queue,'--current',current,'--guard-dir',guardDir)).code,4,'재실행도 보류');
 assert.equal((await b.vodRaws([303])).get(303)?.scan.status,'running','반복 제한은 완료 도장을 만들지 않음');
 assert.equal((await cli('next','--queue',queue,'--current',current,'--guard-dir',guardDir,'--reset-stall')).code,0,'명시적 초기화 후 재개');
 await assert.rejects(ck.markLeadScan(await leadId(303),{status:'running',resume:{next_action:'다음',next_at:-1}}),/next_at/);
 await ck.markLeadScan(await leadId(303),full(3600));
 // ★ FC 도장(fco_scan)은 롤 도장(scan)과 따로 쓰이고 서로 지우지 않는다(같은 VOD 를 두 게임이 따로 끝낸다).
 await ck.markLeadScan(await leadId(303),{status:'running',requested:[[0,500]]},{key:'fco_scan'});
 { const r=(await db()`SELECT raw FROM event_lead WHERE id=${await leadId(303)}::uuid`)[0].raw;
   assert.equal(r.scan.status,'done','FC 도장을 써도 롤 도장이 그대로다'); assert.equal(r.fco_scan.status,'running'); }
 await ck.markLeadScan(await leadId(303),full(3600));
 { const r=(await db()`SELECT raw FROM event_lead WHERE id=${await leadId(303)}::uuid`)[0].raw;
   assert.equal(r.fco_scan?.status,'running','롤 도장을 다시 써도 FC 도장이 그대로다'); }
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
 // ── 7. FC 백필(--game fconline)은 따로 센다 — 롤 완료 VOD 도 FC 로는 미조사, 요청 기간도 따로 저장 ──
 assert.equal((await cli('plan','--streamer','백필CLI','--from','2026-09-18','--to','2026-09-20','--write',queue,'--game','fconline')).code,0);
 assert.ok(plan().queue.includes(302),'롤로 끝낸 VOD(302)도 FC 큐에는 들어간다');
 assert.equal((await b.getBackfillRequest('bf-channel'))?.from_date,'2026-09-01','FC 요청이 롤 요청 기간을 덮지 않는다');
 assert.equal((await b.getBackfillRequest('bf-channel','fconline'))?.from_date,'2026-09-18');
 await ck.markLeadScan(await leadId(302),full(3599),{key:'fco_scan'});
 assert.equal((await cli('plan','--streamer','백필CLI','--write',queue,'--game','fconline')).code,0);
 assert.ok(!plan().queue.includes(302),'FC 도장이 찍히면 FC 큐에서 빠진다(기간은 FC 마지막 요청을 쓴다)');
 assert.equal((await cli('plan','--streamer','백필CLI','--write',queue)).code,0);
 assert.equal(plan().from,'2026-09-01','롤 이어 하기는 롤의 마지막 요청 기간을 쓴다');
 // 이미지 차단 시 개요만 봤거나 판독 중이어도 기존 ck:merge가 저장·재개를 지원한다.
 const partialFile=join(dir,'partial.json');
 const mergePartial=async(value:unknown)=>{
  writeFileSync(partialFile,JSON.stringify(value));await closeDb();
  return new Promise<{code:number;out:string}>(resolve=>execFile(process.execPath,
   [join(import.meta.dirname,'ck-merge.mjs'),'--result',partialFile],{cwd:join(import.meta.dirname,'..'),env:process.env,timeout:30000},
   (e,stdout,stderr)=>resolve({code:e?Number((e as any).code??1):0,out:stdout+stderr})));
 };
 const partial={resultType:'scan',lead:{source_key:'vod:999999990',title:'이미지 제한 시험',observed_at:'2026-09-20T00:00:00Z'},
  scan:{status:'running',requested:[[0,600]],opened:[],note:'개요 1페이지에서 게임 구간 확인. 원본은 아직 안 봄',
   resume:{next_action:'600초 이후 개요와 원본 확인',next_at:600}}};
 const firstPartial=await mergePartial(partial);assert.equal(firstPartial.code,0,firstPartial.out);
 const initial=await b.backfillContext(999999990);assert.equal(initial?.scan?.status,'running');assert.equal(initial?.scan?.opened_count,0);
 assert.equal(initial?.scan?.resume?.next_at,600);
 const secondPartial=await mergePartial({...partial,candidates:[{id:'partial-name',at:[550,600],conclusion:'unresolved',
  observed:'경기 화면이 있으나 이름 두 칸은 아직 확인 못함',why:'이미지 한도로 추가 확인 중단',open_questions:['다음 세션에 이름 확인']} ]});
 assert.equal(secondPartial.code,0,secondPartial.out);
 const reread=await b.backfillContext(999999990);assert.equal(reread?.candidates[0].conclusion,'unresolved');
 assert.equal(reread?.saved_matches.length,0,'모르는 값으로 경기를 만들지 않는다');
 assert.ok((await db()`SELECT body FROM review_record WHERE candidate_id='partial-name' AND type='question'`).some((r:any)=>r.body==='다음 세션에 이름 확인'));
 assert.equal(vodWork((await b.vodRaws([999999990])).get(999999990),1200).reason,'running');
 // 탐색 완료와 값 확정은 별개다. done 저장이 미해결 후보·질문을 지우지 않는다.
 assert.ok(reread?.completion_policy?.done);
 assert.equal((await b.backfillContext(999999990,'fconline'))?.completion_policy,undefined);
 const finishedPartial=await mergePartial({...partial,scan:{status:'done',requested:[[0,1200]],opened:[600],
  note:'시험: 필수 탐색과 교차검증 처리 완료. 이름은 식별 근거가 없어 검수 질문으로 보존',resume:null}});
 assert.equal(finishedPartial.code,0,finishedPartial.out);
 const completeWithQuestions=vodWork((await b.vodRaws([999999990])).get(999999990),1200);
 assert.equal(completeWithQuestions.reason,null);assert.equal(completeWithQuestions.unresolved,1);
 assert.equal((await b.backfillContext(999999990))?.candidates[0].conclusion,'unresolved');
 assert.ok((await db()`SELECT body FROM review_record WHERE candidate_id='partial-name' AND type='question'`).length);
 // ── 요청 범위(requested)는 실행기의 것이다 — 세션이 조각으로 바꿔도 저장된 범위는 줄지 않고, 조용한 partial 도 없다 ──
 const setTotal=async(n:number,sec:number)=>{await db()`UPDATE event_lead SET raw=raw||${db().json({vod_total_sec:sec} as never)} WHERE source_key=${`vod:${n}`}`;};
 const rawOf=async(n:number)=>(await b.vodRaws([n])).get(n)!;
 const lead992={source_key:'vod:999999992',title:'요청 범위 시험',observed_at:'2026-09-20T00:00:00Z'};
 // 실행기의 준비 초안: 전체 범위를 running 으로 먼저 저장한다(ck-local 준비 → --finish --status running 과 같은 모양).
 assert.equal((await mergePartial({resultType:'scan',lead:lead992,scan:{status:'running',requested:[[0,1200]],sampled:[[0,1200]],opened:[100],note:'준비'}})).code,0);
 await setTotal(999999992,1200);
 // b. 세션이 조각 requested 로 running 중간 저장을 해도 줄지 않는다.
 assert.equal((await mergePartial({resultType:'scan',lead:lead992,scan:{status:'running',requested:[[300,400]],opened:[300],resume:{next_action:'400초 이후',next_at:400}},
  candidates:[{id:'req-c1',at:[300,400],conclusion:'unresolved',observed:'결과창 후보',why:'원본 확인 중',open_questions:['승패']}]})).code,0);
 assert.deepEqual((await rawOf(999999992)).scan.requested,[[0,1200]],'running 중간 저장이 requested 를 줄이지 않는다');
 // a. 이전에 막히던 시나리오: 조각 requested 로 done 을 저장해도 전체 범위가 유지돼 완료로 읽힌다.
 const doneInput={resultType:'scan',lead:lead992,scan:{status:'done',requested:[[300,400]],opened:[300,360],note:'마무리',resume:null},
  candidates:[{id:'req-c1',at:[300,400],conclusion:'not_target',observed:'솔랭 시청',why:'참가자 아님'}]};
 const doneRes=await mergePartial(doneInput);assert.equal(doneRes.code,0,doneRes.out);
 assert.ok(!doneRes.out.includes('요청 범위가 영상 끝까지'),'범위가 찼으면 경고하지 않는다');
 const doneRaw=await rawOf(999999992);
 assert.deepEqual(doneRaw.scan.requested,[[0,1200]]);assert.equal(vodWork(doneRaw,null).reason,null,'done 이 partial 로 남지 않는다');
 // c. 세션이 한 일은 기존 필드에 남는다.
 assert.deepEqual(doneRaw.scan.opened,[100,300,360]);assert.equal(doneRaw.candidates[0].conclusion,'not_target');assert.match(doneRaw.scan.note,/마무리/);
 // e. 같은 입력을 다시 처리해도 같다.
 const doneAgain=await mergePartial(doneInput);assert.equal(doneAgain.code,0,doneAgain.out);
 assert.deepEqual(await rawOf(999999992),doneRaw,'재처리는 멱등');
 // 3. 범위가 처음부터 덜 찬 채로 done 이 들어오면(예: 조각만 훑은 초안) 저장은 하되 분명히 알리고 비 0 으로 끝낸다.
 const lead993={source_key:'vod:999999993',title:'범위 부족 시험',observed_at:'2026-09-20T00:00:00Z'};
 assert.equal((await mergePartial({resultType:'scan',lead:lead993,scan:{status:'running',requested:[[0,100]],opened:[1]}})).code,0);
 await setTotal(999999993,1200);
 const gap=await mergePartial({resultType:'scan',lead:lead993,scan:{status:'done',requested:[[0,100]],opened:[1,50]}});
 assert.equal(gap.code,3,gap.out);assert.match(gap.out,/요청 범위가 영상 끝까지 덮이지 않았다/);
 assert.equal(vodWork(await rawOf(999999993),null).reason,'partial','저장은 됐다(근거 보존) — 다만 partial 이라고 크게 알렸다');
 // d. FC 조사 도장(fco_scan)은 requested 의미가 달라 그대로다 — 조각으로 done 을 저장하면 FC 큐에서 partial.
 await ck.upsertEventLead({source:'vod_title',source_key:'vod:999999994',channel_id:'bf-channel',title:'FC 시험',observed_at:new Date('2026-09-20T00:00:00Z'),raw:{vod_total_sec:1200}});
 await ck.markLeadScan(await leadId(999999994),{status:'done',requested:[[300,400]],opened:[300]},{key:'fco_scan'});
 assert.deepEqual((await rawOf(999999994)).fco_scan.requested,[[300,400]]);
 assert.equal(vodWork(await rawOf(999999994),null,'fco_scan').reason,'partial');
 await ck.markLeadScan(await leadId(999999994),{status:'done',requested:[[0,1200]],opened:[300]},{key:'fco_scan'});
 assert.equal(vodWork(await rawOf(999999994),null,'fco_scan').reason,null);
 // 5. 과거에 done 인데 범위가 partial 로 남은 VOD 는 status 가 따로 보여 준다(읽기 전용).
 await ck.markLeadScan(await leadId(1000),{status:'done',requested:[[0,10]],opened:[1],failed:[]},{mode:'replace'});
 const stat=await cli('status','--streamer','백필CLI');assert.equal(stat.code,0,stat.out);
 assert.ok(JSON.parse(stat.out).last_plan.done_range_gap_vods.some((x:any)=>x.vod===1000),stat.out);
 assert.equal((await cli('plan','--streamer','백필CLI','--from','2026-09-18','--to','2026-09-20','--vod','301','--write',queue)).code,0);
 assert.deepEqual(plan().vods.map((v:any)=>v.title_no),[301],'단일 VOD 시험이 같은 날 다른 VOD를 실행하지 않는다');
 assert.equal((await cli('plan','--streamer','백필CLI','--vod','999999991','--write',queue)).code,1,'없는 VOD를 전체 큐로 해석하지 않는다');
 console.log('백필 DB 검증 통과: 게임별 큐·완료·재개·반복 제한·개요/부분 판독의 실제 ck:merge 저장');
} finally {rmSync(dir,{recursive:true,force:true});await closeDb();await server.stop();await database.close();}
