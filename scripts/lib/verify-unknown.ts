/** Shared regression cases; caller supplies a disposable database. */
import assert from 'node:assert/strict';
import * as ck from '../../packages/core/lib/db/ck.ts';
import {db} from '../../packages/core/lib/db/client.ts';
import {createStreamer} from '../../packages/core/lib/db/streamers.ts';
import {listMatchRosters} from '../../packages/core/lib/contract/index.ts';

export async function verifyUnknownParticipants() {
  const a=await createStreamer({slug:'unknown-test-a',display_name:'A'});
  const b=await createStreamer({slug:'unknown-test-b',display_name:'B'});
  const fixture=(id:string,name:string):ck.CkMatchInput=>({ played_at_precision: "datetime",match_id:id,played_at:new Date('2026-09-20T00:00:00Z'),winning_team:100,result_evidence:'test',
    participants:[{participant_id:1,team_id:100,observed_name:name,champion_id:34,kills:3,deaths:8,assists:7},
      {participant_id:2,team_id:200,streamer_id:b.id,champion_id:143,kills:1,deaths:2,assists:3}]});
  for(const id of ['unknown:1','unknown:2','unknown:3','unknown:4']) await ck.upsertMatchFromScan(fixture(id,'four-seats'));
  const targets=(await ck.listUnidentifiedParticipants()).find(r=>r.observed_name==='four-seats')!.targets;
  const result=await ck.reviewUnidentifiedParticipants(targets,a.id);
  assert.equal(result.linked,4);
  assert.equal(await ck.upsertMatchFromScan(fixture('unknown:1','four-seats')),false,'manual links must survive automatic re-import');
  assert.ok((await ck.getMatchDetail('unknown:1'))!.match.reviewed_at);
  assert.equal((await listMatchRosters(['unknown:1'])).find(p=>p.streamer_id===a.id)!.kills,3);
  const [stats]=await db()`SELECT sum(games)::int AS games FROM champion_stat WHERE streamer_id=${a.id} AND champion_id=34 AND season='ALL'`;
  assert.equal(stats.games,4);
  console.log('Unknown participant review: four-seat linking and re-import protection passed');
}

export async function verifyUnknownBoundaries() {
  const a=await createStreamer({slug:'unknown-boundary-a',display_name:'A'});
  const b=await createStreamer({slug:'unknown-boundary-b',display_name:'B'});
  const fixture=(id:string,name:string,parts:ck.CkMatchParticipantInput[]=[]):ck.CkMatchInput=>({ played_at_precision: "datetime",match_id:id,played_at:new Date('2026-09-20T00:00:00Z'),winning_team:100,result_evidence:'test',
    participants:[{participant_id:1,team_id:100,observed_name:name,champion_id:34,kills:3,deaths:8,assists:7},...parts]});
  const targets=async(name:string)=>(await ck.listUnidentifiedParticipants()).find(r=>r.observed_name===name)!.targets;
  for (const id of ['scope:chosen','scope:other','scope:hidden']) await ck.upsertMatchFromScan(fixture(id,'same-name'));
  await db()`UPDATE match SET visibility='hidden' WHERE match_id='scope:hidden'`;
  const chosen=(await targets('same-name')).filter(t=>t.match_id==='scope:chosen');
  await ck.upsertMatchFromScan(fixture('scope:late','same-name'));
  const scope=await ck.reviewUnidentifiedParticipants(chosen,a.id);
  assert.deepEqual(scope.matches,['scope:chosen']);
  for(const id of ['scope:other','scope:hidden','scope:late']) assert.equal((await ck.getMatchDetail(id))!.participants[0].streamer_id,null);
  // Hidden after opening the list is a conflict, not permission to edit an invisible match.
  const hidden=(await targets('same-name')).filter(t=>t.match_id==='scope:other');
  await db()`UPDATE match SET visibility='hidden' WHERE match_id='scope:other'`;
  await assert.rejects(()=>ck.reviewUnidentifiedParticipants(hidden,a.id),/visibility/);
  await assert.rejects(()=>ck.reviewUnidentifiedParticipants(chosen,b.id),/다른 검수자/);
  assert.equal((await ck.getMatchDetail('scope:chosen'))!.participants[0].streamer_id,a.id);
  for(const id of ['atomic:a','atomic:z']) await ck.upsertMatchFromScan(fixture(id,'atomic',id.endsWith('z')?[{participant_id:2,team_id:200,streamer_id:a.id,champion_id:143}]:[]));
  const before=await ck.getMatchDetail('atomic:a');
  const [statBefore]=await db()`SELECT jsonb_agg(to_jsonb(cs) ORDER BY champion_id,queue_id,season,category) AS snapshot FROM champion_stat cs WHERE streamer_id=${a.id}`;
  const awaitedAtomic=await targets('atomic');
  await assert.rejects(()=>ck.reviewUnidentifiedParticipants(awaitedAtomic,a.id),/이번 연결은 모두 취소/);
  assert.deepEqual(await ck.getMatchDetail('atomic:a'),before);
  const [statAfter]=await db()`SELECT jsonb_agg(to_jsonb(cs) ORDER BY champion_id,queue_id,season,category) AS snapshot FROM champion_stat cs WHERE streamer_id=${a.id}`;
  assert.deepEqual(statAfter,statBefore);
  await ck.upsertMatchFromScan(fixture('stale:name','old-name'));
  const stale=await targets('old-name');
  await ck.upsertMatchFromScan(fixture('stale:name','new-name'));
  await assert.rejects(()=>ck.reviewUnidentifiedParticipants(stale,a.id),/observed_name/);
  await ck.upsertMatchFromScan(fixture('stale:auto','auto-link'));
  const auto=await targets('auto-link');
  await ck.linkParticipants('stale:auto',[{participant_id:1,streamer_id:b.id}]);
  assert.equal((await ck.getMatchDetail('stale:auto'))!.match.reviewed_at,null);
  await assert.rejects(()=>ck.reviewUnidentifiedParticipants(auto,a.id),/streamer_id/);
  await assert.rejects(()=>ck.reviewUnidentifiedParticipants([],a.id),/선택/);
  await assert.rejects(()=>ck.reviewUnidentifiedParticipants([auto[0],auto[0]],a.id),/두 번/);
  const invalid={...auto[0]};delete (invalid as Partial<ck.UnidentifiedSelection>).reviewed_at;
  await assert.rejects(()=>ck.reviewUnidentifiedParticipants([invalid],a.id),/기준값/);
  await ck.upsertMatchFromScan(fixture('skip:reviewed','reviewed'));
  await ck.markMatchReviewed('skip:reviewed',true);
  const skip=await ck.reviewUnidentifiedParticipants(await targets('reviewed'),a.id);
  assert.deepEqual(skip,{linked:0,matches:[],skipped:['skip:reviewed']});
  await ck.upsertMatchFromScan(fixture('duplicate:label','duplicate',[{participant_id:2,team_id:100,observed_name:'duplicate',champion_id:34}]));
  const roster=await listMatchRosters(['duplicate:label']);
  assert.deepEqual(roster.map(p=>p.participant_id).sort(),[1,2]);
  console.log('Unknown review: scope, stale state, atomic rollback, automatic identity, reviewed skip, stable seat IDs passed');
}

export async function verifyUnknownConcurrency(other: import('postgres').Sql) {
  const a=await createStreamer({slug:'unknown-race-a',display_name:'A'}), b=await createStreamer({slug:'unknown-race-b',display_name:'B'});
  await ck.upsertMatchFromScan({ played_at_precision: "datetime",match_id:'unknown:race',played_at:new Date(),winning_team:100,result_evidence:'race',participants:[{participant_id:1,team_id:100,observed_name:'race-name',champion_id:34}]});
  const targets=(await ck.listUnidentifiedParticipants()).find(r=>r.observed_name==='race-name')!.targets;
  let release!:()=>void,locked!:()=>void;
  const gate=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>locked=r);
  const writer=other.begin(async tx=>{await tx`SELECT match_id FROM match WHERE match_id='unknown:race' FOR UPDATE`;locked();await gate});
  await ready;
  const results=Promise.allSettled([ck.reviewUnidentifiedParticipants(targets,a.id),ck.reviewUnidentifiedParticipants(targets,b.id)]);
  try {
    let waiting=false;const deadline=Date.now()+10000;
    while(Date.now()<deadline){const [r]=await db()`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'`;
      if(r.n>=2){waiting=true;break}await new Promise(r=>setTimeout(r,20));}
    assert.ok(waiting,'both manual reviewers must be waiting on the same real row lock');
  } finally {release()}
  await writer;
  const settled=await results;
  assert.equal(settled.filter(r=>r.status==='fulfilled').length,1);
  const rejected=settled.find(r=>r.status==='rejected') as PromiseRejectedResult;
  assert.match(String(rejected.reason),/다른 검수자/);
  const detail=(await ck.getMatchDetail('unknown:race'))!;
  assert.ok(detail.match.reviewed_at);
  const winner=settled[0].status==='fulfilled'?a.id:b.id;
  assert.equal(detail.participants[0].streamer_id,winner);
  console.log('Unknown review: two real concurrent reviewers, one commit and one conflict passed');
}
