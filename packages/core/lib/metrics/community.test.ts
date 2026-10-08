import { test } from "node:test";
import assert from "node:assert/strict";

import { activeSanction, rejoinBlockedUntil } from "./community.ts";

const d = (s: string) => new Date(`${s}T00:00:00Z`);
const iso = (x: Date) => x.toISOString().slice(0, 10);

test("재가입 제한 — 제재가 없으면 탈퇴 + 30일", () => {
  assert.equal(iso(rejoinBlockedUntil(d("2026-10-01"), [])), "2026-10-31");
});

test("재가입 제한 — 기간 제재는 끝날 때까지, 30일보다 짧으면 30일", () => {
  const long = { created_at: d("2026-09-20"), ends_at: d("2026-12-01"), lifted_at: null };
  const short = { created_at: d("2026-09-28"), ends_at: d("2026-10-05"), lifted_at: null };
  assert.equal(iso(rejoinBlockedUntil(d("2026-10-01"), [long])), "2026-12-01");
  assert.equal(iso(rejoinBlockedUntil(d("2026-10-01"), [short])), "2026-10-31");
});

test("★ 재가입 제한 — 탈퇴 뒤에 걸린 영구 제재도 반영된다(제재 시각 + 1년)", () => {
  // 탈퇴 29일째 영구 제재 → 31일째에도 막혀 있어야 한다
  const late = { created_at: d("2026-10-30"), ends_at: null, lifted_at: null };
  const until = rejoinBlockedUntil(d("2026-10-01"), [late]);
  assert.equal(iso(until), "2027-10-30");
  assert.ok(until > d("2026-11-01"));
});

test("재가입 제한 — 풀린 제재는 세지 않는다(다시 30일 기준)", () => {
  const lifted = { created_at: d("2026-09-20"), ends_at: null, lifted_at: d("2026-10-02") };
  assert.equal(iso(rejoinBlockedUntil(d("2026-10-01"), [lifted])), "2026-10-31");
});

test("지금 막는 제재 — 시작 전·끝난 뒤·풀린 것은 아니다", () => {
  const now = d("2026-10-10");
  const ended = { created_at: d("2026-10-01"), ends_at: d("2026-10-05"), lifted_at: null };
  const running = { created_at: d("2026-10-08"), ends_at: d("2026-10-15"), lifted_at: null };
  const permanent = { created_at: d("2026-10-01"), ends_at: null, lifted_at: null };
  const lifted = { created_at: d("2026-10-01"), ends_at: null, lifted_at: d("2026-10-09") };
  assert.equal(activeSanction([ended, lifted], now), null);
  assert.equal(activeSanction([ended, running], now), running);
  assert.equal(activeSanction([permanent], now), permanent);
});

import {
  isUuid, moderationTransition, normalizePostInput, parseContentId, parseGameFilter, parseTopicFilter,
  validateCommentBody, validatePostInput, validateReport, writeLimitMessage,
} from "./community.ts";

test("게임 필터 — lol·fconline·etc 만, 나머지는 전체(null). platform·옛 이름 common 은 받지 않는다", () => {
  assert.equal(parseGameFilter("lol"), "lol");
  assert.equal(parseGameFilter("etc"), "etc");
  assert.equal(parseGameFilter("common"), null);
  assert.equal(parseGameFilter("platform"), null);
  assert.equal(parseGameFilter(undefined), null);
  assert.equal(parseTopicFilter("question"), "question");
  assert.equal(parseTopicFilter("toString"), null);
});

test("글 입력 — 회원은 공지를 못 쓰고, 길이·태그 수를 검사한다", () => {
  const base = normalizePostInput({ game_code: "lol", topic: "free", title: "  제목 ", body: "본문\r\n둘째 줄\r\n\r\n", streamer_ids: ["a", "a"] });
  assert.equal(base.title, "제목");
  assert.equal(base.body, "본문\n둘째 줄");
  assert.deepEqual(base.streamer_ids, ["a"]);
  assert.deepEqual(validatePostInput(base), []);
  assert.match(validatePostInput({ ...base, topic: "notice" }).join(), /말머리/);
  assert.deepEqual(validatePostInput({ ...base, topic: "notice" }, { allowNotice: true }), []);
  assert.match(validatePostInput({ ...base, title: "" }).join(), /제목/);
  assert.match(validatePostInput({ ...base, body: "   " }).join(), /본문/);
  assert.match(validatePostInput({ ...base, streamer_ids: ["1", "2", "3", "4", "5", "6"] }).join(), /5명/);
  assert.match(validatePostInput({ ...base, game_code: "platform" as never }).join(), /게임/);
  assert.match(validateCommentBody("").join(), /댓글/);
});

test("신고 — 기타는 설명이 필요하다", () => {
  assert.deepEqual(validateReport("spam", null), []);
  assert.match(validateReport("other", " ").join(), /설명/);
  assert.match(validateReport("hate", null).join(), /사유/);
});

test("쓰기 한도 — 창마다 센다(글 1분 1개·하루 20개)", () => {
  const now = new Date("2026-11-01T12:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);
  assert.equal(writeLimitMessage("post", [], now), null);
  assert.match(writeLimitMessage("post", [ago(30_000)], now)!, /1분에 1개/);
  assert.equal(writeLimitMessage("post", [ago(61_000)], now), null);
  assert.match(writeLimitMessage("post", Array.from({ length: 20 }, (_, i) => ago(3_600_000 + i)), now)!, /하루 20개/);
});

test("운영 상태 전이 — 해제는 숨김→공개만, 삭제된 글은 되살리지 않는다", () => {
  assert.deepEqual(moderationTransition("published", "hide"), { next: "hidden" });
  assert.deepEqual(moderationTransition("hidden", "blind"), { next: "hidden" });
  assert.deepEqual(moderationTransition("hidden", "restore"), { next: "published" });
  assert.match((moderationTransition("deleted", "restore") as { error: string }).error, /되살리지/);
  assert.match((moderationTransition("published", "restore") as { error: string }).error, /숨긴 글이 아닙니다/);
  assert.match((moderationTransition("deleted", "hide") as { error: string }).error, /숨길 수 없습니다/);
  assert.deepEqual(moderationTransition("published", "keep"), { next: "published" });
});

test("주소의 번호·회원 id — 숫자·uuid 가 아니면 질의 전에 거른다", () => {
  assert.equal(parseContentId("42"), 42);
  assert.equal(parseContentId("042"), null);
  assert.equal(parseContentId("1e3"), null);
  assert.equal(parseContentId("write"), null);
  assert.ok(isUuid("2cb80fe7-082b-4f3e-a9a5-48f03f4bed13"));
  assert.ok(!isUuid("2cb80fe7"));
});
