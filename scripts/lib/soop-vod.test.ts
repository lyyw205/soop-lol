import { test } from "node:test";
import assert from "node:assert/strict";

import { hlsSegments } from "./soop-vod.mjs";

/** 요청 URL → 응답 본문. 목록에 없는 URL 을 부르면 실패한다(엉뚱한 파일을 재생목록으로 읽는 버그를 잡는다). */
function stubFetch(routes: Record<string, string>) {
  const seen: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    const key = String(url);
    seen.push(key);
    if (!(key in routes)) throw new Error(`예상 못 한 요청: ${key}`);
    return new Response(routes[key]);
  }) as typeof fetch;
  return { seen, restore: () => { globalThis.fetch = original; } };
}

// ★ 2019 VOD 는 manifest 가 화질 목록 없이 곧바로 세그먼트 목록이다. 예전엔 첫 세그먼트 줄을
//   재생목록으로 다시 받아 세그먼트가 0개가 됐고, VOD 가 통째로 '재생 불가' 처럼 보였다.
test("hlsSegments 는 manifest 가 곧바로 세그먼트 목록이면 그 자체를 재생목록으로 쓴다", async () => {
  const base = "https://vod.test/2019/a.mp4";
  const { seen, restore } = stubFetch({
    [`${base}/manifest.m3u8?rp=o00`]: [
      "#EXTM3U", "#EXT-X-VERSION:6", "#EXT-X-TARGETDURATION:9",
      '#EXT-X-MAP:URI="init.m4s"',
      "#EXTINF:8.5,", "seg-0.m4s",
      "#EXTINF:8.5,", "seg-1.m4s",
      "#EXTINF:3.0,", "seg-2.m4s",
      "#EXT-X-ENDLIST",
    ].join("\n"),
    [`${base}/init.m4s`]: "init",
  });
  try {
    const hls = await hlsSegments({ file: `${base}/manifest.m3u8?rp=o00` });
    assert.equal(hls.segs.length, 3);
    assert.deepEqual(hls.segs.map((s: { start: number }) => s.start), [0, 8.5, 17]);
    assert.equal(hls.segs[0].uri, "seg-0.m4s");
    assert.ok(!seen.some((u) => u.includes("seg-0.m4s")), "세그먼트를 재생목록으로 받으면 안 된다");
  } finally {
    restore();
  }
});

test("hlsSegments 는 화질 목록이 있으면 1080p 변형 재생목록을 따라간다", async () => {
  const base = "https://vod.test/2024/b";
  const { restore } = stubFetch({
    [`${base}/master.m3u8`]: [
      "#EXTM3U",
      "#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720", "720/index.m3u8",
      "#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080", "1080/index.m3u8",
    ].join("\n"),
    [`${base}/1080/index.m3u8`]: ["#EXTM3U", "#EXTINF:6.0,", "s0.ts", "#EXTINF:6.0,", "s1.ts"].join("\n"),
  });
  try {
    const hls = await hlsSegments({ file: `${base}/master.m3u8` });
    assert.equal(hls.segs.length, 2);
    assert.equal(hls.dir, `${base}/1080`);
  } finally {
    restore();
  }
});

test('목록 HTTP 200 오류 본문은 백필 소진이 아니라 truncated다', async () => {
  const { listBroadcasts } = await import('./soop-vod.mjs');
  const original = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ error: 'temporary' })) as typeof fetch;
  try {
    const rows = await listBroadcasts('fixture', { maxPages: 1 });
    assert.equal(rows.length, 0);
    assert.equal((rows as typeof rows & { truncated?: boolean }).truncated, true);
  } finally { globalThis.fetch = original; }
});
