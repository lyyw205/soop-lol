import { test } from 'node:test';
import assert from 'node:assert/strict';
import jpeg from 'jpeg-js';
import { coveragePoints, fetchSheets, cellIndexAt, cellOf } from './vod-timeline.mjs';

/** 시트 한 장: 앞 used 칸은 무늬(빈 칸이 아님), 나머지는 검정. seed 로 시트끼리 다르게. */
function sheet(used: number, seed: number) {
  const W = 1920, H = 1080, data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const cell = Math.floor(y / 108) * 10 + Math.floor(x / 192), o = (y * W + x) * 4;
    const v = cell < used ? ((x * 7 + y * 13 + seed * 31) % 200) : 0;
    data[o] = v; data[o + 1] = (v + seed) % 255; data[o + 2] = 255 - v; data[o + 3] = 255;
  }
  return Buffer.from(jpeg.encode({ width: W, height: H, data }, 70).data);
}
const FULL1 = sheet(100, 1), FULL2 = sheet(100, 2);
const res = (status: number, body: Buffer) => ({ status, arrayBuffer: async () => body });
/** column → 응답. 없는 column 은 정상 끝(500 + 빈 본문). */
const server = (map: Record<number, any>, calls: number[] = []) => async (url: string) => {
  const c = Number(new URL(url).searchParams.get('column'));
  calls.push(c);
  const v = map[c];
  return typeof v === 'function' ? v() : v ?? res(500, Buffer.alloc(0));
};
const file = { snapshot: 'https://videoimg.sooplive.co.kr/php/SnapshotLoad.php?rowKey=abc_t' };
const opts = (fetchImpl: any) => ({ fetchImpl, retryDelayMs: 0 });

test('720p 시트도 마지막 99번 칸까지 정확한 칸을 잘라 표준 크기로 만든다', () => {
 for (const [width,height] of [[1280,720],[1920,1080]]) {
  const data = new Uint8Array(width*height*4);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
   const n=Math.floor(y/(height/10))*10+Math.floor(x/(width/10)); const i=(y*width+x)*4;
   data[i]=n;data[i+1]=255-n;data[i+3]=255;
  }
  for(const n of [0,9,10,57,99]) {
   const im=cellOf({width,height,data},n);
   assert.equal(im.width,192);assert.equal(im.height,108);
   for(const i of [0,4*191,4*192*107,im.data.length-4])assert.deepEqual([...im.data.slice(i,i+4)],[n,255-n,0,255]);
  }
 }
 assert.throws(()=>cellOf({width:1279,height:720,data:new Uint8Array()},0));
});

test('column 0 중복을 빼고 3초 칸으로 끝까지 덮으면 완료다', async () => {
  const last = sheet(10, 3);
  const got = await fetchSheets(file, 330, opts(server({ 0: res(200, FULL1), 1: res(200, FULL1), 2: res(200, last) })));
  assert.equal(got.cells, 110);
  assert.deepEqual(got.failed, []);
  assert.equal(got.sheets[0].column, 1, 'sheets[0] 은 column 1');
  assert.deepEqual(cellIndexAt(got.sheets, got.cells, 301), { sheet: 1, cell: 0, index: 100, at: 300 });
});

test('칸 수가 한 칸 모자라도 끝 3초 안이면 완료다 (실측 ±1)', async () => {
  const got = await fetchSheets(file, 331, opts(server({ 0: res(200, FULL1), 1: res(200, FULL1), 2: res(200, sheet(10, 3)) })));
  assert.deepEqual(got.failed, []);
});

test('파일 끝 전에 온 500 은 끝이 아니다 — 남은 범위가 failed 로 남는다', async () => {
  const got = await fetchSheets(file, 600, opts(server({ 0: res(200, FULL1), 1: res(200, FULL1) })));
  assert.deepEqual(got.failed, [[300, 600]]);
  assert.match(got.reason!, /끝 전에/);
});

test('짧은 오류 응답은 재시도하고, 회복되면 완료다', async () => {
  let n = 0;
  const flaky = () => (n++ === 0 ? res(503, Buffer.from('busy')) : res(200, sheet(100, 2)));
  const got = await fetchSheets(file, 600, opts(server({ 0: res(200, FULL1), 1: res(200, FULL1), 2: flaky })));
  assert.equal(got.cells, 200);
  assert.deepEqual(got.failed, []);
});

test('계속 오류면 그 시트부터 끝까지 failed — 완료로 기록하지 않는다', async () => {
  const got = await fetchSheets(file, 600, opts(server({ 0: res(200, FULL1), 1: res(200, FULL1), 2: res(503, Buffer.from('x')) })));
  assert.deepEqual(got.failed, [[300, 600]]);
  assert.match(got.reason!, /HTTP 503/);
});

test('column 0 과 1 이 다르면 대응을 가정하지 않는다', async () => {
  const got = await fetchSheets(file, 300, opts(server({ 0: res(200, FULL2), 1: res(200, FULL1) })));
  assert.deepEqual(got.failed, [[0, 300]]);
  assert.equal(got.sheets.length, 0);
});

test('덮은 뒤에는 더 요청하지 않는다', async () => {
  const calls: number[] = [];
  await fetchSheets(file, 300, opts(server({ 0: res(200, FULL1), 1: res(200, FULL1) }, calls)));
  assert.deepEqual(calls, [0, 1]);
});

test('짧은 꼬리 파일에도 지점이 떨어지고, 파일마다 끝 지점이 있다', () => {
  const parts = [{ offset: 0, length: 121 }, { offset: 121, length: 30 }];
  const pts = coveragePoints(parts, 151, 120);
  assert.ok(pts.some((t) => t >= 121 && t < 151), `두 번째 파일 지점 없음: ${pts}`);
  assert.ok(pts.includes(91), '첫 파일 끝 − 30');
  assert.ok(pts.includes(121), '두 번째 파일 끝 − 30 은 파일 시작으로 잘린다');
});
