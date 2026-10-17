import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OpenVodRequest } from '@soop-lol/core/lib/db/vod-request';
import type { VodWork } from '@soop-lol/core/lib/metrics/ck-vod-status';
import { planVodRequests, type RequestFacts } from './lib/ck-vod-request.ts';

const req = (n: number, over: Partial<OpenVodRequest> = {}): OpenVodRequest => ({
  title_no: n, channel_id: null, priority: 100, state: 'queued', requested_at: new Date(0),
  reasons: ['submission'], submission_ids: ['s'], notes: [], ...over,
});
const work = (over: Partial<VodWork> = {}): VodWork => ({ reason: 'new', unavailable: false, uncovered: null, failed: 0, unresolved: 0, opened: 0, settled: 0, ...over });
const meta = (n: number) => ({ key: `vod:${n}`, title_no: n, channel_id: 'ch', streamer: '누구', slug: 'ch', title: '방송', ended_at: '2026-10-09 12:00:00', hours: 3, category: null });
const facts = (n: number, over: Partial<RequestFacts> = {}): [number, RequestFacts] => [n, { meta: meta(n), work: work(), scan_status: null, blocked: false, ...over }];

test('할 일이 남은 요청 VOD — 대기열 맨 앞(우선순위·사유), 처음 본 요청만 claimed 로', () => {
  const p = planVodRequests([req(1), req(2, { state: 'claimed', reasons: ['admin', 'submission'] })], new Map([facts(1), facts(2, { work: work({ reason: 'running' }) })]));
  assert.deepEqual(p.enqueue.map((x) => [x.title_no, x.priority, x.reason]), [[1, 100, 'new · 회원 제보 판독 요청'], [2, 100, 'running · 운영자·회원 제보 판독 요청']]);
  assert.deepEqual(p.claim, [{ title_no: 1, channel_id: 'ch' }]);
  assert.deepEqual([p.reopen, p.close, p.waiting], [[], [], []]);
});

test('끝난 조사 — 처음 본 요청이면 다시 연다(반복 제한도 무시), 대기열에 넣은 뒤 끝났으면 done 으로 닫는다', () => {
  const done = work({ reason: null });
  const p = planVodRequests([req(1), req(2, { state: 'claimed' })],
    new Map([facts(1, { work: done, scan_status: 'done', blocked: true }), facts(2, { work: done, scan_status: 'done' })]));
  assert.deepEqual(p.reopen, [1]);
  assert.deepEqual(p.enqueue.map((x) => [x.title_no, x.reason]), [[1, 'running · 회원 제보 판독 요청']]);
  assert.deepEqual(p.close, [{ title_no: 2, state: 'done', note: '요청 뒤 판독 끝' }]);
});

test('영상 없음은 unavailable 로 닫고, 정보를 모르거나 반복 제한이면 그대로 둔다(지어내지 않는다)', () => {
  const p = planVodRequests([req(1), req(2), req(3), req(4)],
    new Map([facts(1, { work: work({ reason: null, unavailable: true }) }), facts(2, { meta: null }), facts(3, { blocked: true })]));
  assert.deepEqual(p.close, [{ title_no: 1, state: 'unavailable', note: '접근 불가로 기록된 VOD' }]);
  assert.deepEqual(p.waiting.map((w) => w.title_no), [2, 3, 4]);
  assert.deepEqual([p.enqueue, p.claim, p.reopen], [[], [], []]);
});
