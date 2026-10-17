import { test } from "node:test";
import assert from "node:assert/strict";

import {
  matchStreamerNames, normalizeScheduleReport, normalizeVodHint, parseVodClock, scheduleInputFromReport, scheduleReportHasChange, submissionLines, vodHintLines,
} from "./submission.ts";

const names = { streamer: (id: string) => id, champion: (id: number) => String(id) };

test("편성표 제보 정규화 — 빈 칸을 지우고 제목 공백·참가자 중복을 정리한다", () => {
  assert.deepEqual(normalizeScheduleReport({ type: "correction", title: "  멸망전   결승 ", status: "", participants: "가, 나\n가 ,  " }),
    { type: "correction", title: "멸망전 결승", participants: "가, 나" });
  assert.equal(scheduleReportHasChange({ type: "correction" }), false);
  assert.equal(scheduleReportHasChange({ type: "new" }), true);
});

test("편성표 제보 정규화 — 새 일정은 게임·제목·날짜, 시각은 날짜와 함께, 없는 날짜는 거부", () => {
  assert.throws(() => normalizeScheduleReport({ type: "new", game_code: "lol", title: "x" }), /날짜/);
  assert.throws(() => normalizeScheduleReport({ type: "new", game_code: "lol", title: "x", on_date: "2026-02-30" }), /없는 날짜/);
  assert.throws(() => normalizeScheduleReport({ type: "correction", start: "20:00" }), /날짜도/);
  assert.throws(() => normalizeScheduleReport({ type: "new", game_code: "lol", title: "x", on_date: "2026-11-01", status: "cancelled" }), /상태/);
  assert.deepEqual(normalizeScheduleReport({ type: "correction", on_date: "2026-11-01", start: "" }), { type: "correction", on_date: "2026-11-01", start: null });
});

test("이름 → 스트리머는 표시 이름·slug 와 정확히 같은 것만(대소문자 무시), 같은 사람은 한 번", () => {
  const streamers = [{ slug: "faker", display_name: "페이커" }, { slug: "zeus", display_name: "제우스" }];
  assert.deepEqual(matchStreamerNames("페이커, FAKER, 제우, 모르는사람", streamers), { slugs: ["faker"], unmatched: ["제우", "모르는사람"] });
  assert.deepEqual(matchStreamerNames("", streamers), { slugs: [], unmatched: [] });
});

test("읽는 줄은 종류로 갈린다", () => {
  assert.deepEqual(submissionLines({ kind: "schedule_report", payload: { type: "correction", status: "cancelled" } }, names), ["일정 고치기", "상태: 취소"]);
  assert.deepEqual(submissionLines({ kind: "match_correction", payload: { winning_team: { from: 100, to: 200 } } }, names), ["승리 팀: 블루 → 레드"]);
});

test("VOD 단서 정규화 — 링크 → 번호, 시점 → 초(분만 쓰면 분), 사람 글자 정리, 잘못된 시점은 거부", () => {
  assert.deepEqual(normalizeVodHint({ vod: "https://vod.sooplive.com/player/209748301/embed", from: "1:20", to: "1:40:30", people: " A ,B, A " }),
    { vod: 209748301, from_sec: 4800, to_sec: 6030, people: "A, B" });
  assert.deepEqual(normalizeVodHint({ vod: "209748301", from: "45" }), { vod: 209748301, from_sec: 2700 });
  assert.deepEqual(normalizeVodHint({ vod: 209748301, from_sec: 60 }), { vod: 209748301, from_sec: 60 });
  for (const [raw, msg] of [[{ vod: "x" }, /VOD 링크/], [{ vod: "1", to: "1:00" }, /시작 시점/], [{ vod: "1", from: "2:00", to: "1:00" }, /뒤여야/],
    [{ vod: "1", from: "1:75" }, /시:분:초/]] as const) assert.throws(() => normalizeVodHint(raw), msg);
  assert.deepEqual(vodHintLines({ vod: 1, from_sec: 4800 }), ["VOD 1에 내전이 있다", "시점: 1:20:00 무렵"]);
  assert.equal(parseVodClock(""), null);
});

test("편성표 제보 → 저장 입력(바로 반영) — 바꾼 칸만, 시작을 옮기면 끝도 같은 길이, 있던 사람 역할 유지·새 사람은 선수, 근거는 출처로", () => {
  const base = {
    game_code: "lol" as const, title: "CK", planned_format: "ck" as const, sponsor: null, description: null, admin_note: "메모", status: "scheduled" as const,
    event_id: null, visibility: "public" as const,
    slots: [{ label: null, on_date: "2026-11-20", starts_at: new Date("2026-11-20T11:00:00Z"), ends_at: new Date("2026-11-20T14:00:00Z"), channel_id: null }],
    participants: [{ streamer_id: "A", role: "host" as const, team: null }, { streamer_id: "B", role: "player" as const, team: "1팀" }],
    sources: [{ url: "https://x.test/1", title: "공지", posted_at: null }],
  };
  const out = scheduleInputFromReport(base, { type: "correction", on_date: "2026-11-21", start: "21:00", participants: "A, C" }, "https://x.test/2", ["A", "C"]);
  assert.equal(out.slots[0].starts_at?.toISOString(), "2026-11-21T12:00:00.000Z");
  assert.equal(out.slots[0].ends_at?.toISOString(), "2026-11-21T15:00:00.000Z");
  assert.deepEqual(out.participants, [{ streamer_id: "A", role: "host", team: null }, { streamer_id: "C", role: "player", team: null }]);
  assert.deepEqual(out.sources.map((x) => x.url), ["https://x.test/1", "https://x.test/2"]);
  assert.equal(out.admin_note, "메모");
  assert.equal(scheduleInputFromReport(base, { type: "correction", status: "cancelled" }, null, null).slots[0].starts_at?.toISOString(), "2026-11-20T11:00:00.000Z");
  assert.throws(() => scheduleInputFromReport({ ...base, slots: [base.slots[0], { ...base.slots[0], on_date: "2026-11-22" }] },
    { type: "correction", on_date: "2026-11-23" }, null, null), /방송 칸이 여럿/);
  const made = scheduleInputFromReport(null, { type: "new", game_code: "lol", title: "새 대회", on_date: "2026-11-25", start: null }, "https://x.test/3", ["A"]);
  assert.deepEqual([made.planned_format, made.status, made.visibility, made.slots[0].starts_at, made.participants[0].role, made.sources[0].url],
    ["unclassified", "scheduled", "public", null, "player", "https://x.test/3"]);
});
