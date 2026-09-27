import {test} from 'node:test';
import assert from 'node:assert/strict';
import {checkedReviewChanges,sameReviewValue} from './review-patch.ts';
test('검수 비교는 날짜를 정규화하되 배열을 문자열로 뭉개지 않는다',()=>{
  assert.equal(sameReviewValue(new Date('2026-09-22T00:00:00Z'),'2026-09-22T09:00:00+09:00'),true);
  assert.equal(sameReviewValue(['a,b'],['a','b']),false);
  assert.equal(sameReviewValue(['a','b'],['b','a']),false);
  assert.equal(sameReviewValue(null,0),false);
  assert.equal(sameReviewValue(new Date(0),null),false);
  assert.equal(sameReviewValue(5,'5'),false);
});
test('변경 필드의 기대값과 허용 목록을 검사한다',()=>{
  assert.throws(()=>checkedReviewChanges({kills:5},{kills:6},{},['kills']),/기대값/);
  assert.throws(()=>checkedReviewChanges({kills:5},{kills:6},{kills:4},['kills']),/다른 검수자/);
  assert.throws(()=>checkedReviewChanges({}, {reviewed_at:null},{reviewed_at:null},['kills']),/허용|바꿀 수 없는/);
  assert.deepEqual(checkedReviewChanges({kills:5},{kills:5},{kills:5},['kills']),{});
  assert.deepEqual(checkedReviewChanges({kills:5},{kills:undefined},{},['kills']),{});
});
