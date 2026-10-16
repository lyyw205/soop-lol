import { resolve, join } from 'node:path';
import { mkdir, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { withFileLock } from '../lib/file-lock.mjs';
import { readJson, writeJson, validateConfig } from './core.mjs';
import { collect } from './collect.mjs';
import { analyze } from './analyze.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const base=resolve(process.env.SCHEDULE_NOTICES_DIR??join(root,'out/schedule-notices'));
const command=process.argv[2]??'status';
await mkdir(base,{recursive:true});
await withFileLock(join(base,'run.lock'),async()=>{
  if(command==='init') {
    try { await access(join(base,'config.json')); console.log('Existing config preserved'); }
    catch { await writeJson(join(base,'config.json'),await readJson(new URL('./config.example.json',import.meta.url))); console.log('Initialized 4 trial channels'); }
    return;
  }
  const config=validateConfig(await readJson(join(base,'config.json')));
  if(command==='poll') { const result=await collect(base,config); console.log(JSON.stringify(result,null,2)); if(result.errors.length)process.exitCode=1; }
  else if(command==='analyze') {
    const result=await analyze(base,config,{context:async()=>{const {scheduleContext}=await import('./context.ts');return scheduleContext();}});
    console.log(JSON.stringify(result,null,2)); if(result.failed)process.exitCode=1;
  } else if(command==='status' || command==='review') {
    const state=await readJson(join(base,'state.json'),{posts:{},channels:{}});
    if(command==='status') console.log(JSON.stringify({...state,posts:Object.entries(state.posts).map(([key,p])=>({key,...p}))},null,2));
    else for(const [key,p] of Object.entries(state.posts)) if(p.status==='done') {
      const r=await readJson(join(base,'results',`${p.revision}.json`));
      if(r.decision!=='ignore') console.log(JSON.stringify({key,...r},null,2));
    }
  } else if(command==='retry') {
    const state=await readJson(join(base,'state.json')); const key=process.argv[3];
    if(!state.posts[key]) throw new Error('retry requires an existing post key');
    Object.assign(state.posts[key],{status:'pending',attempts:0,nextAttemptAt:0}); await writeJson(join(base,'state.json'),state);
  } else throw new Error('Commands: init | poll | analyze | status | review | retry <post-key>');
});
