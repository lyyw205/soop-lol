/** DB/Claude 경계만 fake로 두고 실제 셸의 반복·멈춤·flock·프로세스 그룹 수명을 검증한다. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,copyFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn, type ChildProcess} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
function done(child:ChildProcess) {return new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});}
async function until(check:()=>boolean) {for(let i=0;i<100;i++){if(check())return;await delay(50);}throw new Error('fixture timeout');}
function fixture(mode:string, env:Record<string,string>={}) {
 const dir=mkdtempSync(join(tmpdir(),'ck-backfill-shell-'));
 mkdirSync(join(dir,'scripts'));mkdirSync(join(dir,'bin'));
 copyFileSync(join(import.meta.dirname,'ck-backfill.sh'),join(dir,'scripts/ck-backfill.sh'));
 // node: -e 는 진짜 node 로, ck-backfill.ts 명령은 흉내 낸다. next 는 NEXT_N 번까지 VOD 를 주고 3 으로 끝낸다.
 writeFileSync(join(dir,'bin/node'),`#!${process.execPath}\n`+String.raw`
 const fs=require('fs'), cp=require('child_process'), args=process.argv.slice(2);
 if(args[0]==='-e') {const r=cp.spawnSync(process.execPath,args,{stdio:'inherit'});process.exit(r.status??1);}
 // ck-local 준비 단계(기본) — 실제 판별기 대신 PREP 줄만 찍는다.
 if(String(args[0]).endsWith('ck-local/scan.mjs')){fs.appendFileSync(process.env.ORDER,'prep\n');console.log('PREP: ck-local run_id=fake');process.exit(Number(process.env.PREP_CODE??0));}
 // FC 앞뒤 원본 추출 — 실제로 받지 않고 순서만 남긴다.
 if(args.some(a=>String(a).endsWith('fco-context-frames.ts'))){fs.appendFileSync(process.env.ORDER,'frames:'+args[args.indexOf('--vod')+1]+'\n');process.exit(Number(process.env.FRAMES_CODE??0));}
 const command=args[2];fs.appendFileSync(process.env.ORDER,command+'\n');
 if(args.includes('--game')&&args[args.indexOf('--game')+1]!=='lol')fs.appendFileSync(process.env.GAMES??'/dev/null',command+':'+args[args.indexOf('--game')+1]+'\n');
 const opt=k=>args[args.indexOf(k)+1];
 if(command==='plan')fs.writeFileSync(opt('--write'),'{}');
 if(command==='next'){const n=fs.readFileSync(process.env.ORDER,'utf8').split('\n').filter(x=>x==='next').length;
  if(n>Number(process.env.NEXT_N??2))process.exit(3);fs.writeFileSync(opt('--current'),JSON.stringify({vod:{title_no:n}}));}
 if(command==='after')process.exit(Number(process.env.AFTER_CODE??0));
 `,{mode:0o755});
 writeFileSync(join(dir,'bin/claude'),'#!/bin/bash\n'+String.raw`
 echo claude >> "$ORDER"
 for a in "$@"; do [[ "$a" == /ck-local* ]] && echo skill:ck-local >> "$ORDER"; [[ "$a" == /ck-research* ]] && echo skill:ck-research >> "$ORDER"; [[ "$a" == /fco-match-context* ]] && echo skill:fco >> "$ORDER"; [[ "$a" == *"fco_scan"* ]] && echo fc-prompt >> "$ORDER"; [[ "$a" == *"run_id=fake"* ]] && echo got-prep >> "$ORDER"; done
 while (( $# )); do [[ "$1" == --model ]] && echo "model:$2" >> "$ORDER"; shift; done
 if flock -n out/ck/auto/.lock true; then echo unlocked >> "$ORDER"; exit 91; fi
 case "$MODE" in
   wait) trap 'echo stopped >> "$ORDER"; exit 0' TERM; while true; do sleep 0.1; done;;
   fail) exit 9;;
   stop) bash scripts/ck-backfill.sh --stop >/dev/null;;
 esac
 exit 0
 `,{mode:0o755});
 const full={...process.env,HOME:join(dir,'home'),PATH:join(dir,'bin')+':'+process.env.PATH,ORDER:join(dir,'order'),MODE:mode,...env};
 const start=(...args:string[])=>spawn('bash',[join(dir,'scripts/ck-backfill.sh'),...(args.length?args:['--streamer','test'])],{env:full,stdio:'ignore',cwd:dir});
 const order=()=>existsSync(full.ORDER)?readFileSync(full.ORDER,'utf8'):'';
 return {dir,start,order,cleanup:()=>rmSync(dir,{recursive:true,force:true})};
}
test('남은 VOD가 없을 때까지 VOD마다 세션 하나로 반복한다',async()=>{
 const f=fixture('ok');try {assert.equal(await done(f.start()),0);
  assert.equal(f.order(),'plan\nnext\nprep\nclaude\nskill:ck-local\ngot-prep\nafter\nnext\nprep\nclaude\nskill:ck-local\ngot-prep\nafter\nnext\nstatus\n');}finally{f.cleanup();}
});
test('Claude가 실패하면 진척을 기록하고 멈춘다',async()=>{
 const f=fixture('fail');try {assert.equal(await done(f.start()),9);assert.equal(f.order(),'plan\nnext\nprep\nclaude\nskill:ck-local\ngot-prep\nafter\nstatus\n');}
 finally{f.cleanup();}
});
test('진척이 없으면 4로 멈춘다',async()=>{
 const f=fixture('ok',{AFTER_CODE:'4'});try {assert.equal(await done(f.start()),4);assert.equal(f.order(),'plan\nnext\nprep\nclaude\nskill:ck-local\ngot-prep\nafter\nstatus\n');}
 finally{f.cleanup();}
});
test('--stop은 지금 VOD를 마친 뒤 멈추고 요청을 소비한다',async()=>{
 const f=fixture('stop');try {assert.equal(await done(f.start()),0);
  assert.equal(f.order(),'plan\nnext\nprep\nclaude\nskill:ck-local\ngot-prep\nafter\nstatus\n');
  assert.equal(existsSync(join(f.dir,'out/ck/backfill/STOP')),false);}finally{f.cleanup();}
});
test('지난 실행이 남긴 멈춤 요청은 새 실행을 멈추지 않는다',async()=>{
 const f=fixture('ok',{NEXT_N:'1'});try {mkdirSync(join(f.dir,'out/ck/backfill'),{recursive:true});writeFileSync(join(f.dir,'out/ck/backfill/STOP'),'');
  assert.equal(await done(f.start()),0);assert.ok(f.order().includes('claude'));}finally{f.cleanup();}
});
test('--model 은 조사 세션에만 건다. 안 주면 안 건다',async()=>{
 const f=fixture('ok');try {assert.equal(await done(f.start('--streamer','test','--model','haiku')),0);
  assert.equal((f.order().match(/model:haiku/g)??[]).length,2,'VOD 두 개 세션 다 받는다');}finally{f.cleanup();}
 const g=fixture('ok');try {assert.equal(await done(g.start()),0);
  assert.ok(!g.order().includes('model:'),'기본은 옵션을 안 붙인다');}finally{g.cleanup();}
});
test('조사 내내 flock을 보유하고 다른 실행은 75, 중단하면 자식도 종료한다',async()=>{
 const f=fixture('wait');const first=f.start();const firstDone=done(first);
 try {
  await until(()=>f.order().includes('claude'));
  assert.equal(await done(f.start()),75);
  first.kill('SIGTERM');assert.equal(await firstDone,130);
  assert.ok(f.order().includes('stopped'));
  assert.ok(!f.order().includes('unlocked'));
 }finally{first.kill('SIGTERM');await firstDone;f.cleanup();}
});

test('기본은 ck-local + 준비 단계. CK_BACKFILL_SKILL=ck-research 면 준비 없이 예전 방식', async()=>{
 const f=fixture('ok',{NEXT_N:'1',CK_BACKFILL_SKILL:'ck-research'});try {assert.equal(await done(f.start()),0);
  assert.equal(f.order(),'plan\nnext\nclaude\nskill:ck-research\nafter\nnext\nstatus\n');}finally{f.cleanup();}
 const g=fixture('ok',{NEXT_N:'1',CK_BACKFILL_PREP:''});try {assert.equal(await done(g.start()),0);
  assert.equal(g.order(),'plan\nnext\nclaude\nskill:ck-local\nafter\nnext\nstatus\n','빈 PREP 는 준비를 끈다');}finally{g.cleanup();}
});
test('준비가 실패해도 조사는 한다 — 실패를 알리고 스킬의 준비 실패 절차로', async()=>{
 const f=fixture('ok',{NEXT_N:'1',PREP_CODE:'2'});try {assert.equal(await done(f.start()),0);
  assert.equal(f.order(),'plan\nnext\nprep\nclaude\nskill:ck-local\nafter\nnext\nstatus\n');}finally{f.cleanup();}
});

test('--game fconline 은 FC 스킬·FC 지시문·FC 준비로 돌고, 모든 CLI 호출에 게임을 넘긴다', async()=>{
 const f=fixture('ok',{NEXT_N:'1'});try {assert.equal(await done(f.start('--streamer','test','--game','fconline')),0);
  const o=f.order();
  assert.ok(o.includes('skill:fco') && o.includes('fc-prompt'), o);
  assert.ok(o.indexOf('prep')<o.indexOf('claude'), '준비가 세션보다 먼저 돈다');
  assert.ok(o.indexOf('after')<o.indexOf('frames:1'), `진척 확인 뒤에 그 VOD 의 앞뒤 원본을 뽑는다: ${o}`);}finally{f.cleanup();}
 const h=fixture('ok',{NEXT_N:'2',FRAMES_CODE:'1'});try {assert.equal(await done(h.start('--streamer','test','--game','fconline')),0, '원본 추출이 실패해도 백필은 끝까지 간다');
  const o=h.order();assert.ok(o.includes('frames:1') && o.includes('frames:2'), o);}finally{h.cleanup();}
 const k=fixture('ok',{NEXT_N:'1',AFTER_CODE:'4'});try {await done(k.start('--streamer','test','--game','fconline'));
  assert.ok(!k.order().includes('frames:'), '진척이 없으면 원본을 뽑지 않는다');}finally{k.cleanup();}
 const n=fixture('ok',{NEXT_N:'1',CK_BACKFILL_FRAMES:''});try {assert.equal(await done(n.start('--streamer','test','--game','fconline')),0);
  assert.ok(!n.order().includes('frames:'), '빈 CK_BACKFILL_FRAMES 는 끈다');}finally{n.cleanup();}
 const g=fixture('ok');try {assert.equal(await done(g.start('--streamer','test','--game','dota')),1);}finally{g.cleanup();}
});
