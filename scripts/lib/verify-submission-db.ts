/**
 * 사용자 제보(0093) — docs/USER-SUBMISSION-PLAN.md 를 실제 함수로 돌려 본다.
 *
 *   · 접수 → 기존 검수 경로로 바로 반영(actor member, 제보 번호) · 확인 전 판은 집계에서 빠지고 목록에는 보인다(결정 A)
 *   · 중복 막기 네 겹 — 같은 요청 · 같은 지문(+1) · 같은 칸(보류) · 이미 그 값
 *   · 보류 — 검수 완료(결정 B) · 계정 자리 · 다툼 · 한도(결정 C) · 제재 · 닉네임
 *   · 확인(applied 표시 떼기 / held 운영자 반영) · 반려(정확히 되돌리기 / 충돌이면 하나도 안 되돌림) · 중복 합치기
 *   · 판독 보호(member 칸은 사람 칸) · 회원은 분류를 못 바꾼다 · 탈퇴하면 글만 지우고 값·이력은 남는다
 */
import { db } from "../../packages/core/lib/db/client.ts";
import { ADMIN_WRITER, applyMatchReviewInTx } from "../../packages/core/lib/db/ck.ts";
import { placeSetInTx } from "../../packages/core/lib/db/classification.ts";
import * as member from "../../packages/core/lib/db/member.ts";
import * as communityAdmin from "../../packages/core/lib/db/community-admin.ts";
import * as personal from "../../packages/core/lib/db/personal.ts";
import * as opponents from "../../packages/core/lib/db/opponent-history.ts";
import { resolveChampion } from "../../packages/core/lib/db/participant.ts";
import { loadReviewLockInTx } from "../../packages/core/lib/db/review-lock.ts";
import * as sub from "../../packages/core/lib/db/submission.ts";
import { listMemberRoles } from "../../packages/core/lib/db/member-role.ts";
import { POLICY, type PolicyConfig } from "../../packages/core/lib/metrics/submission-policy.ts";
import { SUBMISSION_DAILY_LIMIT } from "../../packages/core/lib/metrics/submission.ts";
import { tally } from "../../packages/core/lib/metrics/tally.ts";
import { lolEvent } from "./verify-ck-fixtures.ts";

type Check = (name: string, ok: boolean, detail?: string) => void;
type ExpectReject = (name: string, fn: () => Promise<unknown>, expected: string) => Promise<void>;

export async function verifySubmissionDb(check: Check, expectReject: ExpectReject): Promise<void> {
  console.log("\n▸ 사용자 제보 — 반영·확인 전·중복·보류·되돌리기 (0093)");
  const sql = db();
  const T0 = new Date("2031-05-01T03:00:00Z");
  let clock = T0;
  const tick = () => (clock = new Date(clock.getTime() + 60_000));
  const rid = () => crypto.randomUUID();

  // ── 준비: 스트리머 셋, 행사 하나, 2세트 시리즈(SB:1·SB:2) + 검수 완료 판(SB:3) + 계정 자리가 있는 판(SB:4) ──
  const mk = async (slug: string, name: string) => (await sql<{ id: string }[]>`INSERT INTO streamer (slug, display_name) VALUES (${slug}, ${name}) RETURNING id`)[0].id;
  const A = await mk("sb-a", "제보A"), B = await mk("sb-b", "제보B"), C = await mk("sb-c", "제보C");
  const ev = await lolEvent("sb-ck", "ck", "제보 시험 CK");
  const puuid = "q".repeat(78);
  await sql`INSERT INTO riot_account (puuid, game_name, tag_line) VALUES (${puuid}, 'sbacc', 'KR1')`;
  await sql`INSERT INTO streamer_account (streamer_id, puuid, confidence, evidence) VALUES (${C}::uuid, ${puuid}, 'verified', ${sql.json({ source: "manual", note: "시험" })})`;
  const game = async (id: string, no: number, minute: number, seats: { pid: number; team: 100 | 200; streamer?: string; puuid?: string; name?: string; champ: number }[]) => {
    await sql.begin(async (tx) => {
      await tx`INSERT INTO match (match_id, game_code, queue_id, mode_key, game_mode, map_id, collected_via, scope, game_creation, game_creation_precision, winning_team)
        VALUES (${id}, 'lol', 0, '0', 'CLASSIC', 11, 'vod', 'personal', ${new Date(T0.getTime() + minute * 60_000)}, 'datetime', 100)`;
      await placeSetInTx(tx, { match_id: id, game_no: no, actor: "admin", series: { id: "sb-series", game_code: "lol", event_id: ev } });
      for (const s of seats) await tx`
        INSERT INTO match_participant (match_id, participant_id, team_id, side_no, streamer_id, puuid, observed_name, champion_id, champion_name, team_position, individual_position, outcome, kills, deaths, assists)
        VALUES (${id}, ${s.pid}, ${s.team}, ${s.team === 100 ? 1 : 2}, ${s.streamer ?? null}::uuid, ${s.puuid ?? null}, ${s.name ?? null}, ${s.champ},
                ${resolveChampion(s.champ, null).champion_name}, 'MIDDLE', 'MIDDLE',
                ${s.team === 100 ? "win" : "loss"}, 1, 1, 1)`;
    });
  };
  const duo = [{ pid: 1, team: 100 as const, streamer: A, champ: 1 }, { pid: 2, team: 200 as const, streamer: B, champ: 2 }, { pid: 3, team: 200 as const, name: "일반인", champ: 3 }];
  await game("SB:1", 1, 0, duo);
  await game("SB:2", 2, 40, duo);
  await game("SB:3", 3, 80, duo);
  await sql`UPDATE match SET review_completed_at = now() WHERE match_id = 'SB:3'`;
  await game("SB:4", 4, 120, [{ pid: 1, team: 100, streamer: A, champ: 1 }, { pid: 2, team: 200, puuid, champ: 2 }]);

  const join = async (subj: string, nickname: string | null) => {
    const r = await member.loginWithIdentity("kakao", subj, T0);
    if (r.kind !== "ok") throw new Error("가입 실패");
    const { token } = await member.createSession(r.memberId, T0);
    if (nickname) await member.setNickname(token, nickname, { agreed: true }, T0);
    return { id: r.memberId, token };
  };
  const W = await join("sb-writer", "제보왕"), O = await join("sb-other", "제보다른"), S = await join("sb-sanct", "제보제재");
  const N = await join("sb-nonick", null), R = await join("sb-rate", "제보한도");
  await communityAdmin.addSanction(S.id, 7, "시험 제재", "admin", T0);

  const vsAB = async () => (await opponents.listOpponentSummaries(A)).find((o) => o.other_id === B)?.record ?? null;
  const before = await vsAB();
  const pend = async (id: string) => (await sql`SELECT 1 FROM core_public.pending_match WHERE match_id = ${id}`).length > 0;
  const inAgg = async (id: string) => (await sql`SELECT 1 FROM core_public.lol_versus_set WHERE match_id = ${id}`).length > 0;
  const inList = async (id: string) => (await sql`SELECT 1 FROM core_public.lol_set_row WHERE match_id = ${id} AND pending`).length > 0;
  const slot = async (id: string, pid: number) => (await sql`SELECT streamer_id, observed_name, champion_id, champion_name, kills, team_position, individual_position FROM match_participant WHERE match_id = ${id} AND participant_id = ${pid}`)[0];
  const winner = async (id: string) => (await sql<{ w: number }[]>`SELECT winning_team AS w FROM match WHERE match_id = ${id}`)[0].w;

  // ── 1. 반영 · 확인 전 ────────────────────────────────────────────────────
  const flip = { winning_team: { from: 100, to: 200 }, participants: [{ participant_id: 1, changes: { champion_id: { from: 1, to: 103 } } }] };
  const req1 = rid();
  const s1 = await sub.submitMatchCorrection(W.token, { request_id: req1, match_id: "SB:1", payload: flip, note: "VOD 보니 레드 승", evidence_url: "https://vod.sooplive.com/player/1" }, tick());
  const hist = await sql<{ actor: string; submission_id: string | null; field: string }[]>`SELECT actor, submission_id, field FROM review_change WHERE match_id = 'SB:1' AND actor = 'member'`;
  check("★ 제보는 기존 검수 경로로 바로 반영된다 — 승리 팀·챔피언(이름은 번호에서)·승패 재계산, 이력은 actor member + 제보 번호",
    s1.kind === "applied" && (await winner("SB:1")) === 200 && (await slot("SB:1", 1)).champion_id === 103 && (await slot("SB:1", 1)).champion_name != null
      && hist.length >= 2 && hist.every((h) => h.submission_id === s1.id)
      && (await sql`SELECT outcome FROM match_participant WHERE match_id = 'SB:1' AND participant_id = 2`)[0].outcome === "win",
    JSON.stringify({ s1, hist: hist.map((h) => h.field) }));
  check("★ 확인 전 판 — 집계 뷰(lol_versus_set·versus_pair_set)에서 빠지고 목록 뷰(lol_set_row·lol_pair_row)에는 pending 으로 보인다",
    (await pend("SB:1")) && !(await inAgg("SB:1")) && (await inList("SB:1"))
      && (await sql`SELECT 1 FROM core_public.versus_pair_set WHERE match_id = 'SB:1'`).length === 0
      && (await sql`SELECT 1 FROM core_public.lol_pair_row WHERE match_id = 'SB:1' AND pending`).length === 2
      && (await sql`SELECT bool_and(pending) AS p FROM core_public.match_detail WHERE match_id = 'SB:1'`)[0].p === true);
  const after = await vsAB();
  check("상대 전적 집계는 확인 전 세트를 세지 않는다 — 제보 전 3세트 → 2세트", before !== null && after !== null
    && before.sets.win + before.sets.loss === 3 && after.sets.win + after.sets.loss === 2, JSON.stringify({ before, after }));
  const listed = await personal.listPersonalSets(A, {}, { listed: true });
  const counted = await personal.listPersonalSets(A, {});
  const history = await personal.listPersonalMatches(A, listed);
  check("개인 기록 — 목록 행에는 확인 전 세트가 보이고(pending), 요약 점수는 집계와 같다(tally 가 뺀다)",
    listed.some((s) => s.match_id === "SB:1" && s.pending) && !counted.some((s) => s.match_id === "SB:1")
      && JSON.stringify(tally(listed)) === JSON.stringify(tally(counted))
      && history.rows[0].pending && history.rows[0].sets.some((s) => s.match_id === "SB:1" && s.pending),
    JSON.stringify(tally(listed)));
  const between = await opponents.listPairSetsBetween(A, B);
  check("상대전적 상세 — 확인 전 세트가 목록에 있고 tally 는 세지 않는다",
    between.some((s) => s.match_id === "SB:1" && s.pending) && tally(between.map((s) => ({ series_id: s.series_id, outcome: s.x_outcome, pending: s.pending }))).sets.win
      + tally(between.map((s) => ({ series_id: s.series_id, outcome: s.x_outcome, pending: s.pending }))).sets.loss === 2);
  const lock = await sql.begin((tx) => loadReviewLockInTx(tx, "SB:1"));
  check("판독 보호 — 제보가 바꾼 칸은 사람 칸이다(자동 판독이 덮지 않는다)",
    lock?.mode === "cells" && [...lock.human].some((k) => k.includes("winning_team")), JSON.stringify(lock));

  // ── 2. 중복 막기 ────────────────────────────────────────────────────────
  const again = await sub.submitMatchCorrection(W.token, { request_id: req1, match_id: "SB:1", payload: flip }, tick());
  check("겹 1 — 같은 요청을 다시 보내면 같은 제보(두 번 누르기·재시도)", again.kind === "repeat" && again.id === s1.id);
  await expectReject("겹 4 — 이미 그 값이면 받지 않는다", () => sub.submitMatchCorrection(O.token, { request_id: rid(), match_id: "SB:1",
    payload: { winning_team: { from: 200, to: 200 } } }, tick()), "바뀐 칸이 없습니다");
  await expectReject("겹 4 — 지금 값과 같은 '고칠 값'은 지워진다(남는 게 없으면 거부)", () => sub.submitMatchCorrection(O.token, { request_id: rid(), match_id: "SB:1",
    payload: { winning_team: { from: 100, to: 200 } } }, tick()), "이미 그 값입니다");
  await expectReject("화면이 본 값이 지금 값과 다르면 거부한다(그 사이 바뀌었다)", () => sub.submitMatchCorrection(O.token, { request_id: rid(), match_id: "SB:1",
    payload: { participants: [{ participant_id: 1, changes: { kills: { from: 7, to: 9 } } }] } }, tick()), "그 사이");
  const contest = await sub.submitMatchCorrection(O.token, { request_id: rid(), match_id: "SB:1", payload: { winning_team: { from: 200, to: 100 } } }, tick());
  check("겹 3 — 확인 전 제보가 고친 칸을 다른 값으로 → 보류(다툼), 값은 그대로", contest.kind === "held" && contest.hold_reason === "contested" && (await winner("SB:1")) === 200);
  const otherCell = await sub.submitMatchCorrection(O.token, { request_id: rid(), match_id: "SB:1", payload: { participants: [{ participant_id: 2, changes: { kills: { from: 1, to: 4 } } }] } }, tick());
  check("같은 판이라도 다른 칸이면 바로 반영된다", otherCell.kind === "applied" && (await slot("SB:1", 2)).kills === 4);
  await sub.supportSubmission(O.token, s1.id, tick());
  await sub.supportSubmission(O.token, s1.id, tick());
  await expectReject("내 제보에는 +1 할 수 없다", () => sub.supportSubmission(W.token, s1.id, tick()), "내가 보낸");
  const held1 = await sub.submitMatchCorrection(W.token, { request_id: rid(), match_id: "SB:3", payload: { participants: [{ participant_id: 3, changes: { observed_name: { from: "일반인", to: "제보C" } } }] } }, tick());
  const twin = await sub.submitMatchCorrection(O.token, { request_id: rid(), match_id: "SB:3", payload: { participants: [{ participant_id: 3, changes: { observed_name: { from: "일반인", to: " 제보C " } } }] } }, tick());
  const [{ n: supporters }] = await sql<{ n: number }[]>`SELECT count(*)::int n FROM submission_supporter WHERE submission_id = ${s1.id}::uuid`;
  check("겹 2 — 같은 내용(정규화 뒤 같은 지문)은 새 제보가 아니라 +1 · +1 은 한 사람 한 번", held1.kind === "held" && held1.hold_reason === "review_completed"
    && twin.kind === "supported" && twin.id === held1.id && supporters === 1, JSON.stringify({ held1, twin, supporters }));

  // ── 3. 보류·거부 이유 ───────────────────────────────────────────────────
  const acct = await sub.submitMatchCorrection(W.token, { request_id: rid(), match_id: "SB:4", payload: { participants: [{ participant_id: 2, changes: { observed_name: { from: null, to: "누구" } } }] } }, tick());
  check("계정이 연결된 자리의 사람 바꾸기는 보류(계정 분쟁 — 원칙 2)", acct.kind === "held" && acct.hold_reason === "account_identity");
  await expectReject("제재 중인 회원은 제보할 수 없다(커뮤니티 제재 하나로)", () => sub.submitMatchCorrection(S.token, { request_id: rid(), match_id: "SB:2",
    payload: { winning_team: { from: 100, to: 200 } } }, tick()), "쓸 수 없");
  await expectReject("닉네임이 없으면 제보할 수 없다", () => sub.submitMatchCorrection(N.token, { request_id: rid(), match_id: "SB:2",
    payload: { winning_team: { from: 100, to: 200 } } }, tick()), "닉네임");
  await expectReject("로그인 없이는 제보할 수 없다", () => sub.submitMatchCorrection(null, { request_id: rid(), match_id: "SB:2",
    payload: { winning_team: { from: 100, to: 200 } } }, tick()), "로그인");
  await expectReject("고칠 수 없는 칸(계정)은 받지 않는다", () => sub.submitMatchCorrection(W.token, { request_id: rid(), match_id: "SB:2",
    payload: { participants: [{ participant_id: 1, changes: { puuid: { from: null, to: "x" } } }] } }, tick()), "고칠 수 없는 칸");
  await expectReject("자리에서 사람을 다 비우면 거부한다(없던 자리는 지우기로)", () => sub.submitMatchCorrection(W.token, { request_id: rid(), match_id: "SB:2",
    payload: { participants: [{ participant_id: 3, changes: { observed_name: { from: "일반인", to: null } } }] } }, tick()), "사람");
  for (let k = 0; k < SUBMISSION_DAILY_LIMIT; k++) {
    await sub.submitMatchCorrection(R.token, { request_id: rid(), match_id: "SB:3", payload: { participants: [{ participant_id: 1, changes: { kills: { from: 1, to: k + 10 } } }] } }, tick());
  }
  await expectReject(`하루 ${SUBMISSION_DAILY_LIMIT}건을 넘으면 거부한다`, () => sub.submitMatchCorrection(R.token, { request_id: rid(), match_id: "SB:3",
    payload: { participants: [{ participant_id: 1, changes: { kills: { from: 1, to: 99 } } }] } }, tick()), `${SUBMISSION_DAILY_LIMIT}건`);
  await sub.supportSubmission(R.token, s1.id, tick());
  check("+1 은 한도에 세지 않는다 — 한도에 걸린 회원도 +1 은 된다",
    (await sql`SELECT 1 FROM submission_supporter WHERE submission_id = ${s1.id}::uuid AND member_id = ${R.id}::uuid`).length === 1);
  await expectReject("회원 제보는 그 판의 칸만 — 시리즈·행사는 바꾸지 못한다(검수 경로의 마지막 방어선)", () => sql.begin((tx) => applyMatchReviewInTx(tx, "SB:2",
    { match: { changes: { series_id: null, series_game_no: null } as never, expect: { series_id: "sb-series", series_game_no: 2 } } },
    { actor: "member", submission_id: s1.id })), "판의 칸만");

  // ── 4. 확인 · 반려 · 되돌리기 ──────────────────────────────────────────────
  await sub.verifySubmission(s1.id, "admin");
  // SB:1 에는 아직 다른 칸 제보(otherCell)가 확인 전이라 판은 여전히 확인 전이다.
  check("판의 확인 전 제보가 다 확인돼야 표시가 사라진다 — 다른 칸 제보가 남아 아직 확인 전", (await pend("SB:1")) && (await winner("SB:1")) === 200);
  await sub.verifySubmission(otherCell.id, "admin");
  const afterVerify = await vsAB();
  check("★ 다 확인하면 집계에 들어간다 — 제보한 값(레드 승)으로", !(await pend("SB:1")) && (await inAgg("SB:1"))
    && afterVerify !== null && afterVerify.sets.win + afterVerify.sets.loss === 3 && afterVerify.sets.loss === (before?.sets.loss ?? 0) + 1, JSON.stringify(afterVerify));

  const snapBefore = await sql`SELECT participant_id, streamer_id, observed_name, champion_id, champion_name, kills, team_id, team_position, individual_position, outcome
    FROM match_participant WHERE match_id = 'SB:2' ORDER BY participant_id`;
  const big = await sub.submitMatchCorrection(W.token, { request_id: rid(), match_id: "SB:2", payload: {
    participants: [{ participant_id: 1, changes: { kills: { from: 1, to: 8 }, team_position: { from: "MIDDLE", to: "TOP" } } }],
    remove: [3],
    add: [{ participant_id: 4, team_id: 100, streamer_id: C, champion_id: 5 }],
  } }, tick());
  check("자리 추가·삭제·여러 칸이 한 제보로 반영된다 — 포지션은 두 칸(팀·개별)을 함께", big.kind === "applied"
    && (await slot("SB:2", 1)).team_position === "TOP" && (await slot("SB:2", 1)).individual_position === "TOP"
    && !(await slot("SB:2", 3)) && (await slot("SB:2", 4))?.streamer_id === C);
  await sub.rejectSubmission(big.id, "admin", "근거 부족");
  const snapAfter = await sql`SELECT participant_id, streamer_id, observed_name, champion_id, champion_name, kills, team_id, team_position, individual_position, outcome
    FROM match_participant WHERE match_id = 'SB:2' ORDER BY participant_id`;
  check("★ 반려 — 그 제보가 남긴 것을 정확히 되돌린다(칸·지운 자리·더한 자리 전부) · 표시도 사라진다",
    JSON.stringify(snapAfter) === JSON.stringify(snapBefore) && !(await pend("SB:2"))
      && (await sql`SELECT state FROM submission WHERE id = ${big.id}::uuid`)[0].state === "reverted",
    JSON.stringify({ snapBefore, snapAfter }));

  const champ = await sub.submitMatchCorrection(W.token, { request_id: rid(), match_id: "SB:2", payload: { participants: [{ participant_id: 2, changes: { champion_id: { from: 2, to: 7 } } }] } }, tick());
  const cur = await slot("SB:2", 2);
  await sql.begin((tx) => applyMatchReviewInTx(tx, "SB:2", { participants: { patch: [{ participant_id: 2,
    changes: { champion_id: 9 } as never, expect: { champion_id: 7, champion_name: cur.champion_name } }] } }, ADMIN_WRITER));
  const detail = await sub.getSubmissionForAdmin(champ.id);
  await expectReject("★ 그 뒤 같은 칸을 누가 또 바꿨으면 되돌리지 않는다(충돌 칸을 알린다)", () => sub.rejectSubmission(champ.id, "admin"), "되돌릴 수 없습니다");
  check("충돌이면 아무것도 안 바뀐다 — 운영자 값 그대로, 제보는 열린 채", (await slot("SB:2", 2)).champion_id === 9 && detail?.conflicts.includes("p2:champion_id") === true
    && (await sql`SELECT state FROM submission WHERE id = ${champ.id}::uuid`)[0].state === "applied", JSON.stringify(detail?.conflicts));
  await sub.verifySubmission(champ.id, "admin");

  await sub.verifySubmission(held1.id, "admin");
  check("보류 제보 확인 — 운영자 이름으로 지금 반영(검수 완료 판도)", (await slot("SB:3", 3)).observed_name === "제보C"
    && (await sql`SELECT count(*)::int n FROM review_change WHERE match_id = 'SB:3' AND field = 'observed_name' AND actor = 'admin'`)[0].n === 1);
  const dupA = await sub.submitMatchCorrection(W.token, { request_id: rid(), match_id: "SB:4", payload: { participants: [{ participant_id: 2, changes: { observed_name: { from: null, to: "누군가" } } }] } }, tick());
  await sub.markSubmissionDuplicate(dupA.id, acct.id, "admin");
  await expectReject("처리된 제보는 다시 처리할 수 없다", () => sub.markSubmissionDuplicate(otherCell.id, acct.id, "admin"), "이미 처리된");
  await sub.rejectSubmission(contest.id, "admin");
  check("중복 — 보류 제보를 다른 제보에 합친다 · 보류 반려는 바뀐 것이 없다",
    (await sql`SELECT state, duplicate_of FROM submission WHERE id = ${dupA.id}::uuid`)[0].duplicate_of === acct.id
      && (await sql`SELECT state FROM submission WHERE id = ${contest.id}::uuid`)[0].state === "rejected" && (await winner("SB:1")) === 200);

  // ── 판정 뼈대(0095) — 기준은 규칙 목록 하나, 상태마다 규칙·기준 버전이 남는다 ─────────────
  const rules = await sql<{ id: string; state: string; rule_id: string; policy_version: string; admin_decision: string | null; intake: Record<string, boolean> }[]>`
    SELECT id, state, rule_id, policy_version, admin_decision, intake FROM submission WHERE kind = 'match_correction'`;
  const byId = new Map(rules.map((r) => [r.id, r]));
  check("판정 규칙·기준 버전이 남는다 — 보류는 hold_<이유>, 운영자 처리는 admin_<결정>, 접수 사실은 intake",
    rules.every((r) => r.rule_id && r.policy_version) && byId.get(held1.id)?.rule_id === "admin_verify" && byId.get(held1.id)?.admin_decision === "verify"
      && byId.get(held1.id)?.intake.review_completed === true && byId.get(big.id)?.rule_id === "admin_reject" && byId.get(contest.id)?.intake.contested === true,
    JSON.stringify(rules.map((r) => [r.state, r.rule_id, r.admin_decision, r.intake])));
  check("같은 기준으로 다시 판정하면 아무것도 바뀌지 않는다(멱등)", (await sub.reconsiderOpenSubmissions()) === 0);

  // ── 계정 권한(0096) — 역할은 판정의 사실, 신뢰 계정·합의 규칙은 꺼 둔 채(사용자 결정) ─────────────
  const policyWith = (config: Partial<PolicyConfig>) => sub.setSubmissionPolicyForVerify({ ...POLICY, version: "verify", config: { ...POLICY.config, ...config } });
  const stateOfSub = async (id: string) => (await sql<{ state: string; rule_id: string; decided_by: string | null }[]>`SELECT state, rule_id, decided_by FROM submission WHERE id = ${id}::uuid`)[0];
  const kills = (pid: number, field: "kills" | "deaths" | "assists", to: number) => ({ participants: [{ participant_id: pid, changes: { [field]: { from: 1, to } } }] });
  const changedOnGrant = await sub.grantMemberRole(O.id, "trusted_reporter", "시험 — 제보가 정확했던 회원", "admin", tick());
  await expectReject("같은 권한을 두 번 줄 수 없다", () => sub.grantMemberRole(O.id, "trusted_reporter", "또", "admin", tick()), "이미 그 권한");
  await expectReject("없는 권한은 줄 수 없다(목록 하나 — metrics/member-role.ts)", () => sub.grantMemberRole(O.id, "editor", "x", "admin", tick()), "없는 권한");
  await expectReject("사유 없이 권한을 줄 수 없다", () => sub.grantMemberRole(R.id, "trusted_reporter", " ", "admin", tick()), "사유");
  const off = await sub.submitMatchCorrection(O.token, { request_id: rid(), match_id: "SB:2", payload: kills(1, "kills", 5) }, tick());
  check("★ 규칙이 꺼져 있으면 권한이 있어도 동작은 그대로 — 바로 반영·확인 전(apply_pending)",
    changedOnGrant === 0 && off.kind === "applied" && (await stateOfSub(off.id)).rule_id === "apply_pending" && (await pend("SB:2")));

  policyWith({ trustedReporter: true });
  const flipped = await sub.reconsiderOpenSubmissions();
  check("★ 규칙을 켜고 다시 판정하면 — 신뢰 제보자의 열린 제보만 검증된다(보류는 그대로, 판은 집계에 들어간다)",
    flipped === 1 && (await stateOfSub(off.id)).state === "verified" && (await stateOfSub(off.id)).rule_id === "trusted"
      && (await stateOfSub(off.id)).decided_by === "policy" && (await stateOfSub(acct.id)).state === "held" && !(await pend("SB:2")) && (await inAgg("SB:2")),
    JSON.stringify({ flipped, off: await stateOfSub(off.id) }));
  const direct = await sub.submitMatchCorrection(O.token, { request_id: rid(), match_id: "SB:2", payload: kills(1, "deaths", 2) }, tick());
  check("켜진 채 신뢰 제보자가 보내면 접수 순간 검증 — 반영되고 확인 전 표시가 없다",
    direct.kind === "verified" && (await stateOfSub(direct.id)).rule_id === "trusted" && !(await pend("SB:2"))
      && (await sql`SELECT kills, deaths FROM match_participant WHERE match_id = 'SB:2' AND participant_id = 1`)[0].deaths === 2);
  // (SB:3 은 위에서 운영자 확인이 참가자를 고쳐 검수 완료가 풀렸다 — 계정 자리 보류로 본다.)
  const heldTrusted = await sub.submitMatchCorrection(O.token, { request_id: rid(), match_id: "SB:4",
    payload: { participants: [{ participant_id: 2, changes: { observed_name: { from: null, to: "또누구" } } }] } }, tick());
  check("신뢰 제보자도 보류 사실(계정 자리)은 건너뛰지 않는다", heldTrusted.kind === "held" && heldTrusted.hold_reason === "account_identity",
    JSON.stringify(heldTrusted));
  await sub.rejectSubmission(heldTrusted.id, "admin");   // 다음 절(열린 제보 목록)이 보는 판을 원래대로
  const changedOnRevoke = await sub.revokeMemberRole(O.id, "trusted_reporter", "admin", tick());
  await expectReject("없는 권한은 거둘 수 없다", () => sub.revokeMemberRole(O.id, "trusted_reporter", "admin", tick()), "그 권한이 없습니다");
  const afterRevoke = await sub.submitMatchCorrection(O.token, { request_id: rid(), match_id: "SB:2", payload: kills(1, "assists", 4) }, tick());
  const roleLog = await listMemberRoles(O.id);
  check("거두면 다음 제보부터 확인 전 — 이미 검증된 것은 그때의 기준대로 남는다 · 주고 거둔 기록은 지우지 않는다",
    changedOnRevoke === 0 && afterRevoke.kind === "applied" && (await stateOfSub(direct.id)).state === "verified"
      && roleLog.length === 1 && roleLog[0].revoked_by === "admin" && roleLog[0].granted_by === "admin");

  policyWith({ consensusMembers: 2 });
  const P1 = await join("sb-agree1", "합의하나"), P2 = await join("sb-agree2", "합의둘");
  const agreed = await sub.submitMatchCorrection(P1.token, { request_id: rid(), match_id: "SB:4", payload: kills(1, "kills", 6) }, tick());
  const beforeAgree = (await stateOfSub(agreed.id)).state;
  // 반영된 제보에 같은 값을 다시 보내면 "이미 그 값"이다 — 같은 내용 표시는 +1 버튼 하나.
  await sub.supportSubmission(P2.token, agreed.id, tick());
  check("★ 합의(N=2)를 켜면 — 혼자일 땐 확인 전, 다른 회원이 같은 내용이에요(+1)를 눌러 N명이 되는 순간 검증",
    agreed.kind === "applied" && beforeAgree === "applied"
      && (await stateOfSub(agreed.id)).state === "verified" && (await stateOfSub(agreed.id)).rule_id === "consensus" && !(await pend("SB:4")),
    JSON.stringify(await stateOfSub(agreed.id)));

  sub.setSubmissionPolicyForVerify(null);
  check("기준을 되돌리고 다시 판정해도 닫힌 제보는 그대로 — 열린 것 중 바뀌는 것 없음", (await sub.reconsiderOpenSubmissions()) === 0
    && (await stateOfSub(afterRevoke.id)).rule_id === "apply_pending");

  // ── 5. 회원 화면 · 탈퇴 ───────────────────────────────────────────────────
  const mine = await sub.listMySubmissions(W.token);
  const open = await sub.listOpenSubmissions(O.token, "match_correction", "SB:4");
  check("내 제보 목록은 내 것만 · 판의 열린 제보는 보낸 사람·메모 없이", mine.length >= 5 && mine.every((m) => m.state)
    && open.length === 1 && !("note" in open[0]) && !("author" in open[0]), JSON.stringify(open));
  check("남의 제보는 내 화면에서 열 수 없다", (await sub.getMySubmission(O.token, s1.id)) === null && (await sub.getMySubmission(W.token, s1.id))?.id === s1.id);
  await member.withdrawMember(W.token, { deleteContent: true }, tick());
  const [gone] = await sql<{ author_id: string | null; note: string | null; evidence_url: string | null }[]>`SELECT author_id, note, evidence_url FROM submission WHERE id = ${s1.id}::uuid`;
  check("탈퇴 — 메모·근거·보낸 사람 연결은 지우고, 반영된 값과 이력은 남는다", gone.author_id === null && gone.note === null && gone.evidence_url === null
    && (await winner("SB:1")) === 200 && (await sql`SELECT 1 FROM review_change WHERE submission_id = ${s1.id}::uuid`).length > 0);
}
