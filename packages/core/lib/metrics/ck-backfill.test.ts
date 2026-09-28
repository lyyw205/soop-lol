import {test} from 'node:test';
import assert from 'node:assert/strict';
import {backfillUpper, beforeCursor, newestFirst, autoQueueReason, fitsBudget, fullScanDone, processed} from './ck-backfill.ts';

test('KST 날짜 기준 상한은 최근 3개 날짜와 겹치지 않고 비-watch는 지금이다',()=>{
 const now=new Date('2026-09-27T15:00:00Z');
 assert.equal(backfillUpper(true,now).toISOString(),'2026-09-25T15:00:00.000Z');
 assert.equal(backfillUpper(false,now),now);
 assert.equal(backfillUpper(true,new Date('2026-09-27T14:59:59Z')).toISOString(),'2026-09-24T15:00:00.000Z');
});
test('동일 시각 VOD도 번호로 안정적으로 재개하고 신규 VOD는 상한 밖이다',()=>{
 const at='2026-09-20 12:00:00', upper=new Date('2026-09-21T00:00:00+09:00');
 const vs=[1,3,2].map(title_no=>({title_no,ended_at:at})).sort(newestFirst);
 assert.deepEqual(vs.map(v=>v.title_no),[3,2,1]);
 assert.equal(beforeCursor(vs[2],upper,vs[1]),true);
 assert.equal(beforeCursor(vs[0],upper,vs[1]),false);
 assert.equal(beforeCursor({title_no:4,ended_at:'2026-09-22 01:00:00'},upper),false);
});
test('백필 표시는 lead_only, running, done+failed 모든 자동 분류에서 제외된다',()=>{
 for(const scan of [undefined,{status:'running'},{status:'done',failed:[[0,1]]}]) {
  assert.equal(autoQueueReason({backfill:{progress_id:'p'},scan}),null);
 }
 assert.equal(autoQueueReason({}), 'lead_only');
 assert.equal(autoQueueReason({scan:{status:'running'}}),'running');
});
test('개수·시간 제한과 긴 영상/길이 미상 단독 예외',()=>{
 assert.equal(fitsBudget(0,0,21*3600,5,20*3600),true);
 assert.equal(fitsBudget(1,21*3600,10,5,20*3600),false);
 assert.equal(fitsBudget(1,19*3600,2*3600,5,20*3600),false);
 assert.equal(fitsBudget(5,5,1,5,20*3600),false);
 assert.equal(fitsBudget(0,0,null,5,20*3600),true);
 assert.equal(fitsBudget(1,1,null,5,20*3600),false);
});
test('done 선언만으로 통과하지 않고 전체 범위·실패·열람을 확인한다',()=>{
 const scan={status:'done',failed:[],requested:[[0,100]],sampled:[[0,100]],opened:[0,100]};
 assert.equal(fullScanDone({scan},100),true);
 assert.equal(fullScanDone({scan},200),false);
 assert.equal(fullScanDone({scan:{...scan,opened:[]}},100),false);
 assert.equal(fullScanDone({scan:{...scan,failed:[[30,40]]}},100),false);
 assert.equal(fullScanDone({scan:{...scan,status:'running'}},100),false);
 assert.equal(fullScanDone({scan,vod_total_sec:100},200),true);
 assert.equal(processed({backfill_access:{status:'temporary',reason:'timeout'}},null),false);
 assert.equal(processed({backfill_access:{status:'unavailable',reason:'삭제 안내 확인'}},null),true);
});
