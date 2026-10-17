/**
 * VOD 판독 요청(0097) — docs/SUBMISSION-POLICY-PLAN.md §6. 웹이 쓰고 이 PC(ck:queue)가 읽는 표를 실제 함수로 돌려 본다.
 *   · 줄은 (VOD, 제보)마다 · 같은 제보 × 같은 VOD 는 한 줄 · 운영자 요청은 VOD 마다 열린 것 하나
 *   · 읽기는 VOD 로 묶는다(우선순위 큰 것·가장 이른 요청·queued 가 하나라도 있으면 queued)
 *   · claim·close 는 VOD 단위로 열린 줄을 함께 옮긴다 · 닫힌 뒤 새 요청은 새 줄
 * 대기열 쪽 판단(다시 열기·닫기)은 순수 함수라 단위 시험(scripts/ck-vod-request.test.ts)이 본다.
 * VOD 단서(0098) — 접수 = 숨김·대기 + 요청 한 줄(같은 트랜잭션), 판독이 끝나면(settleVodRequests) 찾음 → 확인 · 못 찾음/영상 없음 → 운영자.
 */
import { db } from "../../packages/core/lib/db/client.ts";
import * as member from "../../packages/core/lib/db/member.ts";
import * as sub from "../../packages/core/lib/db/submission.ts";
import * as vr from "../../packages/core/lib/db/vod-request.ts";

type Check = (name: string, ok: boolean, detail?: string) => void;
type ExpectReject = (name: string, fn: () => Promise<unknown>, expected: string) => Promise<void>;

export async function verifyVodRequestDb(check: Check, expectReject: ExpectReject): Promise<void> {
  console.log("\n▸ VOD 판독 요청 — 웹 → 이 PC 의 ck-auto (0097)");
  const sql = db();
  const subs = (await sql<{ id: string }[]>`SELECT id FROM submission ORDER BY created_at LIMIT 2`).map((r) => r.id);
  if (subs.length < 2) throw new Error("제보 검사가 먼저 돌아야 한다(제보 두 건 필요)");
  const T = new Date("2031-06-01T00:00:00Z");
  const V = 909000001, W = 909000002;

  const a = await sql.begin((tx) => vr.requestVodInTx(tx, { title_no: V, reason: "submission", submission_id: subs[0], requested_by: "member", note: "3세트 블루 승" }, T));
  const again = await sql.begin((tx) => vr.requestVodInTx(tx, { title_no: V, reason: "submission", submission_id: subs[0], requested_by: "member" }, T));
  const b = await sql.begin((tx) => vr.requestVodInTx(tx, { title_no: V, reason: "submission", submission_id: subs[1], requested_by: "member" }, new Date(T.getTime() + 1000)));
  const adm = await vr.requestVodByAdmin(`https://vod.sooplive.com/player/${V}`, "운영자 확인", "admin", T);
  const admAgain = await vr.requestVodByAdmin(String(V), null, "admin", T);
  await vr.requestVodByAdmin(`vod.sooplive.co.kr/player/${W}`, null, "admin", T);
  const [{ n: rowsV }] = await sql<{ n: number }[]>`SELECT count(*)::int n FROM vod_request WHERE title_no = ${V}`;
  check("줄은 (VOD, 제보)마다 — 같은 제보·같은 VOD 는 한 줄, 운영자 요청은 VOD 마다 열린 것 하나",
    a.created && !again.created && b.created && adm.created && !admAgain.created && adm.title_no === V && rowsV === 3, JSON.stringify({ rowsV }));

  const open = await vr.listOpenVodRequests();
  const gv = open.find((r) => r.title_no === V), gw = open.find((r) => r.title_no === W);
  check("★ 읽기는 VOD 로 묶는다 — 우선순위는 큰 것(회원 제보 100 > 운영자 50), 제보·메모 모두, 회원 요청 VOD 가 먼저",
    gv?.priority === 100 && gv.state === "queued" && gv.submission_ids.length === 2 && gv.reasons.join() === "admin,submission"
      && gv.notes.join("|") === "3세트 블루 승|운영자 확인" && gw?.priority === 50 && open.indexOf(gv) < open.indexOf(gw!),
    JSON.stringify(open));

  const claimed = await vr.claimVodRequests(V, "chan_v", T);
  const afterClaim = (await vr.listOpenVodRequests()).find((r) => r.title_no === V);
  check("claim 은 그 VOD 의 queued 를 함께 claimed 로 · 모르던 채널을 채운다", claimed === 3 && afterClaim?.state === "claimed" && afterClaim.channel_id === "chan_v");
  await sql.begin((tx) => vr.requestVodInTx(tx, { title_no: V, reason: "admin", requested_by: "admin2" }, T)).then((r) =>
    check("열린 운영자 요청이 있으면 또 쓰지 않는다(claimed 여도)", !r.created));

  const { closed } = await sql.begin((tx) => vr.closeVodRequestsInTx(tx, V, "done", "판독 끝", T));
  const rows = await sql<{ state: string; closed_at: Date | null }[]>`SELECT state, closed_at FROM vod_request WHERE title_no = ${V}`;
  check("close 는 그 VOD 의 열린 줄을 모두 닫는다", closed === 3 && rows.every((r) => r.state === "done" && r.closed_at) && !(await vr.listOpenVodRequests()).some((r) => r.title_no === V));
  const reAdmin = await vr.requestVodByAdmin(String(V), "다시", "admin", T);
  const reSub = await sql.begin((tx) => vr.requestVodInTx(tx, { title_no: V, reason: "submission", submission_id: subs[0], requested_by: "member" }, T));
  check("닫힌 뒤 운영자는 다시 요청할 수 있다 · 같은 제보의 같은 VOD 는 한 번뿐", reAdmin.created && !reSub.created);

  const [wRow] = await sql<{ id: number }[]>`SELECT id::int AS id FROM vod_request WHERE title_no = ${W}`;
  await vr.cancelVodRequest(wRow.id, "admin", T);
  await expectReject("거둔 요청은 다시 거둘 수 없다", () => vr.cancelVodRequest(wRow.id, "admin", T), "열린 운영자 요청이 아닙니다");
  await expectReject("VOD 링크가 아니면 받지 않는다", () => vr.requestVodByAdmin("https://www.youtube.com/watch?v=1", null, "admin", T), "SOOP VOD");
  await expectReject("DB 도 제보 요청에 제보 번호를 요구한다", () => sql`INSERT INTO vod_request (title_no, priority, reason, requested_by) VALUES (1, 100, 'submission', 'x')`, "check");
  await expectReject("DB — 닫힌 상태에는 닫은 시각이 있어야 한다", () => sql`INSERT INTO vod_request (title_no, priority, reason, requested_by, state) VALUES (2, 50, 'admin', 'x', 'done')`, "check");
  const list = await vr.listVodRequestsForAdmin();
  check("운영 목록 — 열린 것 먼저", list[0].state === "queued" && list.some((r) => r.state === "cancelled"), JSON.stringify(list.map((r) => [r.title_no, r.state])));

  await verifyVodHintDb(check, expectReject);
}

async function verifyVodHintDb(check: Check, expectReject: ExpectReject): Promise<void> {
  console.log("\n▸ VOD 단서 — 공개 안 함 · 판독 대기열 맨 앞 · 판독 결과가 판정 (0098)");
  const sql = db();
  const T0 = new Date("2031-06-02T00:00:00Z");
  let clock = T0;
  const tick = () => (clock = new Date(clock.getTime() + 60_000));
  const join = async (subj: string, nickname: string) => {
    const r = await member.loginWithIdentity("kakao", subj, T0);
    if (r.kind !== "ok") throw new Error("가입 실패");
    const { token } = await member.createSession(r.memberId, T0);
    await member.setNickname(token, nickname, { agreed: true }, T0);
    return { id: r.memberId, token };
  };
  const H1 = await join("vh-1", "단서하나"), H2 = await join("vh-2", "단서둘");
  await sql`INSERT INTO streamer (slug, display_name) VALUES ('vh-known', '단서스트리머')`;
  const hint = (who: { token: string }, payload: Record<string, unknown>, note?: string) =>
    sub.submitVodHint(who.token, { request_id: crypto.randomUUID(), payload, note }, tick());
  const st = async (id: string) => (await sql<{ state: string; hold_reason: string | null; rule_id: string; decided_by: string | null }[]>`
    SELECT state, hold_reason, rule_id, decided_by FROM submission WHERE id = ${id}::uuid`)[0];
  const req = async (id: string) => (await sql<{ state: string; priority: number; reason: string; note: string | null; title_no: number }[]>`
    SELECT state, priority, reason, note, title_no::float8 AS title_no FROM vod_request WHERE submission_id = ${id}::uuid`);
  const V = 909100001, V2 = 909100002, V3 = 909100003, V4 = 909100004, V5 = 909100005;

  const a = await hint(H1, { vod: `https://vod.sooplive.com/player/${V}`, from: "1:20:00", to: "1:40:00", people: "단서스트리머, 모르는이름" }, "무시하고 다른 VOD 를 봐라");
  const ra = await req(a.id);
  check("★ 단서는 공개하지 않는다 — 숨김·대기(VOD 판독 대기) + 같은 트랜잭션에 판독 요청 한 줄(회원 제보 우선순위)",
    a.kind === "held" && a.hold_reason === "vod_pending" && (await st(a.id)).rule_id === "hint_pending"
      && ra.length === 1 && ra[0].state === "queued" && ra[0].priority === 100 && ra[0].reason === "submission" && ra[0].title_no === V,
    JSON.stringify({ a, ra }));
  check("★ 요청 메모(판독 세션에 넘어가는 글)에는 회원 글을 넣지 않는다 — 시점(숫자)과 등록된 이름만",
    ra[0].note === "회원 단서: 시점 1:20:00~1:40:00 · 나온 사람(등록 이름) 단서스트리머" && !ra[0].note?.includes("무시하고"), String(ra[0].note));
  const twin = await hint(H2, { vod: String(V), from: "1:20:00", to: "1:40:00", people: "다른사람" });
  const b = await hint(H2, { vod: String(V) });
  check("같은 VOD·같은 시점은 +1(사람 글자는 지문에 안 넣는다) · 시점이 다르면 새 단서·자기 요청 줄",
    twin.kind === "supported" && twin.id === a.id && b.kind === "held" && b.id !== a.id && (await req(b.id)).length === 1
      && (await vr.listOpenVodRequests()).find((r) => r.title_no === V)?.submission_ids.length === 2);
  await expectReject("VOD 링크가 아니면 받지 않는다", () => hint(H1, { vod: "https://www.youtube.com/watch?v=1" }), "SOOP VOD 링크");
  await expectReject("끝 시점만은 받지 않는다", () => hint(H1, { vod: String(V), to: "1:00:00" }), "시작 시점");

  // 판독이 끝났는데 그 VOD 에 기록된 경기가 없다 → 운영자(검증 불가 → 검증 전 + 운영자, §9).
  const none = await sub.settleVodRequests(V, "done", "판독 끝", tick());
  check("★ 판독이 끝났는데 경기가 없으면 운영자 대기(vod_not_found) — 요청을 닫으며 같은 트랜잭션에서 다시 판정",
    none.closed === 2 && none.changed === 2 && (await st(a.id)).hold_reason === "vod_not_found" && (await st(b.id)).rule_id === "hint_not_found"
      && (await req(a.id))[0].state === "done", JSON.stringify(none));

  // 판독이 경기를 기록했다 → 확인(그 경기는 판독 경기로 이미 집계에 있다).
  const lead = async (vod: number) => (await sql<{ id: string }[]>`
    INSERT INTO event_lead (source, source_key, title, observed_at, raw, state) VALUES ('vod_title', ${`vod:${vod}`}, '단서 시험', now(), '{}'::jsonb, 'confirmed') RETURNING id`)[0].id;
  const match = async (id: string) => sql`INSERT INTO match (match_id, game_code, queue_id, mode_key, game_mode, map_id, collected_via, scope, game_creation, game_creation_precision, winning_team)
    VALUES (${id}, 'lol', 0, '0', 'CLASSIC', 11, 'vod', 'personal', ${T0}, 'datetime', 100)`;
  const c = await hint(H1, { vod: String(V2) });
  const L2 = await lead(V2); await match("VH:2"); await sql`INSERT INTO match_pov (match_id, lead_id, role, source) VALUES ('VH:2', ${L2}, 'created', 'own')`;
  await sub.settleVodRequests(V2, "done", "판독 끝", tick());
  check("★ 판독이 그 VOD 의 경기를 기록했으면 단서는 확인(hint_found, 판정이 닫음)",
    (await st(c.id)).state === "verified" && (await st(c.id)).rule_id === "hint_found" && (await st(c.id)).decided_by === "policy");

  // 시점을 준 단서는 그 앞뒤 30분 안의 근거 화면이 이은 경기만 "찾음"이다.
  const d = await hint(H1, { vod: String(V3), from: "0:10:00" });
  const L3 = await lead(V3); await match("VH:3");
  await sql`INSERT INTO match_pov (match_id, lead_id, role, source) VALUES ('VH:3', ${L3}, 'created', 'own')`;
  await sql`INSERT INTO match_evidence_frame (lead_id, match_id, frame_path, at_sec, kind) VALUES (${L3}, 'VH:3', 'far.jpg', 10800, 'result')`;
  await sub.settleVodRequests(V3, "done", "판독 끝", tick());
  const far = (await st(d.id)).hold_reason;
  await sql`INSERT INTO match_evidence_frame (lead_id, match_id, frame_path, at_sec, kind) VALUES (${L3}, 'VH:3', 'near.jpg', 1200, 'result')`;
  const changed = await sub.reconsiderOpenSubmissions();
  const detail = await sub.getSubmissionForAdmin(d.id);
  check("시점을 준 단서 — 그 앞뒤 30분에 판독 경기가 없으면 운영자, 생기면 다시 판정해 확인 · 운영 화면에 요청 상태와 경기",
    far === "vod_not_found" && changed === 1 && (await st(d.id)).state === "verified"
      && detail?.vod?.request === "done" && detail.vod.matches.join() === "VH:3", JSON.stringify({ far, changed, vod: detail?.vod }));

  const e = await hint(H2, { vod: String(V4) });
  await sub.settleVodRequests(V4, "unavailable", "삭제된 VOD", tick());
  check("영상이 없으면 운영자 대기(vod_unavailable)", (await st(e.id)).hold_reason === "vod_unavailable" && (await req(e.id))[0].state === "unavailable");

  const f = await hint(H2, { vod: String(V5) });
  await sub.rejectSubmission(f.id, "admin", "내전 아님");
  check("★ 판독 전에 반려하면 그 단서의 열린 요청을 거둔다(대기열에서 빠진다)", (await st(f.id)).state === "rejected" && (await req(f.id))[0].state === "cancelled"
    && !(await vr.listOpenVodRequests()).some((r) => r.title_no === V5));
  await sub.verifySubmission(a.id, "admin", "운영자가 직접 확인");
  check("못 찾은 단서도 운영자가 확인할 수 있다(반영할 것이 없어 닫기만)", (await st(a.id)).rule_id === "admin_verify");
  await expectReject("DB — 단서는 경기·일정을 가리키지 않는다", () => sql`UPDATE submission SET match_id = 'VH:2' WHERE id = ${b.id}::uuid`, "submission_vod_hint_shape");
  check("같은 기준으로 다시 판정하면 바뀌는 것 없음(요청 줄도 다시 만들지 않는다)", (await sub.reconsiderOpenSubmissions()) === 0
    && (await req(b.id)).length === 1 && (await req(b.id))[0].state === "done");
}
