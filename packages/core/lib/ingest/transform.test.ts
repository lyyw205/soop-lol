import assert from "node:assert/strict";
import { test } from "node:test";

import type { MatchDto, ParticipantDto } from "../riot/types.ts";
import {
  durationSeconds,
  isTournamentCodeGame,
  STORED_CHALLENGE_KEYS,
  toDetailRows,
  toMatchRow,
  toParticipantRows,
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
  assert.equal(row.game_code, "lol");
  assert.equal(row.platform_id, "KR");
  assert.equal(row.riot_game_id, 7000000001);
  assert.equal(row.queue_id, 420);
  assert.equal(row.mode_key, "420");
  assert.equal(row.winning_team, 100);
  assert.equal(row.collected_via, "api");
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

// ── 토너먼트 코드 판정 ───────────────────────────────────────────────
// 토너먼트 코드 판은 내전 세트(versus)로, 그 밖의 Riot 판은 개인 기록(personal)으로 간다.
// 한 번 섞이면 어느 경기가 원래 내전이었는지 되돌릴 방법이 없어서, 두 신호를 각각 못 박아 둔다.

test("isTournamentCodeGame — queue 3130 은 토너먼트 코드 판이다", () => {
  assert.equal(isTournamentCodeGame(match({ queueId: 3130 }).info), true);
});

test("isTournamentCodeGame — tournamentCode 가 있으면 큐가 뭐든 토너먼트 코드 판이다", () => {
  assert.equal(isTournamentCodeGame(match({ queueId: 0, tournamentCode: "KR050c3-aa" }).info), true);
});

test("isTournamentCodeGame — 빈 tournamentCode 는 근거가 아니다", () => {
  assert.equal(isTournamentCodeGame(match({ queueId: 420, tournamentCode: "" }).info), false);
});

test("isTournamentCodeGame — 솔랭은 아니다", () => {
  assert.equal(isTournamentCodeGame(match().info), false);
});

test("toMatchRow — 토너먼트 코드가 저장된다", () => {
  const row = toMatchRow(match({ queueId: 3130, tournamentCode: "KR050c3-aa" }));
  assert.equal(row.tournament_code, "KR050c3-aa");
  assert.equal(row.collected_via, "api");
});

test("toMatchRow — 공개 큐는 tournament_code 가 null 이다", () => {
  assert.equal(toMatchRow(match()).tournament_code, null);
});

test("toMatchRow — 버린 칸(game_type·game_start·game_end·source)을 만들지 않는다", () => {
  const row = toMatchRow(match()) as unknown as Record<string, unknown>;
  for (const k of ["game_type", "game_start", "game_end", "source", "has_timeline"]) assert.equal(k in row, false, k);
});

const only = (...puuids: string[]) => new Set(puuids);

test("toDetailRows — CS 는 미니언+정글몹 합이고 아이템은 7칸 고정", () => {
  const rows = toDetailRows(
    match({}, [participant({ puuid: "p1", totalMinionsKilled: 180, neutralMinionsKilled: 22, item0: 3153 })]), only("p1"),
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cs, 202);
  assert.deepEqual(rows[0].items, [3153, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(rows[0].challenges, {});
});

test("toDetailRows — challenges 는 화면이 읽는 키만 남긴다(이벤트 모드·숫자 아닌 값은 버린다)", () => {
  const challenges = { soloKills: 3, kda: 4.5, SWARM_KillEnemy: 0, abilityUses: 210, legendaryItemUsed: [3100] } as unknown as Record<string, number>;
  const [row] = toDetailRows(match({}, [participant({ puuid: "p1", challenges })]), only("p1"));
  assert.deepEqual(row.challenges, { soloKills: 3, kda: 4.5 });
  assert.ok(Object.keys(row.challenges!).every((k) => (STORED_CHALLENGE_KEYS as readonly string[]).includes(k)));
});

test("toDetailRows — 룬은 핵심 룬과 보조 계열만, 공개 뷰(personal_game)가 읽는 경로 그대로", () => {
  const perks = {
    statPerks: { defense: 5011, flex: 5008, offense: 5008 },
    styles: [
      { description: "primaryStyle", style: 8100, selections: [{ perk: 8112, var1: 1719, var2: 0, var3: 0 }, { perk: 8143, var1: 1291 }] },
      { description: "subStyle", style: 8000, selections: [{ perk: 8014, var1: 923 }] },
    ],
  };
  const [row] = toDetailRows(match({}, [participant({ puuid: "p1", perks })]), only("p1"));
  assert.deepEqual(row.perks, { styles: [{ selections: [{ perk: 8112 }] }, { style: 8000 }] });
  // 뷰의 경로: perks #>> '{styles,0,selections,0,perk}' · '{styles,1,style}'
  assert.equal(row.perks?.styles[0].selections[0].perk, 8112);
  assert.equal(row.perks?.styles[1].style, 8000);
  // 둘 다 없으면 저장하지 않는다
  assert.equal(toDetailRows(match({}, [participant({ puuid: "p2", perks: { statPerks: { defense: 5002 } } })]), only("p2"))[0].perks, null);
});

test("toParticipantRows — 빈 포지션 문자열은 NULL 로 눕힌다", () => {
  const rows = toParticipantRows(match({}, [participant({ puuid: "p1", teamPosition: "", individualPosition: "" })]));
  assert.equal(rows[0].team_position, null);
  assert.equal(rows[0].individual_position, null);
});

// ── 기본 칸 / 상세 ────────────────────────────────────────────────────

test("toDetailRows — 지명 계정의 상세만 만든다(나머지 참가자는 기본 칸만)", () => {
  const dto = match({}, [participant({ puuid: "p1", participantId: 1 }), participant({ puuid: "p2", participantId: 2, teamId: 200 })]);
  assert.equal(toParticipantRows(dto).length, 2, "기본 칸은 모두");
  assert.deepEqual(toDetailRows(dto, only("p2")).map((d) => d.participant_id), [2]);
  assert.deepEqual(toDetailRows(dto, only()), []);
});

test("toParticipantRows — 기본 칸만 담는다(버림 칸·상세 칸이 없다)", () => {
  const [row] = toParticipantRows(match({}, [participant({ puuid: "p1", lane: "MIDDLE", role: "SOLO", visionScore: 30 })])) as unknown as Record<string, unknown>[];
  for (const k of ["lane", "role", "damage_taken", "wards_placed", "wards_killed", "control_wards", "turret_kills", "first_blood_kill",
                   "cs", "gold_earned", "damage_to_champions", "vision_score", "items", "summoner1_id", "summoner2_id", "perks", "challenges"]) {
    assert.equal(k in row, false, k);
  }
  assert.equal(row.outcome, "win");
});
