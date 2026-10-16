import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveClubState, pickRepresentative, CLUB_COLLECTION_POLICY, type ClubAttempt } from './club-state.ts';
const now = new Date('2026-10-13T10:00:00Z');
const at = '2026-10-12T10:00:00Z';
const attempt = (outcome: ClubAttempt['outcome']): ClubAttempt => ({startedAt:at,completedAt:outcome ? at : null,outcome,legacy:false});
test('미조회, 진행 중, 실패, missing을 구분하고 마지막 성공 시각은 바꾸지 않는다', () => {
  assert.equal(resolveClubState({attempt:null,value:null,valueAt:null},now).status,null);
  for(const outcome of [null,'ok','error','missing'] as const) {
    const state = resolveClubState({attempt:attempt(outcome),value:100,valueAt:at},now);
    assert.equal(state.status,outcome ?? 'pending');
    assert.equal(state.rank_eligible,outcome !== 'missing');
  }
  assert.equal(resolveClubState({attempt:attempt('error'),value:null,valueAt:null},now).rank_eligible,false);
});
test('48시간 경계와 차트 기간에 무관한 대표 계정', () => {
  for(const [age,expected] of [[CLUB_COLLECTION_POLICY.maxAgeMs-1,true],[CLUB_COLLECTION_POLICY.maxAgeMs,false]] as const) {
    assert.equal(resolveClubState({attempt:attempt('ok'),value:100,valueAt:new Date(+now-age).toISOString()},now).rank_eligible,expected);
  }
  const accounts = [{nickname:'오래된본계',club_value:999,rank_eligible:false},{nickname:'부계',club_value:100,rank_eligible:true}];
  assert.equal(pickRepresentative(accounts)?.nickname,'부계');
  assert.equal(pickRepresentative(accounts.slice(0,1)),null);
});
