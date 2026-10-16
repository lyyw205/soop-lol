import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claim, emptyQueue, enqueue, recover, release, rememberPending, type AutoVod, type PendingVod } from './lib/ck-auto-queue.ts';
const item = (n: number, channel = `ch${n}`, at = '2026-10-09 12:00:00'): AutoVod => ({
  key: `vod:${n}`, title_no: n, channel_id: channel, streamer: channel, slug: channel,
  title: '방송', ended_at: at, hours: 1, category: null, reason: 'unseen',
});
test('시간별 재조회는 진행 중 소유권을 보존하고 VOD를 중복 등록하지 않는다', () => {
  const q = emptyQueue(); enqueue(q, [item(1)], 0); claim(q, 'worker1', 0);
  enqueue(q, [item(1), item(2)], 100);
  assert.equal(Object.keys(q.jobs).length, 2);
  assert.equal(q.jobs['vod:1'].owner, 'worker1');
  assert.equal((claim(q, 'worker2', 100) as AutoVod).title_no, 2);
});
test('같은 채널은 직렬 조사하고 KST/UTC를 섞어도 오래된 VOD부터 가져온다', () => {
  const q = emptyQueue(); enqueue(q, [item(2, 'same', '2026-10-09T03:10:00Z'), item(1, 'same'), item(3, 'other', '2026-10-09T03:20:00Z')], 0);
  assert.equal((claim(q, 'w1', 0) as AutoVod).title_no, 1);
  assert.equal((claim(q, 'w2', 0) as AutoVod).title_no, 3);
  assert.equal(claim(q, 'w3', 0), 'wait');
  release(q, 'vod:1', 'w1', null);
  assert.equal((claim(q, 'w1', 0) as AutoVod).title_no, 2);
});
test('진척 없는 작업은 시간별 재조회로 재시도 시각이 초기화되지 않는다', () => {
  const q = emptyQueue(); enqueue(q, [item(1)], 0); claim(q, 'w', 0);
  release(q, 'vod:1', 'w', 6000); enqueue(q, [item(1)], 1000);
  assert.equal(claim(q, 'w', 5999), null);
  assert.equal((claim(q, 'w', 6000) as AutoVod).title_no, 1);
});
test('재시작은 중단된 소유권만 회수하고 미룬 작업의 재시도 시각을 보존한다', () => {
  const q = emptyQueue(); enqueue(q, [item(1), item(2)], 0);
  claim(q, 'old', 0); claim(q, 'other', 0); release(q, 'vod:2', 'other', 6000);
  recover(q); assert.equal((claim(q, 'new', 100) as AutoVod).title_no, 1);
  assert.equal(q.jobs['vod:2'].not_before, 6000);
  assert.throws(() => release(q, 'vod:1', 'old', null), /소유권/);
});
test('아직 DB 단서가 없는 대기도 원본 메타데이터와 최초 발견일을 보존한다', () => {
  const pending: Record<string, PendingVod> = {};
  rememberPending(pending, { ...item(1), duration_sec: 3581 }, '2026-10-09');
  rememberPending(pending, { ...item(1), duration_sec: 3581 }, '2026-10-10');
  assert.equal(pending['vod:1'].since, '2026-10-09');
  assert.equal(pending['vod:1'].item?.duration_sec, 3581);
  assert.equal(pending['vod:1'].item?.channel_id, 'ch1');
});
