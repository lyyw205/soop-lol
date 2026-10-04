/**
 * FC 화면 경기 검수 — 사람이 근거 프레임을 보며 값을 고치고, 같은 경기의 API 기록에 잇고, 완료한다.
 * (docs/FCO-SCREEN-MATCH-DESIGN.md §4 단계 3·7단계)
 *
 * ★ 이 모듈은 **공개 여부를 바꾸지 않는다.** 화면 경기는 계속 숨김(`visibility='hidden'`)이다.
 *   공개 표시(단계 4)는 별도 설계가 끝나기 전까지 하지 않는다 — 검수 완료는 "사람이 봤다"는 도장일 뿐이다.
 * ★ 완료·보호는 LoL 검수와 같은 칸을 쓴다 — `match.review_completed_at`·`review_version`·`reviewed_at`.
 *   참가자 트리거(0072)가 실제 값 변경 시 완료를 해제하고 변경 번호를 올린다.
 * ★ 사람이 고친 경기는 `reviewed_at` 이 찍혀 자동 조사(`saveFcoScreenMatch`)가 덮지 않는다.
 * ★ 모든 변경은 `review_change` 에 남긴다 — 완료가 왜 풀렸는지 나중에 알 수 있어야 한다(2026-10-02 의 교훈).
 */

import type postgres from "postgres";

import { db } from "../../db/client.ts";
import { linkScreenTo, resolveSide, screenOutcomes, type ResolvedSide } from "./screen.ts";

type ResolvedSideBasis = ResolvedSide["basis"];

// 읽기는 match-units.ts(정본 경기·시점)와 sessions.ts(대전) 하나다. 여기는 화면 기록을 고치는 쓰기만 둔다.

const norm = (name: string) => name.normalize("NFKC").trim().replace(/\s+/g, "").toLowerCase();

// ── 쓰기 ────────────────────────────────────────────────────────────

type Sql = postgres.TransactionSql;

/** 화면 경기 한 건을 잠그고 변경 번호를 확인한다. 화면 경기가 아니면 거부한다. */
async function lockScreen(tx: Sql, matchId: string, expectedVersion: number) {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new Error("검수 기준값이 없습니다. 새로고침해 주세요.");
  const [cur] = await tx<{ review_version: number; review_completed_at: Date | null; reviewed_at: Date | null }[]>`
    SELECT review_version, review_completed_at, reviewed_at FROM match
     WHERE match_id = ${matchId} AND game_code = 'fconline' AND source = 'manual' AND origin = 'vod_scan' FOR UPDATE`;
  if (!cur) throw new Error("화면 경기를 찾지 못했습니다.");
  if (cur.review_version !== expectedVersion) throw new Error("경기 값이 바뀌었습니다. 새로고침 후 다시 확인해 주세요.");
  return cur;
}

async function log(tx: Sql, matchId: string, entity: "match" | "participant", key: string, field: string, before: unknown, after: unknown) {
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  await tx`INSERT INTO review_change (match_id, entity, entity_key, field, before, after)
           VALUES (${matchId}, ${entity}, ${key}, ${field}, ${before == null ? null : tx.json(before as postgres.JSONValue)}, ${after == null ? null : tx.json(after as postgres.JSONValue)})`;
}

/**
 * 이 칸의 사람을 어떻게 할지.
 *   keep  지금 붙은 사람·근거를 그대로 둔다 (기본). ★ 방송 주인(vod_owner) 근거는 닉네임으로 다시 판정하면 사라진다 —
 *         화면 경기 169칸 중 56칸이 그랬다. 그래서 "건드리지 않으면 그대로"가 기본이어야 한다.
 *   auto  닉네임으로 다시 판정한다 (등록 계정과 정확히 하나만 일치할 때만 붙는다)
 *   none  사람을 뗀다
 *   { slug }  사람이 직접 지정한다 (근거 manual)
 */
export type ScreenPersonEdit = "keep" | "auto" | "none" | { slug: string };
export interface ScreenSideEdit {
  nickname: string;
  score: number | null;
  person: ScreenPersonEdit;
}
export type ScreenOutcomeEdit = "auto" | "first_win" | "second_win" | "draw";

/** 닉네임·점수·사람·결과를 고친다. 연결된 경기는 고치지 않는다(원본이 그쪽에 있다). */
/** @returns 저장 뒤의 변경 번호 — 「저장하고 완료」가 같은 트랜잭션에서 이어서 완료를 찍을 때 쓴다 */
export async function updateScreenSides(matchId: string, expectedVersion: number, edits: [ScreenSideEdit, ScreenSideEdit], outcome: ScreenOutcomeEdit, outer?: Sql): Promise<number> {
  for (const e of edits) {
    if (!e.nickname.trim()) throw new Error("닉네임이 비었습니다.");
    if (e.score != null && (!Number.isInteger(e.score) || e.score < 0 || e.score > 99)) throw new Error("점수는 0~99 의 정수여야 합니다.");
  }
  const run = async (tx: Sql): Promise<number> => {
    const cur = await lockScreen(tx, matchId, expectedVersion);
    const linked = await tx`SELECT 1 FROM fco_screen_link WHERE screen_match_id = ${matchId}`;
    if (linked.length) throw new Error("다른 경기에 연결된 화면 경기입니다. 연결을 풀고 고치세요.");

    const before = await tx<{ side_no: number; nickname: string; score_display: number | null; streamer_id: string | null; identity_basis: string | null; outcome: string | null }[]>`
      SELECT side_no, nickname, score_display, streamer_id, identity_basis, outcome FROM fco_match_participant WHERE match_id = ${matchId} ORDER BY side_no`;
    if (before.length !== 2) throw new Error("참가자 두 칸이 없는 경기입니다.");

    const resolveEdit = async (e: ScreenSideEdit, b: (typeof before)[number]) => {
      const nickname = e.nickname.trim();
      if (e.person === "keep") return { nickname, streamerId: b.streamer_id, basis: b.identity_basis as ResolvedSideBasis, key: b.streamer_id ?? `name:${norm(nickname)}`, score: e.score };
      if (e.person === "none") return { nickname, streamerId: null, basis: null, key: `name:${norm(nickname)}`, score: e.score };
      if (e.person === "auto") return resolveSide(tx, { nickname, score: e.score });
      return resolveSide(tx, { nickname, score: e.score, streamerSlug: e.person.slug, basis: "manual" });
    };
    const resolved = [await resolveEdit(edits[0], before[0]), await resolveEdit(edits[1], before[1])] as const;
    if (resolved[0].key === resolved[1].key) throw new Error("두 칸이 같은 사람입니다. 닉네임·사람을 확인하세요.");

    const direct = outcome === "first_win" ? ["win", "loss"] as const : outcome === "second_win" ? ["loss", "win"] as const : outcome === "draw" ? ["draw", "draw"] as const : null;
    const outs = screenOutcomes([
      { nickname: edits[0].nickname, score: edits[0].score, ...(direct ? { outcome: direct[0] } : {}) },
      { nickname: edits[1].nickname, score: edits[1].score, ...(direct ? { outcome: direct[1] } : {}) },
    ]);

    for (const [i, r] of resolved.entries()) {
      await tx`UPDATE fco_match_participant
                  SET nickname = ${r.nickname}, score_display = ${r.score}, streamer_id = ${r.streamerId}, identity_basis = ${r.basis}, outcome = ${outs[i]}
                WHERE match_id = ${matchId} AND side_no = ${i + 1}`;
      const b = before[i];
      const key = `${matchId}#${i + 1}`;
      await log(tx, matchId, "participant", key, "nickname", b.nickname, r.nickname);
      await log(tx, matchId, "participant", key, "score", b.score_display, r.score);
      await log(tx, matchId, "participant", key, "streamer_id", b.streamer_id, r.streamerId);
      await log(tx, matchId, "participant", key, "identity_basis", b.identity_basis, r.basis);
      await log(tx, matchId, "participant", key, "outcome", b.outcome, outs[i]);
    }
    // The participant trigger invalidates actual value changes from every write path.
    // A no-op save keeps completion intact; manual edits remain protected.
    const [saved] = await tx<{ review_version: number; review_completed_at: Date | null }[]>`
      UPDATE match SET reviewed_at = COALESCE(reviewed_at, now()) WHERE match_id = ${matchId}
      RETURNING review_version, review_completed_at`;
    await log(tx, matchId, "match", matchId, "review_completed", cur.review_completed_at != null, saved.review_completed_at != null);
    return saved.review_version;
  };
  return outer ? run(outer) : db().begin(run);
}

/** 같은 경기라고 사람이 판단해 다른 기록(API 또는 다른 화면 경기)에 잇는다. */
export async function linkScreenByAdmin(matchId: string, expectedVersion: number, targetId: string): Promise<void> {
  await db().begin(async (tx) => {
    await lockScreen(tx, matchId, expectedVersion);
    if (matchId === targetId) throw new Error("자기 자신에게는 연결할 수 없습니다.");
    const [target] = await tx<{ match_id: string }[]>`SELECT match_id FROM match WHERE match_id = ${targetId} AND game_code = 'fconline' FOR UPDATE`;
    if (!target) throw new Error("연결할 경기를 찾지 못했습니다.");
    if ((await tx`SELECT 1 FROM fco_screen_link WHERE screen_match_id = ${targetId}`).length) throw new Error("그 경기는 이미 다른 경기에 연결돼 있습니다.");
    if ((await tx`SELECT 1 FROM fco_screen_link WHERE screen_match_id = ${matchId}`).length) throw new Error("이미 연결된 경기입니다.");
    await linkScreenTo(tx, matchId, targetId, { participants: "admin", score: "admin" }, "admin");
    await tx`UPDATE match SET review_version = review_version + 1, reviewed_at = COALESCE(reviewed_at, now()) WHERE match_id = ${matchId}`;
    await log(tx, matchId, "match", matchId, "screen_link", null, targetId);
  });
}

/** 연결을 푼다. 연결할 때 대상으로 복사한 근거 프레임도 거두어 온다(그 키는 이 화면 경기의 것뿐이다). */
export async function unlinkScreenByAdmin(matchId: string, expectedVersion: number): Promise<void> {
  await db().begin(async (tx) => {
    await lockScreen(tx, matchId, expectedVersion);
    const [link] = await tx<{ api_match_id: string }[]>`SELECT api_match_id FROM fco_screen_link WHERE screen_match_id = ${matchId}`;
    if (!link) throw new Error("연결돼 있지 않은 경기입니다.");
    await tx`DELETE FROM fco_context_evidence
              WHERE match_id = ${link.api_match_id}
                AND evidence_key IN (SELECT evidence_key FROM fco_context_evidence WHERE match_id = ${matchId})`;
    await tx`DELETE FROM fco_screen_link WHERE screen_match_id = ${matchId}`;
    await tx`UPDATE match SET review_completed_at = NULL, review_version = review_version + 1, reviewed_at = COALESCE(reviewed_at, now()) WHERE match_id = ${matchId}`;
    await log(tx, matchId, "match", matchId, "screen_link", link.api_match_id, null);
  });
}
