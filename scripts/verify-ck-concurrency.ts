import {verifyUnknownConcurrency} from './lib/verify-unknown.ts';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { disposablePostgres } from './lib/disposable-postgres.ts';
import { applyAll } from './lib/migrations.ts';
import { db,closeDb } from '../packages/core/lib/db/client.ts';
import * as ck from '../packages/core/lib/db/ck.ts';
const pg=await disposablePostgres();
process.env.DATABASE_URL=pg.url; process.env.DATABASE_POOL_MAX='3';
const other=postgres(pg.url,{max:1});
try {
  await applyAll(s=>other.unsafe(s),new URL('..',import.meta.url).pathname);
  await ck.upsertMatchFromScan({ played_at_precision: "datetime",match_id:'concurrent',played_at:new Date(),winning_team:100,result_evidence:'initial',participants:[{participant_id:1,team_id:100,observed_name:'A',kills:5}]});
  // Hold a real row lock; release only after the competing UPDATE is observed waiting.
  let release!:()=>void, locked!:()=>void;
  const gate=new Promise<void>(r=>release=r), ready=new Promise<void>(r=>locked=r);
  const writer=other.begin(async tx=>{
    await tx`SELECT match_id FROM match WHERE match_id='concurrent' FOR UPDATE`;
    locked(); await gate;
    await tx`UPDATE match SET winning_team=200 WHERE match_id='concurrent'`;
  });
  await ready;
  const pending=ck.applyMatchReview('concurrent',{match:{changes:{winning_team:200},expect:{winning_team:100}}});
  const rejected=assert.rejects(pending,/다른 검수자/);
  try {
    const deadline=Date.now()+10_000;
    let waiting=false;
    while(Date.now()<deadline){
      const [row]=await db()`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'`;
      if(row.n>0){waiting=true;break}
      await new Promise(r=>setTimeout(r,20));
    }
    assert.equal(waiting,true,'review must wait for the match row lock');
  } finally {release()}
  await writer; await rejected;
  await Promise.all([
    ck.applyMatchReview('concurrent',{match:{changes:{game_duration:1800},expect:{game_duration:null}}}),
    ck.applyMatchReview('concurrent',{participants:{patch:[{participant_id:1,changes:{kills:7},expect:{kills:5}}]}}),
  ]);
  const results=await Promise.allSettled([1,2].map(n=>ck.applyMatchReview('concurrent',{participants:{add:[{participant_id:2,team_id:200,observed_name:`writer-${n}`} ]}})));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const detail=(await ck.getMatchDetail('concurrent'))!;
  assert.equal(detail.match.winning_team,200); assert.equal(detail.match.game_duration,1800); assert.equal(detail.participants[0].kills,7);
  // 최종 근거는 조사가 남긴 값 그대로다 — 사람 검수는 근거 문장을 고치지 않는다.
  assert.equal(detail.match.result_evidence,'initial');
  assert.equal(detail.participants.length,2); assert.equal(detail.participants[0].outcome,'loss');
  const lead=await ck.upsertEventLead({source:'vod_title',source_key:'vod:review',title:'review',observed_at:new Date()});
  await ck.mergeLeadCandidates(lead,[{id:'c1',at:[0,100],conclusion:'unresolved',why:'auto'}]);
  await ck.markLeadScan(lead,{status:'failed',failed:[[800,800]]});
  const dir=await mkdtemp(join(tmpdir(),'ck-merge-test-'));
  try {
    const file=join(dir,'scan.json');
    await writeFile(file,JSON.stringify({resultType:'scan',lead:{source_key:'vod:review',title:'review',observed_at:new Date().toISOString()},
      candidates:[{id:'c1',at:[0,100],conclusion:'unresolved',why:'CLI old'}],scan:{status:'done',resolved_failed:[[800,800]]}}));
    const result=await promisify(execFile)(process.execPath,[new URL('./ck-merge.mjs',import.meta.url).pathname,'--result',file],{env:process.env});
    assert.match(result.stdout,/후보 1건/);
    const saved=(await ck.getEventLead(lead))!;
    const why=await db()`SELECT body FROM review_record WHERE lead_id=${lead}::uuid AND candidate_id='c1' AND type='assessment'`;
    assert.equal(why[0].body,'CLI old','CLI 가 다시 적은 해석은 정본(review_record)에 들어간다');
    assert.ok(!('why' in saved.raw.candidates!.find(c=>c.id==='c1')!),'후보 JSON 에는 서술이 없다');
    assert.deepEqual(saved.raw.scan!.failed,[]);assert.equal('resolved_failed' in saved.raw.scan!,false);
  } finally {await rm(dir,{recursive:true,force:true})}
  await verifyUnknownConcurrency(other);
  console.log('Real PostgreSQL + actual merge CLI: lock wait, stale conflict, disjoint edits, concurrent insert passed');
} finally {await other.end();await closeDb();await pg.stop()}
