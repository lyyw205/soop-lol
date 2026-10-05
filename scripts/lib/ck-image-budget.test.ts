import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {createBudget,admitImage,imageCharge,isFlushCommand,MIB} from './ck-image-budget.ts';

test('base64 경계·재열람을 합산하고 저장 뒤에도 이미지 계수가 유지된다',()=>{
  const s=createBudget('test','/tmp',1,0.5,1);
  assert.equal(admitImage(s,'one',MIB/2,100),true);assert.equal(s.warned,true);
  assert.equal(admitImage(s,'one',MIB/2,200),true);assert.equal(s.reads.one,2);
  assert.equal(admitImage(s,'two',1,300),false);assert.equal(s.flushAt,300);assert.equal(s.bytes,MIB);
  assert.equal(admitImage(s,'two',0,400),false);assert.equal(s.flushAt,300);
});
test('작은 이미지도 개수 상한을 넘지 않고 잘못된 한도는 거부한다',()=>{
  const s=createBudget('test','/tmp',1);for(let i=0;i<60;i++)assert.equal(admitImage(s,String(i),1),true);
  assert.equal(admitImage(s,'61',1),false);
  for(const [w,l] of [[0,12],[12,8],[8,13],[NaN,12]])assert.throws(()=>createBudget('test','/tmp',1,w,l));
});
test('원본 헤더·크기로 선계수하며 이미지 변환 없이 미검증 입력을 거부한다',()=>{
  const dir=mkdtempSync(join(tmpdir(),'ck-image-'));
  try {
    const png=Buffer.alloc(64);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);png.writeUInt32BE(1920,16);png.writeUInt32BE(1080,20);
    const path=join(dir,'image.png');writeFileSync(path,png);
    assert.equal(imageCharge(path),88);assert.deepEqual(readFileSync(path),png);
    png.writeUInt32BE(2001,16);writeFileSync(path,png);assert.throws(()=>imageCharge(path),/2000px/);
    writeFileSync(path,'download failed');assert.throws(()=>imageCharge(path),/형식/);
    const text=join(dir,'text.txt');writeFileSync(text,'text');assert.equal(imageCharge(text),null);
    const pdf=join(dir,'file.pdf');writeFileSync(pdf,'%PDF-');assert.throws(()=>imageCharge(pdf),/JPEG/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('저장·종료 단계에는 단일 기존 명령만 허용한다',()=>{
  for(const command of [
    'npm run ck:merge -- --result out/ck/1/result.json',
    'npm run ck:merge -- --result "out/ck/1/a b.json" --dry-run',
    'npm run ck:record -- --lead vod:1',
    'npm run ck:local -- --finish --vod 1 --run abc --status running --opened 1',
  ])assert.equal(isFlushCommand(command),true,command);
  for(const command of ['npm run ck:probe -- --vod 1','npm run ck:merge -- --result x; echo bad',
    'npm run ck:merge -- --result "$(echo bad)"','node -e "x"','npm run ck:local -- --vod 1',
    'npm run ck:local -- --finish --status done','npm run ck:local -- --finish --status running --review',
    'npm run ck:merge -- --result x\nnpm run ck:probe -- --vod 1'])assert.equal(isFlushCommand(command),false,command);
});
test('실제 flock 훅의 동시 열람이 하나의 세션 한도를 공유한다',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ck-image-lock-'));
  const script=resolve(import.meta.dirname,'../ck-image-budget.ts'),file=join(dir,'image.png'),statePath=join(dir,'state.json');
  try {
    const png=Buffer.alloc(600);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);png.writeUInt32BE(20,16);png.writeUInt32BE(20,20);writeFileSync(file,png);
    const state=createBudget('s',dir,1,0.0005,0.001);writeFileSync(statePath,JSON.stringify(state));
    const call=()=>new Promise<any>((done,reject)=>{
      const child=spawn('flock',['-w','3',statePath+'.lock',process.execPath,script,'hook',statePath]);
      let output='';child.stdout.on('data',x=>output+=x);child.once('error',reject);child.once('close',code=>code===0?done(JSON.parse(output)):reject(new Error(String(code))));
      child.stdin.end(JSON.stringify({hook_event_name:'PermissionRequest',session_id:'s',cwd:dir,tool_name:'Read',tool_input:{file_path:file}}));
    });
    const results=await Promise.all([call(),call(),call()]);
    assert.equal(results.filter(x=>x.hookSpecificOutput.decision.behavior==='allow').length,1);
    const end=JSON.parse(readFileSync(statePath,'utf8'));assert.equal(end.images,1);assert.equal(end.bytes,800);assert.ok(end.flushAt);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('훅이 손상된 상태·다른 세션·읽기 실패를 허용 응답으로 바꾸지 않는다',()=>{
  const dir=mkdtempSync(join(tmpdir(),'ck-image-error-')),statePath=join(dir,'state.json');
  try {
    const script=resolve(import.meta.dirname,'../ck-image-budget.ts');
    for(const state of ['broken',JSON.stringify(createBudget('s',dir,1))]) {
      writeFileSync(statePath,state);
      const r=spawnSync(process.execPath,[script,'hook',statePath],{encoding:'utf8',input:JSON.stringify({hook_event_name:'PermissionRequest',session_id:'other',tool_name:'Read',tool_input:{file_path:'/missing'}})});
      assert.equal(r.status,2);assert.equal(r.stdout,'');
    }
  }finally{rmSync(dir,{recursive:true,force:true});}
});
