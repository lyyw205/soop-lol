import assert from "node:assert/strict";
import { test } from "node:test";

import type { MatchDto, ParticipantDto } from "../riot/types.ts";
import {
  deriveEncounters,
  durationSeconds,
  toMatchRow,
  toParticipantRows,
  type EncounterParticipant,
} from "./transform.ts";

// ── 픽스처 ───────────────────────────────────────────────────────────

function participant(over: Partial<ParticipantDto> & { puuid: string }): ParticipantDto {
  return {
    participantId: 1,
    teamId: 100,
    win: true,
    championId: 157,
    championName: "Yasuo",
    kills: 5, deaths: 2, assists: 7,
    teamPosition: "MIDDLE",
    individualPosition: "MIDDLE",
    ...over,
  };
}

function match(over: Partial<MatchDto["info"]> = {}, participants: ParticipantDto[] = []): MatchDto {
  return {
    metadata: { dataVersion: "2", matchId: "KR_7000000001", participants: participants.map((p) => p.puuid) },
    info: {
      gameId: 7000000001,
      platformId: "KR",
      gameCreation: 1_770_000_000_000,
      gameStartTimestamp: 1_770_000_030_000,
      gameEndTimestamp: 1_770_001_830_000,
      gameDuration: 1800,
      gameMode: "CLASSIC",
      gameType: "MATCHED_GAME",
      gameVersion: "16.3.512.1234",
      mapId: 11,
      queueId: 420,
      participants,
      teams: [
        { teamId: 100, win: true },
        { teamId: 200, win: false },
      ],
      ...over,
    },
  };
}

// ── gameDuration 단위 ────────────────────────────────────────────────

test("durationSeconds — gameEndTimestamp 가 있으면 초 그대로", () => {
  assert.equal(durationSeconds({ gameDuration: 1800, gameEndTimestamp: 1_770_001_830_000 }), 1800);
});

test("durationSeconds — gameEndTimestamp 가 없으면 밀리초다 (구 경기)", () => {
  assert.equal(durationSeconds({ gameDuration: 1_800_000, gameEndTimestamp: undefined }), 1800);
});

test("durationSeconds — 값이 없으면 null", () => {
  assert.equal(durationSeconds({ gameDuration: undefined as unknown as number }), null);
});

// ── match 행 ─────────────────────────────────────────────────────────

test("toMatchRow — 기본 매핑", () => {
  const row = toMatchRow(match());
  assert.equal(row.match_id, "KR_7000000001");
  assert.equal(row.platform_id, "KR");
  assert.equal(row.queue_id, 420);
  assert.equal(row.winning_team, 100);
  assert.equal(row.source, "public_queue");
  assert.equal(row.game_creation.getTime(), 1_770_000_000_000);
  assert.equal(row.game_duration, 1800);
});

test("toMatchRow — 리메이크는 승리 팀이 없다 (NULL)", () => {
  const row = toMatchRow(match({ teams: [{ teamId: 100, win: false }, { teamId: 200, win: false }] }));
  assert.equal(row.winning_team, null);
});

test("toMatchRow — platformId 가 비면 matchId 에서 복구한다", () => {
  const row = toMatchRow(match({ platformId: "" }));
  assert.equal(row.platform_id, "KR");
});

test("toMatchRow — 항복 종료를 참가자에서 집계한다", () => {
  const row = toMatchRow(match({}, [participant({ puuid: "p1", gameEndedInSurrender: true })]));
  assert.equal(row.ended_in_surrender, true);
});

test("toParticipantRows — CS 는 미니언+정글몹 합이고 아이템은 7칸 고정", () => {
  const rows = toParticipantRows(
    match({}, [participant({ puuid: "p1", totalMinionsKilled: 180, neutralMinionsKilled: 22, item0: 3153 })]),
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cs, 202);
  assert.deepEqual(rows[0].items, [3153, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(rows[0].challenges, {});
});

test("toParticipantRows — 빈 포지션 문자열은 NULL 로 눕힌다", () => {
  const rows = toParticipantRows(match({}, [participant({ puuid: "p1", teamPosition: "", individualPosition: "" })]));
  assert.equal(rows[0].team_position, null);
  assert.equal(rows[0].individual_position, null);
});

// ── 조우 판정 ────────────────────────────────────────────────────────

const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";
const C = "33333333-3333-3333-3333-333333333333";

function ep(over: Partial<EncounterParticipant> & { puuid: string }): EncounterParticipant {
  return {
    team_id: 100,
    team_position: "MIDDLE",
    individual_position: "MIDDLE",
    win: true,
    champion_id: 157,
    kills: 5, deaths: 2, assists: 7,
    cs: 200, gold_earned: 12000, damage_to_champions: 25000,
    ...over,
  };
}

const soloq: Parameters<typeof deriveEncounters>[0] = {
  match_id: "KR_7000000001",
  queue_id: 420,
  source: "public_queue",
  game_creation: new Date(1_770_000_000_000),
  game_duration: 1800,
};

test("deriveEncounters — 스트리머가 하나뿐이면 조우가 아니다", () => {
  const rows = deriveEncounters(soloq, [ep({ puuid: "pa" })], new Map([["pa", A]]));
  assert.equal(rows.length, 0);
});

test("deriveEncounters — 반대 팀 같은 포지션이면 맞라인", () => {
  const rows = deriveEncounters(
    soloq,
    [ep({ puuid: "pa", team_id: 100, win: true }), ep({ puuid: "pb", team_id: 200, win: false })],
    new Map([["pa", A], ["pb", B]]),
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].relation, "opponent");
  assert.equal(rows[0].is_lane_matchup, true);
  assert.equal(rows[0].a_win, true);
  assert.equal(rows[0].b_win, false);
});

test("deriveEncounters — 같은 팀이면 ally 이고 맞라인은 아니다", () => {
  const rows = deriveEncounters(
    soloq,
    [ep({ puuid: "pa", team_id: 100 }), ep({ puuid: "pb", team_id: 100 })],
    new Map([["pa", A], ["pb", B]]),
  );
  assert.equal(rows[0].relation, "ally");
  assert.equal(rows[0].is_lane_matchup, false);
});

test("deriveEncounters — 포지션 추론이 어긋나면 맞라인으로 세지 않는다", () => {
  const rows = deriveEncounters(
    soloq,
    [
      ep({ puuid: "pa", team_id: 100, team_position: "MIDDLE", individual_position: "TOP" }),
      ep({ puuid: "pb", team_id: 200, team_position: "MIDDLE", individual_position: "MIDDLE" }),
    ],
    new Map([["pa", A], ["pb", B]]),
  );
  assert.equal(rows[0].is_lane_matchup, false);
  assert.equal(rows[0].a_position, null, "판정 실패한 쪽은 포지션도 NULL 이다");
  assert.equal(rows[0].b_position, "MIDDLE");
});

test("deriveEncounters — 칼바람엔 라인이 없다", () => {
  const rows = deriveEncounters(
    { ...soloq, queue_id: 450 },
    [ep({ puuid: "pa", team_id: 100 }), ep({ puuid: "pb", team_id: 200 })],
    new Map([["pa", A], ["pb", B]]),
  );
  assert.equal(rows[0].is_lane_matchup, false);
});

test("deriveEncounters — 쌍은 항상 a < b 로 정규화된다 (스키마 CHECK 와 같은 규칙)", () => {
  const rows = deriveEncounters(
    soloq,
    // 큰 uuid 를 먼저 넣어도 순서가 뒤집히지 않아야 한다
    [ep({ puuid: "pc", team_id: 200 }), ep({ puuid: "pa", team_id: 100 })],
    new Map([["pc", C], ["pa", A]]),
  );
  assert.equal(rows[0].streamer_a_id, A);
  assert.equal(rows[0].streamer_b_id, C);
  assert.equal(rows[0].a_puuid, "pa", "스냅샷도 같이 뒤집혀야 한다");
  assert.equal(rows[0].b_puuid, "pc");
});

test("deriveEncounters — 3명이면 쌍은 3개다", () => {
  const rows = deriveEncounters(
    soloq,
    [ep({ puuid: "pa" }), ep({ puuid: "pb" }), ep({ puuid: "pc", team_id: 200 })],
    new Map([["pa", A], ["pb", B], ["pc", C]]),
  );
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.streamer_a_id < r.streamer_b_id));
});

test("deriveEncounters — 한 스트리머의 계정 두 개가 같은 경기에 있어도 자기 자신과 쌍을 만들지 않는다", () => {
  // 매핑 사고 시나리오. 이걸 막지 않으면 encounter_ordered CHECK 에서 터진다.
  const rows = deriveEncounters(
    soloq,
    [ep({ puuid: "pa1" }), ep({ puuid: "pa2", team_id: 200 })],
    new Map([["pa1", A], ["pa2", A]]),
  );
  assert.equal(rows.length, 0);
});

test("deriveEncounters — 매핑 안 된 puuid 는 무시한다", () => {
  const rows = deriveEncounters(
    soloq,
    [ep({ puuid: "pa" }), ep({ puuid: "일반인" }), ep({ puuid: "pb", team_id: 200 })],
    new Map([["pa", A], ["pb", B]]),
  );
  assert.equal(rows.length, 1);
});
