import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';

test('이미지 저장 유예가 끝나면 자식 그룹을 회수하고 정상 결과를 꾸미지 않는다',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ck-image-runner-')),state=join(dir,'state.json'),output=join(dir,'result.json');
 const fake=join(dir,'claude.cjs');
 writeFileSync(fake,`#!${process.execPath}\n`+String.raw`
 const fs=require('fs'),cp=require('child_process');
 if(process.argv.includes('--version')){console.log('2.1.293 (Claude Code)');process.exit(0);}
 const s=JSON.parse(fs.readFileSync(process.env.TEST_STATE,'utf8'));s.flushAt=Date.now()-s.flushMs-1;fs.writeFileSync(process.env.TEST_STATE,JSON.stringify(s));
 const child=cp.spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'inherit'});
 fs.writeFileSync(process.env.TEST_PID,String(child.pid));
 process.on('SIGTERM',()=>{});setInterval(()=>{},1000);
 `,{mode:0o755});
 const child=spawn(process.execPath,[join(import.meta.dirname,'ck-image-budget.ts'),'run','--state',state,'--output',output,
  '--vod','1','--flush-seconds','1','--',fake],{env:{...process.env,TEST_STATE:state,TEST_PID:join(dir,'child.pid')},stdio:'pipe'});
 let stderr='';child.stderr.on('data',x=>stderr+=x);
 try {
  const code=await new Promise<number|null>((done,reject)=>{child.once('error',reject);child.once('close',done);});
  assert.equal(code,20,stderr);assert.equal(existsSync(output),false);
  assert.equal(JSON.parse(readFileSync(output+'.exit.json','utf8')).reason,'image_flush_timeout');
  const pid=Number(readFileSync(join(dir,'child.pid'),'utf8'));
  // 종료 직후 init에 회수되기 전 좀비도 실행 중인 프로세스가 아니다.
  let status='';try{status=readFileSync(`/proc/${pid}/stat`,'utf8');}catch{}
  assert.ok(!status || status.split(' ')[2]==='Z',status);
 }finally{child.kill('SIGTERM');rmSync(dir,{recursive:true,force:true});}
});
