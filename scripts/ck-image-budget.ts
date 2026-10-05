/** 백필 전용 훅과 감시 실행기. PermissionRequest를 기본 거부와 결합해 훅 실패도 거부한다. */
import {readFileSync,writeFileSync,renameSync,appendFileSync,mkdirSync,realpathSync} from 'node:fs';
import {resolve,dirname,join,relative} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline';
import {BUDGET_TOOLS,VERIFIED_CLAUDE_VERSION,createBudget,parseBudget,imageCharge,admitImage,budgetMessage,isFlushCommand,
  type ImageBudget,type HookInput} from './lib/ck-image-budget.ts';

const args=process.argv.slice(2),mode=args[0];
const opt=(k:string,d='')=>{const i=args.indexOf(k);return i<0?d:args[i+1];};
const atomic=(file:string,value:unknown)=>{const temp=`${file}.${process.pid}.tmp`;writeFileSync(temp,JSON.stringify(value)+'\n');renameSync(temp,file);};
const quote=(s:string)=>"'"+s.replaceAll("'","'\\''")+"'";
const inside=(path:string,root:string)=>{const r=relative(root,path);return r==='' || (!r.startsWith('..') && !r.startsWith('/'));};

async function hook() {
  const statePath=args[1];
  const input=JSON.parse(readFileSync(0,'utf8')) as HookInput;
  // flock가 실패하거나 프로세스가 죽어도 PermissionRequest의 기본 거부가 남는다.
  const state=parseBudget(JSON.parse(readFileSync(statePath,'utf8')));
  if(state.version!==1 || input.session_id!==state.sessionId || !BUDGET_TOOLS.includes(input.tool_name))throw new Error('세션/도구 불일치');
  const event=input.hook_event_name;
  if(event==='PostToolUse') {
    const response=input.tool_response;
    if(response?.type==='image' && typeof response.file?.base64==='string') {
      state.actualBytes+=response.file.base64.length;state.actualImages++;
      if(state.actualBytes>state.bytes || state.actualImages>state.images)state.error='실제 이미지가 선계수한 상한을 초과했다';
      atomic(statePath,state);
    }
    if(state.warned)console.log(JSON.stringify({hookSpecificOutput:{hookEventName:event,additionalContext:budgetMessage(state)}}));
    return;
  }
  if(event!=='PermissionRequest')throw new Error('예상하지 않은 훅');
  if(state.error)throw new Error(state.error);
  let allow=true,reason='백필 이미지 계수 확인';
  if(state.flushAt!==null) {
    state.flushCalls++;
    if(Date.now()-state.flushAt>state.flushMs || state.flushCalls>state.maxFlushCalls)allow=false;
    if(input.tool_name==='Bash' && !isFlushCommand(String(input.tool_input.command??'')))allow=false;
    if(!['Read','Write','Edit','Bash'].includes(input.tool_name))allow=false;
  }
  if(input.tool_name==='Read') {
    const path=realpathSync(resolve(input.cwd,input.tool_input.file_path));
    if(!inside(path,state.root))throw new Error('이 조사 폴더 안의 준비물·기록만 읽는다');
    const bytes=imageCharge(path);
    if(bytes!==null)allow=allow && admitImage(state,path,bytes);
  }
  if(input.tool_name==='Write' || input.tool_name==='Edit') {
    const path=resolve(input.cwd,input.tool_input.file_path);
    // 정상 판독도 조사 산출물만 쓴다. 훅 설정·코드·기존 운영 설정은 수정하지 않는다.
    if(!inside(path,join(state.root,'out/ck',String(state.vod)))) {allow=false;reason=`조사 JSON은 ${state.root}/out/ck/${state.vod}/ 아래에 작성한다`;}
  }
  if(input.tool_name==='Bash' && input.tool_input.run_in_background)allow=false;
  if(input.tool_name==='Bash' && (!inside(resolve(input.cwd),state.root)
    || (state.forbiddenRoot && String(input.tool_input.command??'').includes(state.forbiddenRoot)))) {allow=false;reason=`이 조사 폴더(${state.root})에서만 작업한다. 원래 프로젝트로 이동하거나 그곳의 결과를 읽지 않는다`;}
  if(input.tool_name==='Skill' && !['ck-local','ck-research'].includes(input.tool_input.skill))allow=false;
  if(reason==='백필 이미지 계수 확인' && (!allow || state.warned))reason=budgetMessage(state);
  atomic(statePath,state);
  appendFileSync(statePath+'.events.jsonl',JSON.stringify({at:new Date().toISOString(),tool:input.tool_name,
    path:input.tool_input.file_path??null,allow,bytes:state.bytes,images:state.images,flushAt:state.flushAt})+'\n');
  console.log(JSON.stringify({hookSpecificOutput:{hookEventName:event,decision:allow?{behavior:'allow'}:{behavior:'deny',message:reason}}}));
}

async function run() {
  const statePath=resolve(opt('--state')),output=resolve(opt('--output')),vod=Number(opt('--vod'));
  const split=args.indexOf('--');if(split<0)throw new Error('Claude 인자 필요');
  const command=args[split+1],claudeArgs=args.slice(split+2);
  const version=spawnSync(command,['--version'],{encoding:'utf8'});
  if(version.status!==0 || !version.stdout.startsWith(VERIFIED_CLAUDE_VERSION+' '))throw new Error(`이미지 제한은 Claude Code ${VERIFIED_CLAUDE_VERSION}에서 검증했다. 새 버전은 재검증 필요`);
  const state=createBudget(randomUUID(),process.cwd(),vod,Number(opt('--warn-mib','8')),Number(opt('--limit-mib','12')),Number(opt('--flush-seconds','180')));
  if(process.env.CK_IMAGE_BUDGET_FORBID_ROOT)state.forbiddenRoot=process.env.CK_IMAGE_BUDGET_FORBID_ROOT;
  mkdirSync(dirname(statePath),{recursive:true});atomic(statePath,state);
  const hookCommand=`flock -w 3 ${quote(statePath+'.lock')} ${quote(process.execPath)} ${quote(import.meta.filename)} hook ${quote(statePath)}`;
  const settings={permissions:{ask:BUDGET_TOOLS},hooks:{
    PermissionRequest:[{matcher:'*',hooks:[{type:'command',command:hookCommand,timeout:5}]}],
    PostToolUse:[{matcher:'Read',hooks:[{type:'command',command:hookCommand,timeout:5}]}],
  }};
  const settingsPath=statePath+'.settings.json';atomic(settingsPath,settings);
  const filtered:string[]=[];
  for(let i=0;i<claudeArgs.length;i++) {
    if(['--output-format','--permission-mode'].includes(claudeArgs[i])){i++;continue;}
    filtered.push(claudeArgs[i]);
  }
  const child=spawn(command,[...filtered,'--output-format','stream-json','--verbose',
    '--session-id',state.sessionId,'--settings',settingsPath,'--setting-sources','',
    '--strict-mcp-config','--tools',BUDGET_TOOLS.join(','),'--permission-mode','manual','--permission-prompts','none'],
    {stdio:['ignore','pipe','inherit'],detached:true,
      // 작은 사용자 토큰 상한 때문에 CLI가 이미지를 별도 재인코딩하는 경로를 피한다.
      env:{...process.env,CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS:'25000'}});
  const cleanup=()=>{try{process.kill(-child.pid!,'SIGKILL');}catch{}};
  process.once('exit',cleanup);
  const streamPath=output+'.stream.jsonl';let result:any=null,stopped='',killTimer:NodeJS.Timeout|undefined;
  const terminate=(reason:string)=>{
    if(stopped)return;stopped=reason;
    try{process.kill(-child.pid!,'SIGTERM');}catch{}
    killTimer=setTimeout(()=>{try{process.kill(-child.pid!,'SIGKILL');}catch{}},2000);
  };
  process.on('SIGTERM',()=>terminate('interrupted'));process.on('SIGINT',()=>terminate('interrupted'));
  const monitor=setInterval(()=>{
    try {
      const current=parseBudget(JSON.parse(readFileSync(statePath,'utf8')));
      if(current.error)terminate('image_guard_failure');
      if(current.flushAt!==null && (Date.now()-current.flushAt>current.flushMs || current.flushCalls>current.maxFlushCalls))terminate('image_flush_timeout');
    }catch{terminate('image_guard_failure');}
  },250);
  const lines=createInterface({input:child.stdout!});
  lines.on('line',line=>{
    appendFileSync(streamPath,line+'\n');
    try{const message=JSON.parse(line);if(message.type==='result')result=message;}catch{}
  });
  const code=await new Promise<number>((done,reject)=>{child.once('error',reject);child.once('close',c=>done(c??1));})
    .finally(()=>{clearInterval(monitor);if(killTimer)clearTimeout(killTimer);});
  if(stopped) {try{process.kill(-child.pid!,'SIGKILL');}catch{}}
  if(result)atomic(output,result);
  const end=parseBudget(JSON.parse(readFileSync(statePath,'utf8')));
  atomic(output+'.exit.json',{reason:stopped || (end.flushAt!==null?'image_limit':result?.subtype??'claude_exit'),
    code,session_id:state.sessionId,images:end.images,bytes:end.bytes,actual_images:end.actualImages,actual_bytes:end.actualBytes,
    unique_images:Object.keys(end.reads).length,repeats:Object.values(end.reads).reduce((n,c)=>n+Math.max(0,c-1),0),stream:streamPath});
  // usage가 없으면 성공 결과를 꾸미지 않는다. 강제 종료는 호출자가 DB 확인 후 재개한다.
  process.exitCode=stopped==='image_flush_timeout'?20:stopped?1:code;
}
try {
  if(mode==='hook')await hook();
  else if(mode==='run')await run();
  else throw new Error('usage: ck-image-budget.ts hook STATE | run --state ... --output ... --vod ... -- claude ...');
}catch(error) {
  console.error(`이미지 예산: ${error instanceof Error?error.message:String(error)}`);
  // PermissionRequest는 유효 승인 없으면 기본 거부. PreToolUse에서도 예외를 허용으로 바꾸지 않는다.
  process.exitCode=2;
}
