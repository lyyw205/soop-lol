import {test} from 'node:test';
import assert from 'node:assert/strict';
import {advanceGuard,guardBlocked,parseGuard,type BackfillGuard} from './ck-backfill-guard.ts';
import type {VodWork} from '../../packages/core/lib/metrics/ck-vod-status.ts';
const base: VodWork = {reason:'running',unavailable:false,uncovered:0,failed:0,unresolved:1,opened:10,settled:0,saved_matches:0};
test('새 이미지 한 장씩만 읽으면 세 번째 세션 후 재실행도 보류한다',()=>{
 let guard: BackfillGuard|null=null, before=base;
 for(let n=1;n<=3;n++){
  const after={...before,opened:before.opened+1};
  guard=advanceGuard(guard,`session-${n}`,before,after);
  // 프로세스를 다시 실행해 저장된 JSON을 읽는 경우도 동일하다.
  guard=parseGuard(JSON.parse(JSON.stringify(guard)));
  assert.equal(guard.no_outcome_sessions,n);assert.equal(guardBlocked(guard,after),n===3);
  before=after;
 }
 assert.deepEqual(advanceGuard(guard,'session-3',base,before),guard,'after 재호출은 횟수를 늘리지 않는다');
});
test('경기 저장·후보 결론·범위 감소·완료는 횟수를 초기화한다',()=>{
 const guard=advanceGuard(null,'old',base,{...base});guard.no_outcome_sessions=3;
 for(const after of [{...base,saved_matches:1},{...base,settled:1},{...base,unresolved:0},{...base,reason:null}]){
  assert.equal(guardBlocked(guard,after),false);
  assert.equal(advanceGuard(guard,'next',base,after).no_outcome_sessions,0);
 }
 assert.equal(advanceGuard(guard,'next',{...base,uncovered:100},{...base,uncovered:50}).no_outcome_sessions,0);
});
test('결과가 계속 저장되는 긴 VOD에는 총 세션 수 제한을 걸지 않는다',()=>{
 let guard: BackfillGuard|null=null,before=base;
 for(let n=1;n<=10;n++){
  const after={...before,saved_matches:n};guard=advanceGuard(guard,`save-${n}`,before,after);
  assert.equal(guard.no_outcome_sessions,0);assert.equal(guardBlocked(guard,after),false);before=after;
 }
});
test('외부에서 DB 결과가 진척되면 이전 제한을 해제하지만 열람 증가만으로는 못 푼다',()=>{
 const guard:BackfillGuard={version:1,attempt_id:'old',no_outcome_sessions:3,after:base};
 assert.equal(guardBlocked(guard,{...base,opened:99}),true);
 const before={...base,saved_matches:1};
 assert.equal(guardBlocked(guard,before),false);
 assert.equal(advanceGuard(guard,'next',before,{...before,opened:11}).no_outcome_sessions,1);
 assert.throws(()=>parseGuard({...guard,no_outcome_sessions:-1}));
 assert.throws(()=>parseGuard({}));
});
