import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collect } from './collect.mjs';
import { analyze } from './analyze.mjs';
import { normalizePost, stage, validateResult, readJson, writeJson } from './core.mjs';
import { boardGate } from '../lib/soop-board-gate.mjs';
const channel={id:'host',name:'호스트',bbsNo:'1'};
const config={pollMinutes:30,lookbackDays:7,maxPages:4,maxRequests:12,batchSize:5,maxImages:8,model:'sonnet',channels:[channel]};
const raw=(id=1,text='10월 15일 FC CK',user='host')=>({titleNo:id,userId:user,titleName:'공지',regDate:'2026-10-14 12:00:00',content:{content:text},photos:[]});
const board=(rows:unknown[],notices:unknown[]=[],total=1)=>new Response(JSON.stringify({contents:rows,noticeData:notices,meta:{totalPages:total}}));
async function temp(t: {after: (fn:()=>Promise<void>)=>void}) { const p=await mkdtemp(join(tmpdir(),'notices-test-'));t.after(()=>rm(p,{recursive:true,force:true}));return p; }
const result=(p: {key:string;revision:string})=>({results:[{key:p.key,revision:p.revision,decision:'candidate',reason:'공지',events:[{action:'new',title:'FC CK',game:'fconline',format:'ck',date:'2026-10-15',startsAt:null,timeNote:'미정',participants:[],relatedScheduleIds:[],evidence:['10월 15일 FC CK'],unknowns:[]}]}]});
test('pins included, fan posts excluded, counts do not trigger reanalysis, body edits do',()=>{
 const p=normalizePost(raw(),channel)!;const state={posts:{}};
 assert.equal(stage(state,p),true);assert.equal(stage(state,normalizePost({...raw(),count:{read:20}},channel)),false);
 assert.equal(stage(state,normalizePost(raw(1,'취소'),channel)),true);assert.equal(normalizePost(raw(2,'fan','fan'),channel),null);
});
test('poll repeated content is idempotent; pin and ordinary rows both queued',async t=>{
 const base=await temp(t);const request=async()=>board([raw(1),raw(2,'fan','fan')],[raw(3)]);
 const now=Date.now();assert.equal((await collect(base,config,{request,now})).changed,2);
 assert.equal((await collect(base,config,{request,now:now+1800001})).changed,0);
 const state=await readJson(join(base,'state.json'));assert.equal(Object.keys(state.posts).length,2);
});
test('partial pagination resumes rather than marking a truncated scan complete',async t=>{
 const base=await temp(t);const pages:number[]=[];
 const request=async(url: string)=>{const page=Number(new URL(url).searchParams.get('page'));pages.push(page);return board([raw(page)],[],2);};
 await collect(base,{...config,maxPages:1},{request});let s=await readJson(join(base,'state.json'));assert.equal(s.channels.host.partial,true);
 await collect(base,{...config,maxPages:1},{request});s=await readJson(join(base,'state.json'));assert.equal(s.channels.host.partial,false);assert.deepEqual(pages,[1,2]);
});
test('515 stops before next channel and preserves previously queued posts',async t=>{
 const base=await temp(t);let n=0;
 const r=await collect(base,{...config,channels:[channel,{...channel,id:'other'}]},{request:async()=>{n++;return new Response('',{status:515});}});
 assert.equal(n,1);assert.equal(r.errors.length,1);
});
test('empty queue does not invoke CLI; invalid output retries, success is not repeated',async t=>{
 const base=await temp(t);let calls=0;
 await analyze(base,config,{runner:async()=>{calls++;},context:async()=>[]});assert.equal(calls,0);
 await collect(base,config,{request:async()=>board([raw()])});
 await assert.rejects(analyze(base,config,{runner:async()=>({results:[]}),context:async()=>[]}));
 let state=await readJson(join(base,'state.json'));assert.equal(state.posts['host-1'].attempts,1);assert.equal(state.posts['host-1'].status,'pending');
 const now=Date.now()+3600001;
 await analyze(base,config,{now,runner:async(input: {posts: {key:string;revision:string}[]})=>{calls++;return result(input.posts[0]);},context:async()=>[]});
 state=await readJson(join(base,'state.json'));assert.equal(state.posts['host-1'].status,'done');
 await analyze(base,config,{now,runner:async()=>{calls++;},context:async()=>[]});assert.equal(calls,1);
});
test('missing images or unavailable schedule context never count as analyzed',async t=>{
 const base=await temp(t);await collect(base,config,{request:async()=>board([raw()])});
 let calls=0;await assert.rejects(analyze(base,config,{runner:async()=>{calls++;},context:async()=>{throw new Error('DB unavailable');}}));
 assert.equal(calls,0);assert.equal((await readJson(join(base,'state.json'))).posts['host-1'].status,'pending');
});
test('reject invented schedule IDs and invalid dates; unknown game forces review',()=>{
 const post=normalizePost(raw(),channel)!;const r=result(post);r.results[0].events[0].date='2026-02-30';assert.throws(()=>validateResult(r,[post]));
 const bad=result(post);(bad.results[0].events[0].relatedScheduleIds as string[]).push('invented');assert.throws(()=>validateResult(bad,[post]));
 const unknown=result(post);Object.assign(unknown.results[0].events[0],{game:null});assert.equal(validateResult(unknown,[post]).results[0].decision,'review');
 // 분류는 진행 방식 어휘·게임별 허용만 — 옛 값(showmatch)·FC 의 랜드는 거부, 모르면 unclassified.
 const old=result(post);Object.assign(old.results[0].events[0],{format:'showmatch'});assert.throws(()=>validateResult(old,[post]));
 const land=result(post);Object.assign(land.results[0].events[0],{format:'land'});assert.throws(()=>validateResult(land,[post]),/Format not allowed/);
 const none=result(post);Object.assign(none.results[0].events[0],{format:'unclassified'});assert.equal(validateResult(none,[post]).results[0].decision,'candidate');
});
test('shared board gate serializes concurrent callers and persists cooldown',async t=>{
 const base=await temp(t);const path=join(base,'gate');const times:number[]=[];
 await Promise.all([1,2,3].map(()=>boardGate(async()=>{times.push(Date.now());return new Response('{}');},{path,interval:50})));
 assert.ok(times[1]-times[0]>=45);assert.ok(times[2]-times[1]>=45);
 await boardGate(async()=>new Response('',{status:515}),{path,interval:1,cooldown:5000});
 await assert.rejects(boardGate(async()=>{throw new Error('must not fetch');},{path,interval:1}),/대기 중/);
});
test('server ignoring date filter cannot enqueue old history; old pinned notice remains visible',async t=>{
 const base=await temp(t);let calls=0;
 const old={...raw(1),regDate:'2020-01-01 12:00:00'};
 const pinned={...raw(2),regDate:'2020-01-02 12:00:00'};
 await collect(base,config,{request:async()=>{calls++;return board([old],[pinned],200);}});
 const s=await readJson(join(base,'state.json'));
 assert.equal(calls,1);assert.deepEqual(Object.keys(s.posts),['host-2']);assert.equal(s.channels.host.partial,false);
});
test('old source of a future event is rechecked even when absent from current list',async t=>{
 const base=await temp(t);const p=normalizePost(raw(),channel)!;
 await writeJson(join(base,'state.json'),{posts:{[p.key]:{revision:p.revision,channel:'host',status:'done',checkedAt:0}},channels:{}});
 const r=result(p).results[0];r.events[0].date='2099-01-01';await writeJson(join(base,'results',p.revision+'.json'),r);
 const urls:string[]=[];await collect(base,config,{request:async(url:string)=>{urls.push(url);return url.includes('/post/')?new Response(JSON.stringify(raw(1,'취소'))):board([]);}});
 assert.equal(urls.length,2);assert.equal((await readJson(join(base,'state.json'))).posts[p.key].status,'pending');
});
test('attachment failure retains pending work without invoking the CLI',async t=>{
 const base=await temp(t);await collect(base,config,{request:async()=>board([raw()])});let calls=0;
 const r=await analyze(base,config,{images:async()=>{throw new Error('image unavailable');},runner:async()=>{calls++;},context:async()=>[]});
 assert.equal(r.failed,1);assert.equal(calls,0);assert.equal((await readJson(join(base,'state.json'))).posts['host-1'].status,'pending');
});
