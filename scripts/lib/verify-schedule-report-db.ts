/**
 * 편성표 제보(0094 · 0100 바로 반영) — docs/USER-SUBMISSION-PLAN.md §12 · SUBMISSION-POLICY-PLAN.md §11 을 실제 함수로 돌려 본다. verify-db.ts 가 부른다.
 *
 *   · 바로 반영 + 확인 전(2026-10-18 사용자 결정) — 편성표 쓰기 하나(saveScheduleEntryInTx), 되돌리기 원본은 submission_schedule_effect
 *   · 같은 일정의 열린 제보가 있으면(다툼)·방송 칸이 여럿인 일정의 날짜면 운영자 대기 — 보류는 편성표 편집 저장(applyScheduleReport)으로 반영
 *   · 반려 = 되돌리기(고친 일정은 고치기 전으로, 만든 일정은 숨김) — 그 뒤 또 바뀌었으면 거부 · 확인 = 표시 떼기
 *   · 중복 막기(같은 요청·같은 지문 +1·이미 그 값)·하루 한도·새 일정은 근거 링크·숨긴 일정은 대상이 아님·탈퇴
 */
import { db } from "../../packages/core/lib/db/client.ts";
import * as member from "../../packages/core/lib/db/member.ts";
import * as schedule from "../../packages/core/lib/db/schedule.ts";
import { getPublicScheduleEntry } from "../../packages/core/lib/db/schedule-public.ts";
import * as sub from "../../packages/core/lib/db/submission.ts";
import { SUBMISSION_DAILY_LIMIT } from "../../packages/core/lib/metrics/submission.ts";

type Check = (name: string, ok: boolean, detail?: string) => void;
type ExpectReject = (name: string, fn: () => Promise<unknown>, expected: string) => Promise<void>;

export async function verifyScheduleReportDb(check: Check, expectReject: ExpectReject): Promise<void> {
  console.log("\n▸ 편성표 제보 — 바로 반영·확인 전·되돌리기, 다툼·여러 칸은 운영자 (0094·0100)");
  const sql = db();
  const rid = () => crypto.randomUUID();
  const kst = (s: string) => new Date(`${s}:00+09:00`);
  const [host] = await sql<{ id: string }[]>`INSERT INTO streamer (slug, display_name) VALUES ('srp-host', '편제주최') RETURNING id`;
  await sql`INSERT INTO streamer (slug, display_name) VALUES ('srp-guest', '편제손님')`;
  const input = (over: Record<string, unknown> = {}) => ({
    game_code: "lol" as const, title: "편제 CK", planned_format: "ck" as const, sponsor: null, description: null, admin_note: "운영 메모",
    status: "scheduled" as const, event_id: null, visibility: "public" as const,
    slots: [{ label: null, on_date: "2031-06-01", starts_at: kst("2031-06-01T20:00"), ends_at: kst("2031-06-01T23:00"), channel_id: null }],
    participants: [{ streamer_id: host.id, role: "host" as const, team: null }],
    sources: [{ url: "https://ch.sooplive.co.kr/srp/post/1", title: "공지", posted_at: null }],
    ...over,
  });
  const entry = await schedule.saveScheduleEntry(input());
  const join = async (subj: string, nickname: string) => {
    const r = await member.loginWithIdentity("kakao", subj);
    if (r.kind !== "ok") throw new Error("가입 실패");
    const { token } = await member.createSession(r.memberId);
    await member.setNickname(token, nickname, { agreed: true });
    return { id: r.memberId, token };
  };
  const P = await join("srp-writer", "편제작성"), Q = await join("srp-other", "편제동의"), L = await join("srp-limit", "편제한도");
  const row = async (id: string) => (await sql<{ status: string; title: string; visibility: string; v: string }[]>`
    SELECT status, title, visibility, updated_at::text AS v FROM schedule_entry WHERE id = ${id}::uuid`)[0];
  const state = async (id: string) => (await sql<{ state: string; schedule_entry_id: string | null; decided_by: string | null; rule_id: string; hold_reason: string | null }[]>`
    SELECT state, schedule_entry_id, decided_by, rule_id, hold_reason FROM submission WHERE id = ${id}::uuid`)[0];
  const pending = async (id: string) => (await sql`SELECT 1 FROM core_public.pending_schedule WHERE schedule_id = ${id}::uuid`).length > 0;
  const before = await row(entry.id);

  // ── 접수 = 바로 반영 + 확인 전 ────────────────────────────────────────────
  const cancel = { type: "correction", status: "cancelled" };
  const reqId = rid();
  const c1 = await sub.submitScheduleReport(P.token, { request_id: reqId, entry_id: entry.id, payload: cancel, note: "공지에 <b>취소</b>", evidence_url: "https://x.example/cancel" });
  const pub = await getPublicScheduleEntry(entry.id);
  const [eff] = await sql<{ kind: string; before: { status: string; admin_note: string } }[]>`SELECT kind, before FROM submission_schedule_effect WHERE submission_id = ${c1.id}::uuid`;
  check("★ 편성표 제보는 바로 반영된다 — 일정이 취소로 바뀌고(출처에 근거 링크) 공개 편성표에 '확인 전'(pending)",
    c1.kind === "applied" && (await state(c1.id)).rule_id === "schedule_apply" && (await row(entry.id)).status === "cancelled"
      && pub?.pending === true && pub.status === "cancelled" && pub.sources.some((x) => x.url === "https://x.example/cancel") && (await pending(entry.id)),
    JSON.stringify({ c1, pub: pub && { status: pub.status, pending: pub.pending } }));
  check("되돌리기 원본 — 고치기 전 저장 입력(운영 메모까지)", eff?.kind === "changed" && eff.before.status === "scheduled" && eff.before.admin_note === "운영 메모");
  const again = await sub.submitScheduleReport(P.token, { request_id: reqId, entry_id: entry.id, payload: cancel });
  check("같은 요청은 같은 제보를 돌려준다(두 번 누르기)", again.kind === "repeat" && again.id === c1.id);
  await expectReject("이미 그 값(지금 취소된 일정을 또 취소)이면 받지 않는다", () => sub.submitScheduleReport(Q.token, {
    request_id: rid(), entry_id: entry.id, payload: cancel }), "이미 그 값");
  await sub.supportSubmission(Q.token, c1.id);
  check("다른 회원은 +1 로 동의한다", (await sql`SELECT count(*)::int n FROM submission_supporter WHERE submission_id = ${c1.id}::uuid`)[0].n === 1);
  await expectReject("고칠 칸도 메모도 없으면 받지 않는다", () => sub.submitScheduleReport(P.token, {
    request_id: rid(), entry_id: entry.id, payload: { type: "correction" } }), "고칠 내용이나 메모");

  // ── 다툼 — 같은 일정의 열린 제보가 이미 있으면 운영자 대기, 편성표는 그대로 ─────────────────
  const vBefore = (await row(entry.id)).v;
  const sameTime = await sub.submitScheduleReport(P.token, { request_id: rid(), entry_id: entry.id,
    payload: { type: "correction", title: "편제 CK", on_date: "2031-06-02", start: "21:00", participants: "편제주최, 편제손님, 모르는사람, 편제손님" } });
  const [stored] = await sql<{ payload: Record<string, unknown> }[]>`SELECT payload FROM submission WHERE id = ${sameTime.id}::uuid`;
  check("★ 같은 일정에 확인 전 제보가 있으면 다툼 — 운영자 대기, 편성표는 그대로", sameTime.kind === "held" && (await state(sameTime.id)).rule_id === "schedule_contested"
    && (await row(entry.id)).v === vBefore);
  check("이미 그 값인 칸(제목)은 지우고 나머지를 정규화해 남긴다(참가자 중복·공백 정리)",
    !("title" in stored.payload) && stored.payload.on_date === "2031-06-02" && stored.payload.start === "21:00"
      && stored.payload.participants === "편제주최, 편제손님, 모르는사람", JSON.stringify(stored.payload));
  const noteOnly = await sub.submitScheduleReport(Q.token, { request_id: rid(), entry_id: entry.id, payload: { type: "correction" }, note: "중계 채널이 바뀌었어요" });
  check("메모만 있는 고치기도 받는다(칸으로 못 쓰는 내용) — 다툼이라 운영자 대기", noteOnly.kind === "held");

  // ── 새 일정 알리기 = 바로 공개 + 확인 전 ────────────────────────────────────
  await expectReject("새 일정은 근거 링크가 있어야 한다", () => sub.submitScheduleReport(P.token, {
    request_id: rid(), entry_id: null, payload: { type: "new", game_code: "lol", title: "새 대회", on_date: "2031-06-10" } }), "근거 링크");
  await expectReject("새 일정은 게임·제목·날짜가 있어야 한다", () => sub.submitScheduleReport(P.token, {
    request_id: rid(), entry_id: null, payload: { type: "new", game_code: "lol", title: "새 대회" }, evidence_url: "https://x.example/1" }), "날짜");
  await expectReject("없는 날짜는 받지 않는다", () => sub.submitScheduleReport(P.token, {
    request_id: rid(), entry_id: null, payload: { type: "new", game_code: "lol", title: "새 대회", on_date: "2031-02-30" }, evidence_url: "https://x.example/1" }), "없는 날짜");
  await expectReject("로그인하지 않으면 받지 않는다", () => sub.submitScheduleReport(null, {
    request_id: rid(), entry_id: entry.id, payload: cancel }), "로그인");
  const fresh = { type: "new", game_code: "lol", title: "편제 새 대회", on_date: "2031-06-10", start: "19:00", participants: "편제손님, 모르는사람" };
  const n1 = await sub.submitScheduleReport(P.token, { request_id: rid(), entry_id: null, payload: fresh, evidence_url: "https://x.example/notice" });
  const n2 = await sub.submitScheduleReport(Q.token, { request_id: rid(), entry_id: null, payload: { ...fresh, title: " 편제  새 대회 " }, evidence_url: "https://x.example/other" });
  const madeId = (await state(n1.id)).schedule_entry_id!;
  const made = await getPublicScheduleEntry(madeId);
  check("★ 새 일정 알리기 — 바로 공개(미분류·예정, 이름이 맞은 사람만 선수, 근거가 출처) + 확인 전, 같은 내용은 +1",
    n1.kind === "applied" && made?.pending === true && made.title === "편제 새 대회" && made.planned_format === "unclassified"
      && made.participants.map((p) => `${p.slug}:${p.role}`).join() === "srp-guest:player" && made.sources[0]?.url === "https://x.example/notice"
      && n2.kind === "supported" && n2.id === n1.id, JSON.stringify(made));
  const open = await sub.listOpenSubmissions(Q.token, "schedule_report", entry.id);
  check("일정의 열린 제보는 보낸 사람·메모·근거 없이, 내 것은 mine",
    open.length === 3 && open.every((o) => !("note" in o) && !("author" in o)) && open.find((o) => o.id === noteOnly.id)?.mine === true, JSON.stringify(open));

  // ── 한도 — 경기 제보와 같은 하루 한도를 같이 센다 ──────────────────────────────
  for (let i = 0; i < SUBMISSION_DAILY_LIMIT; i++) {
    await sub.submitScheduleReport(L.token, { request_id: rid(), entry_id: entry.id, payload: { type: "correction" }, note: `한도 ${i}` });
  }
  await expectReject("하루 한도를 넘으면 받지 않는다", () => sub.submitScheduleReport(L.token, {
    request_id: rid(), entry_id: entry.id, payload: { type: "correction" }, note: "한도 넘음" }), `${SUBMISSION_DAILY_LIMIT}건`);

  // ── 반려 = 되돌리기 · 확인 = 표시 떼기 ─────────────────────────────────────
  await sub.rejectSubmission(c1.id, "owner-1", "공지가 아직 없습니다");
  const back = await row(entry.id);
  check("★ 반려하면 고치기 전 값으로 되돌린다(상태·출처·운영 메모) · 확인 전 표시도 사라진다", (await state(c1.id)).state === "reverted"
    && back.status === "scheduled" && back.title === before.title && !(await pending(entry.id))
    && (await sql`SELECT 1 FROM schedule_source WHERE entry_id = ${entry.id}::uuid AND url = 'https://x.example/cancel'`).length === 0
    && (await sql`SELECT admin_note FROM schedule_entry WHERE id = ${entry.id}::uuid`)[0].admin_note === "운영 메모");
  const e2 = await schedule.saveScheduleEntry(input({ title: "편제 둘" }));
  const r2 = await sub.submitScheduleReport(Q.token, { request_id: rid(), entry_id: e2.id, payload: { type: "correction", title: "편제 둘(바뀜)" } });
  const cur2 = await schedule.getScheduleForAdmin(e2.id);
  await schedule.saveScheduleEntry({ ...cur2!.input, title: "운영자가 또 고침" }, { id: e2.id, version: cur2!.version });
  await expectReject("★ 제보 뒤에 일정이 또 바뀌었으면 되돌리지 않는다(덮지 않는다)", () => sub.rejectSubmission(r2.id, "owner-1"), "또 바뀌어 되돌릴 수 없습니다");
  check("…되돌리기가 거부되면 아무것도 안 바뀐다 — 운영자 값 그대로, 제보는 열린 채", (await row(e2.id)).title === "운영자가 또 고침" && (await state(r2.id)).state === "applied");
  await sub.verifySubmission(n1.id, "owner-1", "공지 확인");
  check("확인 = 표시 떼기 — 새 일정은 그대로 공개, 확인 전 표시가 사라진다", (await state(n1.id)).state === "verified"
    && (await getPublicScheduleEntry(madeId))?.pending === false);
  const n3 = await sub.submitScheduleReport(P.token, { request_id: rid(), entry_id: null,
    payload: { type: "new", game_code: "lol", title: "장난 일정", on_date: "2031-06-11" }, evidence_url: "https://x.example/fake" });
  const fakeId = (await state(n3.id)).schedule_entry_id!;
  await sub.rejectSubmission(n3.id, "owner-1", "없는 일정");
  check("만든 일정을 반려하면 숨긴다(공개 편성표에서 빠진다)", (await row(fakeId)).visibility === "hidden" && (await getPublicScheduleEntry(fakeId)) === null);

  // ── 보류의 반영 — 편성표 편집 저장 + 제보 닫기를 한 트랜잭션에서 ─────────────────────
  const moved = { label: null, on_date: "2031-06-02", starts_at: kst("2031-06-02T21:00"), ends_at: null, channel_id: null };
  const v1 = (await row(entry.id)).v;
  await expectReject("저장이 실패하면(그 사이 바뀐 일정) 제보도 열린 채다", () => sub.applyScheduleReport(sameTime.id, "owner-1",
    input({ slots: [moved] }), { id: entry.id, version: "1999-01-01" }), "다른 수정이 먼저");
  check("…실패 뒤 제보는 여전히 보류", (await state(sameTime.id)).state === "held");
  await sub.applyScheduleReport(sameTime.id, "owner-1", input({ slots: [moved] }), { id: entry.id, version: v1 });
  const closed = await state(sameTime.id);
  const [ruled] = await sql<{ rule_id: string; admin_decision: string; decision_note: string }[]>`SELECT rule_id, admin_decision, decision_note FROM submission WHERE id = ${sameTime.id}::uuid`;
  check("★ 보류는 운영자 편성표 저장 = 반영 + 확인 완료(admin_verify, 흔적 admin — 다시 쓰지 않는다)", closed.state === "verified" && closed.decided_by === "owner-1"
    && ruled.rule_id === "admin_verify" && ruled.decision_note === "편성표에 반영" && !(await pending(entry.id))
    && (await sql`SELECT kind FROM submission_schedule_effect WHERE submission_id = ${sameTime.id}::uuid`)[0]?.kind === "admin"
    && (await sql`SELECT count(*)::int n FROM schedule_slot WHERE entry_id = ${entry.id}::uuid AND on_date = '2031-06-02'`)[0].n === 1, JSON.stringify(ruled));
  const v2 = (await row(entry.id)).v;
  await expectReject("닫힌 제보로 또 저장하면 저장 전체가 거부된다", () => sub.applyScheduleReport(sameTime.id, "owner-1", input({ title: "다시" }),
    { id: entry.id, version: v2 }), "이미 처리된");
  check("…그 저장은 편성표를 바꾸지 않았다", (await row(entry.id)).v === v2);
  const other = await schedule.saveScheduleEntry(input({ title: "다른 일정" }));
  await expectReject("다른 일정에 대한 제보로는 저장할 수 없다", () => sub.applyScheduleReport(noteOnly.id, "owner-1", input({ title: "다른 일정 2" }),
    { id: other.id, version: other.version }), "제보한 일정과 저장한 일정이 다릅니다");
  check("…거부된 저장은 그 일정을 바꾸지 않았다(저장과 닫기가 한 트랜잭션)", (await row(other.id)).title === "다른 일정");

  // ── 방송 칸이 여럿인 일정의 날짜 — 운영자 대기, 확인 버튼으로는 자동 반영하지 않는다 ─────────────────
  const multi = await schedule.saveScheduleEntry(input({ title: "편제 이틀", slots: [
    { label: "1일차", on_date: "2031-06-20", starts_at: kst("2031-06-20T20:00"), ends_at: null, channel_id: null },
    { label: "2일차", on_date: "2031-06-21", starts_at: kst("2031-06-21T20:00"), ends_at: null, channel_id: null }] }));
  const m1 = await sub.submitScheduleReport(Q.token, { request_id: rid(), entry_id: multi.id, payload: { type: "correction", on_date: "2031-06-22" } });
  check("방송 칸이 여럿인 일정의 날짜는 운영자 대기(어느 칸인지 모른다)", m1.kind === "held" && (await state(m1.id)).rule_id === "schedule_multi_slot");
  await expectReject("…그 제보는 '확인'으로 자동 반영하지 않는다 — 편성표 편집에서 반영", () => sub.verifySubmission(m1.id, "owner-1"), "방송 칸이 여럿");

  // ── 확인(보류 → 지금 반영) · 내 제보 · 대기열 · 탈퇴 · 숨긴 일정 ─────────────────────
  await sub.verifySubmission(noteOnly.id, "owner-1", "확인");
  check("보류(다툼)였던 메모 제보를 확인하면 지금 반영한다(바뀐 칸이 없으면 일정 그대로)", (await state(noteOnly.id)).state === "verified");
  const mine = await sub.listMySubmissions(P.token);
  check("내 제보에 편성표 제보가 대상 일정과 함께 보인다", mine.some((m) => m.kind === "schedule_report" && m.schedule_entry_id === entry.id && m.state === "reverted"));
  const queue = await sub.listSubmissionQueue();
  check("운영자 대기열에 일정 제목과 함께 온다", queue.some((q) => q.kind === "schedule_report" && q.schedule_title === "편제 이틀"));
  await member.withdrawMember(P.token, { deleteContent: true });
  const [gone] = await sql<{ author_id: string | null; note: string | null }[]>`SELECT author_id, note FROM submission WHERE id = ${c1.id}::uuid`;
  const hidden = await schedule.saveScheduleEntry(input({ title: "숨긴 편성", visibility: "hidden", sources: [] }));
  await expectReject("숨긴 일정은 고치기 제보를 받지 않는다(공개 일정 읽기 하나로 대상을 찾는다)", () => sub.submitScheduleReport(Q.token, {
    request_id: rid(), entry_id: hidden.id, payload: cancel }), "일정을 찾을 수 없습니다");
  check("탈퇴 — 메모·보낸 사람 연결은 지우고 반영된 편성표는 남는다", gone.author_id === null && gone.note === null
    && (await row(madeId)).visibility === "public");
}
