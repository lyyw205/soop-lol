import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { OUTPUT, hash, missingRanges, ownedDirectory } from './common.mjs';
import { snapshotScan } from './frames.mjs';
import { boundedAudio, importTranscripts, planWindows } from './audio.mjs';
import { evidenceClips, labelFrames, selectAudio, selectRechecks, validateSelection } from './select.mjs';
import { buildPacket, renderPacket, validatePacket } from './packet.mjs';
import { LocalModel, localEndpoint } from './model.mjs';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ck-context-'));
  return { dir, close: () => rmSync(dir, { recursive: true, force: true }) };
}
const speech = (id: string, at: number, text = '다음 판 정글 바꿔볼까') => ({ id, kind: 'asr', at, end: at + 30, text, engine: 'sensevoice' });
const answer = (id = 'q0') => ({ selected_ids: [id], recheck_ids: [] });

test('production scan and image bytes stay unchanged; missing images do not remove candidates', () => {
  const f = fixture();
  try {
    const image = join(f.dir, 'original.jpg'); writeFileSync(image, 'original-image-bytes');
    const original = { vod_id: 777, total_sec: 600, run_id: 'stable', candidates: [
      { n: 1, from: 100, to: 106, peak: 103, peak_score: 0.99, frame: image, names: null },
      { n: 2, from: 200, to: 206, peak: 206, peak_score: 0.72, frame: join(f.dir, 'missing.jpg') }], overview_pages: [] };
    const path = join(f.dir, 'scan.json'); writeFileSync(path, JSON.stringify(original));
    const before = hash(readFileSync(path)), result = snapshotScan(path, join(f.dir, 'experiment'), 777);
    assert.equal(hash(readFileSync(path)), before);
    assert.equal(readFileSync(image, 'utf8'), 'original-image-bytes');
    assert.deepEqual(result.candidates.map(({ n, from, to, peak, peak_score }: { n: number; from: number; to: number; peak: number; peak_score: number }) => ({ n, from, to, peak, peak_score })),
      original.candidates.map(({ n, from, to, peak, peak_score }) => ({ n, from, to, peak, peak_score })));
    assert.equal(readFileSync(result.candidates[0].frame, 'utf8'), 'original-image-bytes');
    assert.equal(result.candidates[1].frame, null);
    assert.equal(result.frame_failures.length, 1);
  } finally { f.close(); }
});

test('audio downloads stay bounded and split at HLS file boundaries', () => {
  const pieces = boundedAudio([[10, 800]], [{ index: 1, offset_sec: 0, length_sec: 350 }, { index: 2, offset_sec: 350, length_sec: 500 }]);
  assert.equal(pieces.reduce((n, p) => n + p.span, 0), 800);
  assert.ok(pieces.every(p => p.span <= 300 && p.at + p.span <= p.part.offset_sec + p.part.length_sec));
  assert.throws(() => boundedAudio([[800, 200]], [{ index: 1, offset_sec: 0, length_sec: 850 }]), /범위 밖/);
  assert.throws(() => boundedAudio([[0, 0]], []), /범위/);
});

test('analysis covers all available speech, keeps gaps and uses overlap without moving timestamps', () => {
  const evidence = [speech('a', 0), speech('b', 30), speech('c', 60), speech('d', 300)];
  const windows = planWindows(evidence, 60, 30);
  assert.deepEqual(windows.map(w => [w.from, w.to]), [[0, 60], [60, 90], [300, 330]]);
  assert.ok(windows[0].evidence.some((e: { id: string }) => e.id === 'c'));
  assert.deepEqual(missingRanges(400, evidence.map(e => [e.at, e.end])), [[90, 300], [330, 400]]);
});

test('imports reject wrong VOD and unconverted API timestamps', () => {
  const f = fixture();
  try {
    const path = join(f.dir, 'sensevoice.transcript.json');
    writeFileSync(path, JSON.stringify({ complete: true, signature: { engine: 'sensevoice' }, chunks: [{ key: 'a', at: 0, end: 30, text: '랜드 하실래요' }] }));
    const manifest = { vodId: 7, vodSeconds: 60, timestampBasis: 'API duration' };
    writeFileSync(join(f.dir, 'samples.json'), JSON.stringify(manifest));
    assert.throws(() => importTranscripts([path], { vod_id: 7, total_sec: 60 }), /시간축/);
    manifest.timestampBasis = 'HLS global seconds';
    writeFileSync(join(f.dir, 'samples.json'), JSON.stringify(manifest));
    assert.throws(() => importTranscripts([path], { vod_id: 8, total_sec: 60 }), /다른 VOD/);
    const data = importTranscripts([path, path], { vod_id: 7, total_sec: 60 });
    assert.equal(data.evidence.length, 1);
  } finally { f.close(); }
});

test('selector rejects invented IDs, freeform claims, quotes and factual classifications', () => {
  const evidence = [speech('a1', 0)];
  assert.throws(() => validateSelection(answer('missing'), evidence), /선별/);
  assert.throws(() => validateSelection({ ...answer(), summary: '정글 변경 확정' }, evidence), /ID만/);
  for (const key of ['claim', 'quote', 'game', 'status', 'subject']) {
    const value = { ...answer(), [key]: '모델이 만든 정보' };
    assert.throws(() => validateSelection(value, evidence), /ID만/);
  }
  assert.deepEqual(validateSelection(answer(), evidence), { selected: [{ source_id: 'a1' }], recheck_ids: [] });
});

test('failed selection remains unprocessed and cannot trigger a full-transcript handoff', async () => {
  const f = fixture();
  try {
    const model = { chat: async () => answer('invented-id') };
    const selection = await selectAudio(model, { total_sec: 60 }, { evidence: [speech('a1', 0)] }, f.dir, { windowSeconds: 60 });
    assert.equal(selection.failures.length, 1); assert.deepEqual(selection.unprocessed_ranges, [[0, 60]]);
    assert.equal(selection.completed.length, 0); assert.deepEqual(selection.selected, []);
    assert.deepEqual(evidenceClips(selection, [speech('a1', 0)]), []);
  } finally { f.close(); }
});

test('selection keeps adjacent rejection and merges overlap without bridging missing audio', () => {
  const rows = [speech('a', 0, '이거 랜드 하실래요?'), speech('b', 30, '아니요 못해요'), speech('c', 60), speech('d', 300)];
  const selection = validateSelection({ selected_ids: ['q0', 'q1'], recheck_ids: [] }, rows);
  const clips = evidenceClips(selection, rows);
  assert.equal(clips.length, 1); assert.deepEqual(clips[0].source_ids, ['a', 'b', 'c']);
  assert.deepEqual(clips[0].selected_ids, ['a', 'b']); assert.equal(clips[0].end, 90);
  assert.equal(evidenceClips(validateSelection(answer('q3'), rows), rows)[0].at, 300);
});

test('retranscription requests are deduplicated and bounded by seconds', () => {
  const requested = selectRechecks(['a', 'b', 'a'], [speech('a', 10), speech('b', 40)], 45);
  assert.deepEqual(requested, [[10, 45]]);
  assert.deepEqual(selectRechecks(['a'], [speech('a', 0)], 0), []);
});

test('image selection accepts only scene and readability, never generated OCR or interpretation', async () => {
  const f = fixture();
  try {
    const frame = join(f.dir, 'frame.jpg'); writeFileSync(frame, 'image');
    const scan = { candidates: [], extra_frames: [{ at: 0, frame }] };
    const bad = await labelFrames({ chat: async () => ({ scene: 'result', readability: 'clear', visible_text: '추측한 이름' }) }, scan, f.dir, 1);
    assert.equal(bad.failures.length, 1); assert.equal(bad.labels.length, 0);
    const good = await labelFrames({ chat: async () => ({ scene: 'result', readability: 'clear' }) }, scan, f.dir, 1);
    assert.equal(good.failures.length, 0); assert.equal(good.labels.length, 1);
  } finally { f.close(); }
});

test('experimental output refuses production paths and symlink escapes', () => {
  const f = fixture(); mkdirSync(OUTPUT, { recursive: true });
  const alias = join(OUTPUT, `symlink-test-${process.pid}`);
  try {
    assert.throws(() => ownedDirectory('out/ck/777/local'), /실험 출력/);
    symlinkSync(f.dir, alias);
    assert.throws(() => ownedDirectory(join(alias, 'escaped')), /심볼릭/);
  } finally { rmSync(alias, { force: true }); f.close(); }
});

test('packet preserves every candidate and selected raw text without injecting claims or summaries', () => {
  const f = fixture();
  try {
  const scan = { vod_id: 1, total_sec: 600, candidates: [{ n: 1, from: 100, to: 110, peak: 106 }, { n: 2, from: 400, to: 410, peak: 406 }], map: [], source: {} };
  const evidence = [speech('a', 0, '하 선 누 님 랜드 하실래요??'), speech('b', 30, '아니요'), speech('c', 300, '선택 안 한 대화')];
  const selection = { ...validateSelection(answer(), evidence), completed: [], processed_ranges: [[0, 60]], unprocessed_ranges: [[60, 600]], failures: [] };
  const packet = buildPacket(scan, { evidence, ranges: [[0, 60], [300, 330]] }, selection, { labels: [], failures: [], unlabelled: [] }, { model: {} });
  validatePacket(packet);
  assert.equal(packet.reviews.length, 2);
  assert.equal(packet.coverage.full_vod_selected, false);
  assert.equal(packet.provenance.database_written, false);
  assert.deepEqual(packet.contract.opened_by_claude, []);
  const delivery = renderPacket(packet, f.dir), brief = JSON.parse(readFileSync(join(f.dir, 'handoff.json'), 'utf8'));
  assert.equal(brief.sources.a.text, evidence[0].text); assert.equal(brief.sources.b.text, evidence[1].text);
  assert.ok(!brief.sources.c); assert.equal(packet.evidence.c.text, evidence[2].text);
  assert.equal(delivery.model_authored_claims, 0); assert.equal(delivery.delivered_source_count, 2);
  for (const key of ['events', 'flow', 'summary', 'secondary_events']) assert.ok(!(key in brief));
  Object.assign(packet.clips[0], { claim: '지어낸 결론' }); assert.throws(() => validatePacket(packet), /해석 필드/);
  } finally { f.close(); }
});

test('local model client caches by input/model but rejects truncated output or context overflow', async () => {
  const f = fixture(); let calls = 0, digest = 'one', mode = 'normal';
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const c of request) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    response.setHeader('content-type', 'application/json');
    if (request.url === '/api/tags') response.end(JSON.stringify({ models: [{ name: 'test:4b', digest }] }));
    else if (request.url === '/api/show') response.end(JSON.stringify({ capabilities: ['completion'] }));
    else {
      calls++; assert.equal(body.stream, false); assert.equal(body.think, false); assert.equal(body.format.type, 'object');
      response.end(JSON.stringify({ done: true, done_reason: mode === 'truncated' ? 'length' : 'stop', message: { content: '{"ok":true}' }, eval_count: 3,
        prompt_eval_count: mode === 'overflow' ? 8192 : 20 }));
    }
  });
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const model = new LocalModel({ endpoint: `http://127.0.0.1:${address.port}`, model: 'test:4b', directory: f.dir });
    const args = { system: 'test', input: { at: 1 }, schema: { type: 'object' } };
    await model.check(); assert.deepEqual(await model.chat(args), { ok: true }); await model.chat(args); assert.equal(calls, 1);
    digest = 'two'; await model.check(); await model.chat(args); assert.equal(calls, 2);
    mode = 'truncated'; await assert.rejects(model.chat({ ...args, input: { at: 2 } }), /출력 잘림/);
    mode = 'overflow'; await assert.rejects(model.chat({ ...args, input: { at: 3 } }), /컨텍스트/);
    assert.throws(() => localEndpoint('https://example.com'), /로컬/);
    assert.throws(() => localEndpoint('http://127.0.0.1@other.example'), /로컬/);
  } finally { await new Promise<void>(ok => server.close(() => ok())); f.close(); }
});
