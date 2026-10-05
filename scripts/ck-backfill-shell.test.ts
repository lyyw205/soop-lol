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
 mkdirSync(join(dir,'scripts/lib'),{recursive:true});mkdirSync(join(dir,'bin'));
 copyFileSync(join(import.meta.dirname,'ck-backfill.sh'),join(dir,'scripts/ck-backfill.sh'));
 copyFileSync(join(import.meta.dirname,'ck-backfill-par.sh'),join(dir,'scripts/ck-backfill-par.sh'));
 copyFileSync(join(import.meta.dirname,'ck-session-usage.ts'),join(dir,'scripts/ck-session-usage.ts'));
 copyFileSync(join(import.meta.dirname,'lib/ck-session-usage.ts'),join(dir,'scripts/lib/ck-session-usage.ts'));
 copyFileSync(join(import.meta.dirname,'ck-image-budget.ts'),join(dir,'scripts/ck-image-budget.ts'));
 copyFileSync(join(import.meta.dirname,'lib/ck-image-budget.ts'),join(dir,'scripts/lib/ck-image-budget.ts'));
 // node: -e 는 진짜 node 로, ck-backfill.ts 명령은 흉내 낸다. next 는 NEXT_N 번까지 VOD 를 주고 3 으로 끝낸다.
 writeFileSync(join(dir,'bin/node'),`#!${process.execPath}\n`+String.raw`
 const fs=require('fs'), cp=require('child_process'), args=process.argv.slice(2);
 if(args[0]==='-e') {const r=cp.spawnSync(process.execPath,args,{stdio:'inherit'});process.exit(r.status??1);}
 // ck-local 준비 단계(기본) — 실제 판별기 대신 PREP 줄만 찍는다.
 if(String(args[0]).endsWith('ck-local/scan.mjs')){fs.appendFileSync(process.env.ORDER,'prep\n');console.log('PREP: ck-local run_id=fake');process.exit(Number(process.env.PREP_CODE??0));}
 if(['ck-session-usage.ts','ck-image-budget.ts'].some(p=>String(args[0]).endsWith(p))){const r=cp.spawnSync(process.execPath,args,{stdio:'inherit'});process.exit(r.status??1);}
 // FC 앞뒤 원본 추출 — 실제로 받지 않고 순서만 남긴다.
 if(args.some(a=>String(a).endsWith('fco-context-frames.ts'))){fs.appendFileSync(process.env.ORDER,'frames:'+args[args.indexOf('--vod')+1]+'\n');process.exit(Number(process.env.FRAMES_CODE??0));}
 const command=args[2];fs.appendFileSync(process.env.ORDER,command+'\n');
 if(args.includes('--game')&&args[args.indexOf('--game')+1]!=='lol')fs.appendFileSync(process.env.GAMES??'/dev/null',command+':'+args[args.indexOf('--game')+1]+'\n');
 const opt=k=>args[args.indexOf(k)+1];
 if(command==='target')fs.writeFileSync(opt('--write'),JSON.stringify({channel_id:process.env.SAME_CHANNEL??(process.env.ALIAS_CHANNEL&&opt('--streamer').startsWith('alias-')?process.env.ALIAS_CHANNEL:opt('--streamer'))}));
 if(command==='plan')fs.writeFileSync(opt('--write'),'{}');
 if(command==='next'){const n=fs.readFileSync(process.env.ORDER,'utf8').split('\n').filter(x=>x==='next').length;
  if(process.env.NEXT_CODE)process.exit(Number(process.env.NEXT_CODE));
  if(n>Number(process.env.NEXT_N??2))process.exit(3);fs.writeFileSync(opt('--current'),JSON.stringify({vod:{title_no:n}}));}
 if(command==='after'){fs.writeFileSync(require('path').join(require('path').dirname(opt('--current')),'after.json'),JSON.stringify({vod:1,before:{saved_matches:0},after:{saved_matches:2}}));process.exit(Number(process.env.AFTER_CODE??0));}
 `,{mode:0o755});
 writeFileSync(join(dir,'bin/claude'),'#!/bin/bash\n'+String.raw`
 if [[ "$1" == --version ]]; then echo '2.1.285 (Claude Code)'; exit 0; fi
 echo claude >> "$ORDER"
 if [[ -n "$PROMPT_LOG" ]]; then printf '%s\n' "$@" >> "$PROMPT_LOG"; fi
 for a in "$@"; do [[ "$a" == /ck-local* ]] && echo skill:ck-local >> "$ORDER"; [[ "$a" == /ck-research* ]] && echo skill:ck-research >> "$ORDER"; [[ "$a" == /fco-match-context* ]] && echo skill:fco >> "$ORDER"; [[ "$a" == *"fco_scan"* ]] && echo fc-prompt >> "$ORDER"; [[ "$a" == *"run_id=fake"* ]] && echo got-prep >> "$ORDER"; done
 while (( $# )); do [[ "$1" == --model ]] && echo "model:$2" >> "$ORDER"; shift; done
 if flock -n out/ck/auto/.lock true; then echo unlocked >> "$ORDER"; exit 91; fi
 case "$MODE" in
   slow) sleep 0.3;;
   wait) trap 'echo stopped >> "$ORDER"; exit 0' TERM; while true; do sleep 0.1; done;;
   fail) exit 9;;
   stop) bash scripts/ck-backfill.sh --stop >/dev/null;;
 esac
 echo '{"type":"result","result":"2경기 저장. 다음 위치 1200초, 미완료","usage":{"input_tokens":2,"cache_creation_input_tokens":100,"cache_read_input_tokens":900,"output_tokens":20}}'
 exit 0
 `,{mode:0o755});
 const full={...process.env,HOME:join(dir,'home'),PATH:join(dir,'bin')+':'+process.env.PATH,ORDER:join(dir,'order'),MODE:mode,...env};
 const start=(...args:string[])=>spawn('bash',[join(dir,'scripts/ck-backfill.sh'),...(args.length?args:['--streamer','test'])],{env:full,stdio:'ignore',cwd:dir});
 const order=()=>existsSync(full.ORDER)?readFileSync(full.ORDER,'utf8'):'';
 const startPar=(...args:string[])=>spawn('bash',[join(dir,'scripts/ck-backfill-par.sh'),...args],{env:full,stdio:'ignore',cwd:dir});
 return {dir,start,startPar,order,cleanup:()=>rmSync(dir,{recursive:true,force:true})};
}
test('남은 VOD가 없을 때까지 VOD마다 세션 하나로 반복한다',async()=>{
 const f=fixture('ok');try {assert.equal(await done(f.start()),0);
  assert.equal(f.order(),'target\nplan\nnext\nprep\nclaude\nskill:ck-local\ngot-prep\nmodel:sonnet\nafter\nnext\nprep\nclaude\nskill:ck-local\ngot-prep\nmodel:sonnet\nafter\nnext\nstatus\n');}finally{f.cleanup();}
});
test('Claude가 실패하면 진척을 기록하고 멈춘다',async()=>{
 const f=fixture('fail');try {assert.equal(await done(f.start()),9);assert.equal(f.order(),'target\nplan\nnext\nprep\nclaude\nskill:ck-local\ngot-prep\nmodel:sonnet\nafter\nstatus\n');}
 finally{f.cleanup();}
});
test('--max-sessions는 저장·진척 확인 후 멈추고 다음 VOD를 선택하지 않는다',async()=>{
 const f=fixture('ok');try {assert.equal(await done(f.start('--streamer','test','--max-sessions','1')),0);
  assert.equal(f.order(),'target\nplan\nnext\nprep\nclaude\nskill:ck-local\ngot-prep\nmodel:sonnet\nafter\nstatus\n');}finally{f.cleanup();}
 const g=fixture('fail');try {assert.equal(await done(g.start('--streamer','test','--max-sessions','1')),9);}finally{g.cleanup();}
});
test('진척이 없으면 4로 멈춘다',async()=>{
 const f=fixture('ok',{AFTER_CODE:'4'});try {assert.equal(await done(f.start()),4);assert.equal(f.order(),'target\nplan\nnext\nprep\nclaude\nskill:ck-local\ngot-prep\nmodel:sonnet\nafter\nstatus\n');}
 finally{f.cleanup();}
});
test('이미지 제한 경로도 최종 결과와 DB 확인을 보존하고 기본 거부 설정을 쓴다',async()=>{
 const f=fixture('ok');try{
  assert.equal(await done(f.start('--streamer','test','--image-limit-mib','12','--max-sessions','1')),0);
  assert.match(f.order(),/claude[\s\S]*after\nstatus/);
  const {readdirSync}=await import('node:fs');
  const run=readdirSync(join(f.dir,'out/ck/backfill')).find(x=>x.startsWith('run-'))!;
  const dir=join(f.dir,'out/ck/backfill',run);
  const settings=JSON.parse(readFileSync(join(dir,'image-1.json.settings.json'),'utf8'));
  assert.ok(settings.permissions.ask.includes('Read'));assert.ok(settings.hooks.PermissionRequest);
  assert.equal(JSON.parse(readFileSync(join(dir,'session-1.json'),'utf8')).type,'result');
  assert.ok(existsSync(join(dir,'usage.jsonl')));
 }finally{f.cleanup();}
 const g=fixture('ok',{AFTER_CODE:'4'});try{
  assert.equal(await done(g.start('--streamer','test','--image-limit-mib','12')),4);
  assert.equal(g.order().split('\n').filter(x=>x==='claude').length,1);
 }finally{g.cleanup();}
});
test('반복 제한으로 next가 보류하면 Claude나 준비를 시작하지 않는다',async()=>{
 const f=fixture('ok',{NEXT_CODE:'4'});try{assert.equal(await done(f.start()),4);
  assert.equal(f.order(),'target\nplan\nnext\nstatus\n');
 }finally{f.cleanup();}
});
test('run.log에 조사 요약과 원본 경로가 남고 usage.jsonl도 함께 기록된다',async()=>{
 const f=fixture('ok',{NEXT_N:'1'});try{
  assert.equal(await done(f.start()),0);
  const {readdirSync}=await import('node:fs');
  const run=readdirSync(join(f.dir,'out/ck/backfill')).find(n=>n.startsWith('run-'))!;
  const path=join(f.dir,'out/ck/backfill',run);
  const log=readFileSync(join(path,'run.log'),'utf8');
  assert.match(log,/조사 요약: 2경기 저장/);assert.match(log,/세션 결과 원본: .*session-1.json/);
  assert.equal(JSON.parse(readFileSync(join(path,'usage.jsonl'),'utf8')).cache_read_input_tokens,900);
 }finally{f.cleanup();}
});
test('--stop은 지금 VOD를 마친 뒤 멈추고 요청을 소비한다',async()=>{
 const f=fixture('stop');try {assert.equal(await done(f.start()),0);
  assert.equal(f.order(),'target\nplan\nnext\nprep\nclaude\nskill:ck-local\ngot-prep\nmodel:sonnet\nafter\nstatus\n');
  assert.equal(existsSync(join(f.dir,'out/ck/backfill/STOP')),false);}finally{f.cleanup();}
});
test('지난 실행이 남긴 멈춤 요청은 새 실행을 멈추지 않는다',async()=>{
 const f=fixture('ok',{NEXT_N:'1'});try {mkdirSync(join(f.dir,'out/ck/backfill'),{recursive:true});writeFileSync(join(f.dir,'out/ck/backfill/STOP'),'');
  assert.equal(await done(f.start()),0);assert.ok(f.order().includes('claude'));}finally{f.cleanup();}
});
test('--model 은 조사 세션에만 건다. 기본도 sonnet으로 고정한다',async()=>{
 const f=fixture('ok');try {assert.equal(await done(f.start('--streamer','test','--model','haiku')),0);
  assert.equal((f.order().match(/model:haiku/g)??[]).length,2,'VOD 두 개 세션 다 받는다');}finally{f.cleanup();}
 const g=fixture('ok');try {assert.equal(await done(g.start()),0);
  assert.equal((g.order().match(/model:sonnet/g)??[]).length,2);}finally{g.cleanup();}
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
  assert.equal(f.order(),'target\nplan\nnext\nclaude\nskill:ck-research\nmodel:sonnet\nafter\nnext\nstatus\n');}finally{f.cleanup();}
 const g=fixture('ok',{NEXT_N:'1',CK_BACKFILL_PREP:''});try {assert.equal(await done(g.start()),0);
  assert.equal(g.order(),'target\nplan\nnext\nclaude\nskill:ck-local\nmodel:sonnet\nafter\nnext\nstatus\n','빈 PREP 는 준비를 끈다');}finally{g.cleanup();}
});
test('준비가 실패해도 조사는 한다 — 실패를 알리고 스킬의 준비 실패 절차로', async()=>{
 const f=fixture('ok',{NEXT_N:'1',PREP_CODE:'2'});try {assert.equal(await done(f.start()),0);
  assert.equal(f.order(),'target\nplan\nnext\nprep\nclaude\nskill:ck-local\nmodel:sonnet\nafter\nnext\nstatus\n');}finally{f.cleanup();}
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

test('병렬 실행 — 스트리머마다 워커 하나, 모두 끝까지 돌고 잠금은 부모 하나만 쥔다',async()=>{
 const f=fixture('ok',{NEXT_N:'1'});try {assert.equal(await done(f.startPar('--jobs','2','--streamer','a','--streamer','b','--streamer','c')),0);
  const o=f.order();
  assert.equal((o.match(/^plan$/gm)??[]).length,3,'스트리머 셋 다 계획을 세운다');
  assert.equal((o.match(/^status$/gm)??[]).length,3,'스트리머 셋 다 끝까지 간다');
  assert.ok(!o.includes('unlocked'),'조사 내내 부모의 잠금이 유지된다');}finally{f.cleanup();}
});
test('병렬 실행 중 다른 백필은 75, 중단하면 워커의 자식까지 종료한다',async()=>{
 const f=fixture('wait');const par=f.startPar('--jobs','2','--streamer','a','--streamer','b');const parDone=done(par);
 try {
  await until(()=>f.order().includes('claude'));
  assert.equal(await done(f.start()),75);
  par.kill('SIGTERM');assert.equal(await parDone,130);
  await until(()=>f.order().includes('stopped'));
 }finally{par.kill('SIGTERM');await parDone;f.cleanup();}
});
test('병렬 실행 — Claude 가 실패하면 남은 스트리머를 시작하지 않는다',async()=>{
 const f=fixture('fail');try {assert.equal(await done(f.startPar('--jobs','1','--streamer','a','--streamer','b','--streamer','c')),9);
  assert.equal((f.order().match(/^plan$/gm)??[]).length,1);}finally{f.cleanup();}
});

test('병렬 실행 — 진척 없는 채널 뒤에도 나머지를 확인하고 전체 종료 코드는 4다',async()=>{
 const f=fixture('ok',{AFTER_CODE:'4',NEXT_N:'99'});try {
  assert.equal(await done(f.startPar('--jobs','1','--streamer','a','--streamer','b','--streamer','c')),4);
  assert.equal((f.order().match(/^plan$/gm)??[]).length,3);
  assert.equal((f.order().match(/^after$/gm)??[]).length,3);
 }finally{f.cleanup();}
});

test('다른 별칭이 같은 채널이면 병렬 워커를 중복 배정하지 않는다',async()=>{
 const f=fixture('wait',{SAME_CHANNEL:'canonical'});
 const par=f.startPar('--jobs','2','--streamer','alias-a','--streamer','alias-b');const parDone=done(par);
 try {
  await until(()=>f.order().includes('claude')&&(f.order().match(/^target$/gm)??[]).length===2);
  assert.equal((f.order().match(/^plan$/gm)??[]).length,1,'채널 잠금을 얻은 워커만 계획/조사한다');
  par.kill('SIGTERM');assert.equal(await parDone,130);
 }finally{par.kill('SIGTERM');await parDone;f.cleanup();}
});
test('병렬 채널 잠금 충돌은 건너뛰고 세 번째 독립 채널까지 처리한다',async()=>{
 const f=fixture('slow',{ALIAS_CHANNEL:'canonical',NEXT_N:'99'});try{
  assert.equal(await done(f.startPar('--jobs','2','--max-sessions','1','--streamer','alias-a','--streamer','alias-b','--streamer','third')),0);
  assert.equal((f.order().match(/^target$/gm)??[]).length,3);
  assert.equal((f.order().match(/^plan$/gm)??[]).length,2);
  assert.equal((f.order().match(/^claude$/gm)??[]).length,2);
 }finally{f.cleanup();}
});

test('세션 분량은 인계 요약과 함께 전달하고 0이면 분할 목표를 끈다',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ck-prompt-'));const log=join(dir,'prompt');
 const f=fixture('ok',{NEXT_N:'1',PROMPT_LOG:log});try {
  const d=fixture('ok',{NEXT_N:'1',PROMPT_LOG:log});try {
   assert.equal(await done(d.start()),0);
   assert.doesNotMatch(readFileSync(log,'utf8'),/이번 세션 목표는/,'측정 전에는 분할을 기본으로 켜지 않는다');
  }finally{d.cleanup();}
  writeFileSync(log,'');
  assert.equal(await done(f.start('--streamer','test','--session-games','3')),0);
  const prompt=readFileSync(log,'utf8');assert.match(prompt,/새 경기\/시점 3 개/);assert.match(prompt,/resume.json/);
  assert.match(prompt,/--output-format\njson/);
  assert.equal(await done(f.start('--streamer','test','--session-games','invalid')),1);
  writeFileSync(log,'');
  const g=fixture('ok',{NEXT_N:'1',PROMPT_LOG:log});try {
   assert.equal(await done(g.start('--streamer','test','--session-games','0')),0);
   assert.doesNotMatch(readFileSync(log,'utf8'),/이번 세션 목표는/);
  }finally{g.cleanup();}
 }finally{f.cleanup();rmSync(dir,{recursive:true,force:true});}
});
