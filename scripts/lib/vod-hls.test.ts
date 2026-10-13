import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { segmentsSpan } from "./vod-hls.mjs";

// 차단 응답의 본문을 영상으로 이어붙이면 ffmpeg 오류로만 보이고 차단을 못 알아챈다(2026-10-13 간격 시험 전 점검).
test("세그먼트가 403·429 면 상태 코드로 실패한다 — 본문을 영상으로 넘기지 않는다", async (t) => {
  const server = createServer((req, res) => {
    if (req.url === "/ok.ts") { res.writeHead(200); res.end(Buffer.alloc(10)); return; }
    res.writeHead(429); res.end("Too Many Requests");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const dir = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const ok = await segmentsSpan({ segs: [{ start: 0, dur: 6, uri: "ok.ts" }], dir, init: null }, 0, 6);
  assert.equal(ok?.bytes, 10);
  await assert.rejects(segmentsSpan({ segs: [{ start: 0, dur: 6, uri: "blocked.ts" }], dir, init: null }, 0, 6), /HLS 세그먼트 HTTP 429/);
});
