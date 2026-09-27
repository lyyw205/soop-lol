import assert from "node:assert/strict";
import { test } from "node:test";

import { NexonApiError, NexonClient } from "./client.ts";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { "content-type": "application/json" },
});

test("닉네임 조회는 키 헤더와 URL 인코딩을 한 관문에서 처리한다", async () => {
  const seen: { url: string; key: string | null }[] = [];
  const client = new NexonClient({
    apiKey: "secret",
    fetchImpl: async (input, init) => {
      const headers = new Headers(init?.headers);
      seen.push({ url: String(input), key: headers.get("x-nxopen-api-key") });
      return json({ ouid: "opaque-id" });
    },
  });
  assert.equal(await client.ouidByNickname("감독 이름"), "opaque-id");
  assert.equal(seen[0]?.key, "secret");
  assert.equal(new URL(seen[0].url).searchParams.get("nickname"), "감독 이름");
});

test("존재하지 않는 감독명은 null이고 유효하지 않은 키는 치명 오류다", async () => {
  const missing = new NexonClient({
    apiKey: "key",
    fetchImpl: async () => json({ error: { name: "OPENAPI00004", message: "invalid" } }, 400),
  });
  assert.equal(await missing.ouidByNickname("없는감독"), null);

  const badKey = new NexonClient({
    apiKey: "bad",
    fetchImpl: async () => json({ error: { name: "OPENAPI00005", message: "bad key" } }, 400),
  });
  await assert.rejects(() => badKey.userBasic("id"), (error: unknown) =>
    error instanceof NexonApiError && error.isAuthProblem);
});

test("매치 목록은 공식 최대치 100으로 제한하고 상세의 상대 ouid를 보존한다", async () => {
  const calls: URL[] = [];
  const client = new NexonClient({
    apiKey: "key",
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      calls.push(url);
      if (url.pathname.endsWith("/user/match")) return json(["match-1"]);
      return json({
        matchId: "match-1", matchDate: "2026-09-19T12:00:00", matchType: 60,
        matchInfo: [
          { ouid: "a", nickname: "A", matchDetail: { matchResult: "무" } },
          { ouid: "b", nickname: "B", matchDetail: { matchResult: "무" } },
        ],
      });
    },
  });
  assert.deepEqual(await client.matchIds("a", 60, 0, 999), ["match-1"]);
  assert.equal(calls[0].searchParams.get("limit"), "100");
  const detail = await client.matchDetail("match-1");
  assert.deepEqual(detail?.matchInfo.map((p) => p.ouid), ["a", "b"]);
});
