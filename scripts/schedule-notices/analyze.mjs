import { spawn } from 'node:child_process';
import { mkdtemp, readFile, copyFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { readJson, writeJson, schema, validateResult } from './core.mjs';
import { cacheImages } from './collect.mjs';
function run(exe,args,options,input='',timeout=600000) {
  return new Promise((resolve,reject)=>{
    const child=spawn(exe,args,{...options,stdio:['pipe','pipe','pipe']}); let out='',err='',timedOut=false;
    const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},timeout);
    child.stdin.on('error',()=>{});
    child.stdout.on('data',b=>{out+=b;if(out.length>4*1024*1024)child.kill('SIGKILL');});
    child.stderr.on('data',b=>{err=(err+b).slice(-4000);});
    child.once('error',e=>{clearTimeout(timer);reject(e);});
    child.once('close',code=>{clearTimeout(timer); code===0&&!timedOut?resolve(out):reject(new Error(timedOut?'CLI timeout':`CLI exited ${code}: ${err.slice(-1000)}`));});
    child.stdin.end(input);
  });
}
export async function claudeAnalyze(input, config, base) {
  const cwd=await mkdtemp(join(tmpdir(),'soop-notice-analysis-'));
  try {
    const posts=[];
    for(const post of input.posts) {
      const assets=[];
      for(const path of post.assets) {
        const name=`image-${assets.length}-${post.key}${extname(path)}`;
        await copyFile(path,join(cwd,name)); assets.push(join(cwd,name));
      }
      const {html,photos,...rest}=post; posts.push({...rest,assets});
    }
    // Do not inherit API billing/provider configuration or application secrets.
    const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>
      /^(HOME|PATH|LANG|LC_.*|TZ|USER|LOGNAME|SHELL|TMPDIR|XDG_.*|CLAUDE_CONFIG_DIR|CLAUDE_CODE_OAUTH_TOKEN)$/.test(k)));
    const options={cwd,env};
    const auth=JSON.parse(await run('claude',['auth','status'],options,'',30000));
    if(!auth.loggedIn || auth.authMethod!=='claude.ai') throw new Error('Claude subscription login required; API credentials are not used');
    const instructions=await readFile(new URL('./analysis.txt',import.meta.url),'utf8');
    const raw=await run('claude',['-p','--safe-mode','--restricted','--tools','Read','--allowedTools',`Read(${cwd}/**)`,
      '--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--setting-sources','',
      '--disable-slash-commands','--no-session-persistence','--model',config.model,
      '--output-format','json','--json-schema',JSON.stringify(schema),'--system-prompt',instructions],options,JSON.stringify({...input,posts}));
    const envelope=JSON.parse(raw);
    await writeJson(join(base,'last-cli.json'),envelope);
    if(envelope.permission_denials?.length) throw new Error('CLI image read was denied; analysis is incomplete');
    if(envelope.is_error || envelope.subtype && envelope.subtype!=='success' || !envelope.structured_output) throw new Error('CLI did not return a successful structured result; see last-cli.json');
    return envelope.structured_output;
  } finally { await rm(cwd,{recursive:true,force:true}); }
}
/** @returns {Promise<any[]>} */
async function missingContext() { throw new Error('Schedule context provider required'); }
export async function analyze(base,config,{runner=claudeAnalyze,context=missingContext,images=cacheImages,now=Date.now()}={}) {
  const file=join(base,'state.json');
  const state=await readJson(file,{version:1,posts:{},channels:{}});
  const pending=Object.entries(state.posts).filter(([,p])=>p.status==='pending' && p.nextAttemptAt<=now)
    .sort((a,b)=>a[1].observedAt-b[1].observedAt).slice(0,config.batchSize);
  if(!pending.length) return {analyzed:0};
  const posts=[];let imageCount=0;
  for(const [key,job] of pending) {
    try {
      const post=await readJson(join(base,'posts',`${job.revision}.json`));
      if(posts.length && imageCount+post.photos.length>config.maxImages) break;
      if(post.text.length>20000) throw new Error('Post exceeds 20,000 characters; manual review required');
      posts.push({...post,assets:await images(base,post,config.maxImages)}); imageCount+=post.photos.length;
    } catch(e) { fail(job,e,now); }
  }
  await writeJson(file,state);
  if(!posts.length) return {analyzed:0,failed:pending.length};
  try {
    // Context errors block this batch; never pretend an inaccessible DB is an empty schedule.
    const existingSchedules=await context();
    const recentCandidates=[];
    for(const [key,j] of Object.entries(state.posts)) if(j.status==='done' && j.analyzedAt>=now-7*86400000) {
      const r=await readJson(join(base,'results',`${j.revision}.json`));
      if(r.decision!=='ignore') recentCandidates.push({key,...r});
    }
    const result=validateResult(await runner({posts,existingSchedules,recentCandidates:recentCandidates.slice(-30),contextAt:new Date(now).toISOString()},config,base),posts,existingSchedules);
    await mkdir(join(base,'results'),{recursive:true});
    for(const r of result.results) {
      await writeJson(join(base,'results',`${r.revision}.json`),{...r,analyzedAt:now,publication:'review-only'});
      Object.assign(state.posts[r.key],{status:'done',analyzedAt:now,lastError:null});
    }
    state.lastAnalysis={at:now,analyzed:posts.length}; await writeJson(file,state);
    return state.lastAnalysis;
  } catch(e) {
    for(const post of posts) fail(state.posts[post.key],e,now);
    state.lastAnalysis={at:now,analyzed:0,error:e.message}; await writeJson(file,state); throw e;
  }
}
function fail(job,e,now) {
  job.attempts++; job.lastError=e.message; job.nextAttemptAt=now+Math.min(24,2**(job.attempts-1))*3600000;
  if(job.attempts>=5) job.status='failed';
}
