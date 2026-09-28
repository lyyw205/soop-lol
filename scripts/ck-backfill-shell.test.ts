/** DB/Claude 경계만 fake로 두고 실제 셸·flock·프로세스 그룹의 수명을 검증한다. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,copyFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn, type ChildProcess} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
function done(child:ChildProcess) {return new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});}
async function until(check:()=>boolean) {for(let i=0;i<100;i++){if(check())return;await delay(50);}throw new Error('fixture timeout');}
function fixture(mode:string) {
 const dir=mkdtempSync(join(tmpdir(),'ck-backfill-shell-'));
 mkdirSync(join(dir,'scripts'));mkdirSync(join(dir,'bin'));
 copyFileSync(join(import.meta.dirname,'ck-backfill.sh'),join(dir,'scripts/ck-backfill.sh'));
 const node=`#!${process.execPath}\n`+String.raw`
 const fs=require('fs'), cp=require('child_process'), args=process.argv.slice(2);
 if(args[0]==='-e') {const r=cp.spawnSync(process.execPath,args,{stdio:'inherit'});process.exit(r.status??1);}
 const command=args[2];fs.appendFileSync(process.env.ORDER,command+'\n');
 if(command==='plan')fs.writeFileSync(args[args.indexOf('--write')+1],JSON.stringify({queue:[{title_no:1}],target:{slug:'test'}}));
 `;
 writeFileSync(join(dir,'bin/node'),node,{mode:0o755});
 writeFileSync(join(dir,'bin/claude'),'#!/bin/bash\n'+String.raw`
 echo claude >> "$ORDER"
 if flock -n out/ck/auto/.lock true; then echo unlocked >> "$ORDER"; exit 91; fi
 if [[ "$MODE" == wait ]]; then
   trap 'echo stopped >> "$ORDER"; exit 0' TERM
   while true; do sleep 0.1; done
 fi
 exit 9
 `,{mode:0o755});
 const env={...process.env,HOME:join(dir,'home'),PATH:join(dir,'bin')+':'+process.env.PATH,ORDER:join(dir,'order'),MODE:mode};
 const start=()=>spawn('bash',[join(dir,'scripts/ck-backfill.sh'),'--streamer','test'],{env,stdio:'ignore'});
 return {dir,start,order:()=>existsSync(env.ORDER)?readFileSync(env.ORDER,'utf8'):''};
}
test('Claude 실패 후에도 checkpoint를 실행하고 실패 종료 코드를 보존한다',async()=>{
 const f=fixture('fail');try {assert.equal(await done(f.start()),9);assert.equal(f.order(),'plan\nclaude\ncheckpoint\n');}
 finally{rmSync(f.dir,{recursive:true,force:true});}
});
test('조사 내내 flock을 보유하고 다른 실행은 75, 중단하면 자식도 종료한다',async()=>{
 const f=fixture('wait');const first=f.start();const firstDone=done(first);
 try {
  await until(()=>f.order().includes('claude'));
  assert.equal(await done(f.start()),75);
  first.kill('SIGTERM');assert.equal(await firstDone,130);
  assert.ok(f.order().includes('stopped'));
  const next=f.start();const nextDone=done(next);
  await until(()=>f.order().split('claude').length===3);
  next.kill('SIGTERM');assert.equal(await nextDone,130);
 }finally{first.kill('SIGTERM');await firstDone;rmSync(f.dir,{recursive:true,force:true});}
});
