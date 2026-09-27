import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
test('ck:listen CLI는 전체 범위 밖 요청도 기록하여 이전 manifest를 교체한다',async()=>{
  const root=new URL('..',import.meta.url).pathname;
  const id=`999999${process.pid}${Date.now()}`;
  const probe=join(root,'out','ck',id),run=join(root,'.local','asr','runs',`ck-${id}`);
  await mkdir(probe,{recursive:true});await mkdir(run,{recursive:true});
  try {
    await writeFile(join(probe,'probe.json'),JSON.stringify({total_sec:100,parts:[{index:1,offset_sec:0,length_sec:100}]}));
    await writeFile(join(run,'samples.json'),JSON.stringify({complete:true,clips:['old']}));
    await assert.rejects(()=>promisify(execFile)(process.execPath,[join(root,'scripts/ck-listen.mjs'),'--vod',id,'--at','110:10']),/범위 밖/);
    const manifest=JSON.parse(await readFile(join(run,'samples.json'),'utf8'));
    assert.equal(manifest.complete,false);assert.deepEqual(manifest.clips,[]);
    assert.deepEqual(manifest.plannedRanges,[[110,10]]);assert.deepEqual(manifest.outOfRange,[[110,120]]);
  } finally {await rm(probe,{recursive:true,force:true});await rm(run,{recursive:true,force:true})}
});
