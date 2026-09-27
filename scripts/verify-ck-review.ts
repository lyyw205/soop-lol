import {verifyReviewProgress} from "./lib/verify-review-progress.ts";
import {verifyUnknownUpgrade} from './lib/verify-unknown-migration.ts';
/** Disposable DB regression test. Never uses a caller's DATABASE_URL. */
import assert from 'node:assert/strict';
import {verifyUnknownParticipants,verifyUnknownBoundaries} from './lib/verify-unknown.ts';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { applyAll } from './lib/migrations.ts';
import * as ck from '../packages/core/lib/db/ck.ts';
import { closeDb } from '../packages/core/lib/db/client.ts';

const pg = await PGlite.create({extensions:{pg_trgm,pgcrypto}});
const server = new PGLiteSocketServer({db:pg,host:'127.0.0.1',port:55443});
await server.start();
process.env.DATABASE_URL='postgres://postgres@127.0.0.1:55443/postgres';
process.env.DATABASE_POOL_MAX='1';
try {
  await applyAll(sql=>pg.exec(sql),new URL('..',import.meta.url).pathname);
  await ck.upsertMatchFromScan({ played_at_precision: "datetime",match_id:'review:1',played_at:new Date('2026-09-20T00:00:00Z'),winning_team:100,
    result_evidence:'original',participants:[{participant_id:1,team_id:100,observed_name:'A',champion_id:268,kills:5,deaths:1,assists:3}]});
  await ck.applyMatchReview('review:1',{match:{changes:{winning_team:200},expect:{winning_team:100}}});
  // 최종 결과 근거는 조사(ck:merge)가 남기고 review_record 가 정본이다. 사람 검수는 근거 문장을 고치지 않는다.
  assert.equal((await ck.getMatchDetail('review:1'))!.match.result_evidence,'original');
  assert.equal((await ck.getMatchDetail('review:1'))!.match.winning_team,200);
  await assert.rejects(()=>ck.applyMatchReview('review:1',{match:{changes:{winning_team:100},expect:{winning_team:100}}}),/다른 검수자/);
  await assert.rejects(()=>ck.applyMatchReview('review:1',{match:{changes:{winning_team:100},expect:{}}}),/기대값/);
  await ck.applyMatchReview('review:1',{participants:{patch:[{participant_id:1,changes:{champion_name:null},expect:{champion_name:'Azir',champion_id:268}}]}});
  assert.equal((await ck.getMatchDetail('review:1'))!.participants[0].champion_id,0);
  assert.equal((await ck.getMatchDetail('review:1'))!.participants[0].champion_name,null);
  await ck.applyMatchReview('review:1',{participants:{add:[{participant_id:2,team_id:200,observed_name:'B',champion_name:'Zyra',kills:5}]}});
  const before=await ck.getMatchDetail('review:1');
  await assert.rejects(()=>ck.applyMatchReview('review:1',{match:{changes:{game_duration:999},expect:{game_duration:null}},participants:{add:[{participant_id:2,team_id:200,observed_name:'stale'}]}}),/이미/);
  assert.deepEqual(await ck.getMatchDetail('review:1'),before);
  await ck.applyMatchReview('review:1',{match:{changes:{},expect:{}}});
  assert.deepEqual(await ck.getMatchDetail('review:1'),before,'no-op must preserve reviewed_at');
  const lead=await ck.upsertEventLead({source:'vod_title',source_key:'vod:review',title:'review',observed_at:new Date()});
  await ck.mergeLeadCandidates(lead,[{id:'c1',at:[0,100],conclusion:'unresolved',why:'auto'}]);
  const emptyMatchWorkspace=await ck.getLeadWorkspace(lead);
  assert.equal(emptyMatchWorkspace!.matches.length,0);
  assert.equal(emptyMatchWorkspace!.reviews.some(r=>r.candidate_id==='c1'&&r.type==='assessment'&&r.body==='auto'),true);
  const merge=await ck.mergeLeadCandidates(lead,[{id:'c1',at:[0,100],conclusion:'unresolved',why:'old'},{id:'c2',at:[100,200],conclusion:'unresolved'}]);
  // 해석은 후보 JSON 이 아니라 정본(review_record)에 있다(0040). 조사가 다시 적으면 새 값이 이긴다.
  const assessment=async(id:string)=>(await ck.getLeadWorkspace(lead))!.reviews.find(r=>r.candidate_id===id&&r.type==='assessment')?.body;
  assert.equal(await assessment('c1'),'old');
  assert.ok(!('why' in merge.candidates.find(c=>c.id==='c1')!),'후보 JSON 에는 서술이 없다');
  await assert.rejects(()=>ck.mergeLeadCandidates(lead,[{id:'c3',at:[0,1],conclusion:'unresolved',reviewed_at:null} as never]),/reviewed_at/);
  await ck.mergeLeadCandidates(lead,[{id:'wide',at:[200,500],conclusion:'unresolved',why:'넓은 부모'}]);
  const split=await ck.mergeLeadCandidates(lead,[
    {id:'leaf-a',at:[200,350],conclusion:'unresolved',supersedes:'wide'},
    {id:'leaf-b',at:[350,500],conclusion:'unresolved',supersedes:'wide'},
  ]);
  assert.equal(await assessment('wide'),'넓은 부모','자식 추가는 부모의 기록을 고치지 않는다');
  assert.equal(split.candidates.find(c=>c.id==='leaf-a')!.supersedes,'wide');
  await assert.rejects(()=>ck.mergeLeadCandidates(lead,[
    {id:'cycle-a',at:[600,700],conclusion:'unresolved',supersedes:'cycle-b'},
    {id:'cycle-b',at:[700,800],conclusion:'unresolved',supersedes:'cycle-a'},
  ]),/순환/);
  await assert.rejects(()=>ck.mergeLeadCandidates(lead,[
    {id:'missing-child',at:[800,900],conclusion:'unresolved',supersedes:'does-not-exist'},
  ]),/존재하지 않는/);
  await ck.markLeadScan(lead,{status:'running',failed:[[800,800]],sampled:[[0,2000]]});
  const res=await ck.markLeadScan(lead,{status:'running',sampled:[[700,1300]],probes:{planned:[1000]}});
  assert.deepEqual(res.failed,[[800,800]]);
  assert.deepEqual((await ck.markLeadScan(lead,{status:'done'},{resolved_failed:[[800,800]]})).failed,[]);
  assert.deepEqual((await ck.markLeadScan(lead,{status:'failed',failed:[[800,800]]},{resolved_failed:[[800,800]]})).failed,[[800,800]]);
  assert.equal('resolved_failed' in (await ck.getEventLead(lead))!.raw.scan!,false);
  await ck.markLeadScan(lead,{status:'failed',failed:[[0,2]]},{mode:'replace'});
  assert.deepEqual((await ck.markLeadScan(lead,{status:'running'},{resolved_failed:[[0.2,0.8]]})).failed,[[0,2]],'sub-second cuts must not expand');
  assert.deepEqual((await ck.markLeadScan(lead,{status:'running'},{resolved_failed:[[0.2,1.8]]})).failed,[[0,0],[2,2]],'only fully covered integer seconds resolve');
  await assert.rejects(()=>ck.markLeadScan(lead,{status:'done'},{resolved_failed:[[0,Infinity]]}),/resolved_failed/);
  await verifyReviewProgress();
  await verifyUnknownUpgrade(pg);
  await verifyUnknownParticipants();
  await verifyUnknownBoundaries();
  console.log('CK review regressions passed');
} finally {await closeDb();await server.stop();await pg.close();}
