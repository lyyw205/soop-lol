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
  // 미연결 프레임 → 누락 세트 생성 → 기존 로스터 저장. 운영 DB를 쓰지 않는다.
  const manualLead = await ck.upsertEventLead({ source: 'manual', source_key: 'manual:create-test', title: 'manual', observed_at: new Date() });
  const manualFrames = await ck.recordEvidenceFrames(manualLead, [
    { frame_path: 'manual-result.jpg', at_sec: 300, kind: 'result' },
    { frame_path: 'manual-other.jpg', at_sec: 301, kind: 'result' },
  ]);
  await ck.upsertMatchFromScan({ played_at_precision: 'date', match_id: 'manual:series:1',
    played_at: new Date('2026-09-20T00:00:00Z'), winning_team: 100, series_id: 'manual:series', series_game_no: 1, participants: [] });
  const manualInput = { frame_id: manualFrames[0].id, played_at: new Date('2026-09-20T00:00:00Z'),
    series_id: 'manual:series', series_game_no: 3, event_id: null, winning_team: null };
  const created = await ck.createMatchFromEvidence(manualInput);
  assert.equal(created.existing, false);
  assert.deepEqual(await ck.createMatchFromEvidence(manualInput), created, '응답 유실 재시도는 같은 경기');
  let manualDetail = (await ck.getMatchDetail(created.match_id))!;
  assert.equal(manualDetail.match.origin, 'admin');
  assert.ok(manualDetail.match.reviewed_at);
  assert.equal(manualDetail.match.review_completed_at, null);
  assert.equal(manualDetail.match.winning_team, null);
  assert.equal(manualDetail.participants.length, 0);
  assert.equal(manualDetail.evidence_frames.length, 1);
  assert.ok((await ck.getLeadWorkspace(manualLead))!.matches.some(m => m.match.match_id === created.match_id));
  assert.deepEqual(await ck.createMatchFromEvidence({ ...manualInput, frame_id: manualFrames[1].id }),
    { match_id: created.match_id, existing: true }, '같은 세트는 중복 생성하지 않고 연결 선택 반환');
  assert.equal((await ck.getLeadWorkspace(manualLead))!.frames.find(f => f.id === manualFrames[1].id)!.match_id, null);
  await assert.rejects(() => ck.createMatchFromEvidence({ ...manualInput, frame_id: manualFrames[1].id, series_id: 'missing' }), /시리즈/);
  await assert.rejects(() => ck.createMatchFromEvidence({ ...manualInput, frame_id: manualFrames[1].id, series_game_no: 0 }), /세트/);
  await assert.rejects(() => ck.createMatchFromEvidence({ ...manualInput, frame_id: manualFrames[1].id,
    series_id: null, series_game_no: null, event_id: '00000000-0000-0000-0000-000000000001' }), /foreign key/);
  assert.equal(await ck.getMatchDetail(`admin:frame:${manualFrames[1].id}`), null, '실패하면 빈 경기조차 남기지 않는다');
  await ck.applyMatchReview(created.match_id, { match: { changes: { game_duration: 1500 }, expect: { game_duration: null } } });
  assert.equal((await ck.getMatchDetail(created.match_id))!.match.winning_team, null, '승패 미상이어도 나머지 정보 편집 가능');
  await ck.applyMatchReview(created.match_id, { participants: { add: [{ participant_id: 1, team_id: 100, observed_name: '직접 입력', champion_name: 'Ahri', kills: 3 }] } });
  manualDetail = (await ck.getMatchDetail(created.match_id))!;
  assert.equal(manualDetail.participants[0].kills, 3);
  assert.equal(await ck.upsertMatchFromScan({ played_at_precision: 'date', match_id: created.match_id,
    played_at: manualInput.played_at, winning_team: 200, participants: [] }), false, '자동 조사는 수동 생성 경기를 덮지 않는다');
  await ck.recordEvidenceFrames(manualLead, [{ frame_path: 'manual-result.jpg', match_id: 'manual:series:1' }]);
  assert.equal((await ck.getMatchDetail(created.match_id))!.evidence_frames.length, 1, '수동 프레임 연결도 보존');
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
