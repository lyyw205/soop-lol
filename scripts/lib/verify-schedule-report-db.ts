/**
 * 편성표 제보(0094) — docs/USER-SUBMISSION-PLAN.md §12 를 실제 함수로 돌려 본다. verify-db.ts 가 부른다.
 *
 *   · 언제나 보류(schedule_review) — 편성표는 그대로 · 새 일정은 근거 링크 필수 · 고치기는 칸이나 메모
 *   · 중복 막기 — 같은 요청 · 같은 지문(+1) · 이미 그 값 · 하루 한도는 경기 제보와 같이 센다
 *   · 반영은 saveScheduleEntry 하나 — 저장과 같은 트랜잭션에서 확인 완료, 저장이 실패하면 제보도 열린 채
 *   · 반영 없이 확인 · 반려 · 비공개(열린 제보에 보낸 사람·메모 없음) · 탈퇴
 */
import { db } from "../../packages/core/lib/db/client.ts";
import * as member from "../../packages/core/lib/db/member.ts";
import * as schedule from "../../packages/core/lib/db/schedule.ts";
import * as sub from "../../packages/core/lib/db/submission.ts";
import { SUBMISSION_DAILY_LIMIT } from "../../packages/core/lib/metrics/submission.ts";

type Check = (name: string, ok: boolean, detail?: string) => void;
type ExpectReject = (name: string, fn: () => Promise<unknown>, expected: string) => Promise<void>;

export async function verifyScheduleReportDb(check: Check, expectReject: ExpectReject): Promise<void> {
  console.log("\n▸ 편성표 제보 — 보류 접수·중복·반영은 편성표 저장 하나 (0094)");
  const sql = db();
  const rid = () => crypto.randomUUID();
  const kst = (s: string) => new Date(`${s}:00+09:00`);
  const [host] = await sql<{ id: string }[]>`INSERT INTO streamer (slug, display_name) VALUES ('srp-host', '편제주최') RETURNING id`;
  const [guest] = await sql<{ id: string }[]>`INSERT INTO streamer (slug, display_name) VALUES ('srp-guest', '편제손님') RETURNING id`;
  const input = () => ({
    game_code: "lol" as const, title: "편제 CK", planned_format: "ck" as const, sponsor: null, description: null, admin_note: null,
    status: "scheduled" as const, event_id: null, visibility: "public" as const,
    slots: [{ label: null, on_date: "2031-06-01", starts_at: kst("2031-06-01T20:00"), ends_at: null, channel_id: null }],
    participants: [{ streamer_id: host.id, role: "host" as const, team: null }],
    sources: [{ url: "https://ch.sooplive.co.kr/srp/post/1", title: "공지", posted_at: null }],
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
  const version = async () => (await sql<{ v: string }[]>`SELECT updated_at::text AS v FROM schedule_entry WHERE id = ${entry.id}::uuid`)[0].v;
  const state = async (id: string) => (await sql<{ state: string; schedule_entry_id: string | null; decided_by: string | null }[]>`
    SELECT state, schedule_entry_id, decided_by FROM submission WHERE id = ${id}::uuid`)[0];
  const before = await version();

  // ── 접수 — 언제나 보류, 편성표는 그대로 ──────────────────────────────────────
  const cancel = { type: "correction", status: "cancelled" };
  const reqId = rid();
  const c1 = await sub.submitScheduleReport(P.token, { request_id: reqId, entry_id: entry.id, payload: cancel, note: "공지에 <b>취소</b>" });
  check("고치기는 보류(schedule_review)로 받고 편성표는 그대로다", c1.kind === "held" && (c1 as { hold_reason: string }).hold_reason === "schedule_review"
    && (await version()) === before && (await sql`SELECT status FROM schedule_entry WHERE id = ${entry.id}::uuid`)[0].status === "scheduled");
  const again = await sub.submitScheduleReport(P.token, { request_id: reqId, entry_id: entry.id, payload: cancel });
  check("같은 요청은 같은 제보를 돌려준다(두 번 누르기)", again.kind === "repeat" && again.id === c1.id);
  const plus = await sub.submitScheduleReport(Q.token, { request_id: rid(), entry_id: entry.id, payload: cancel });
  check("다른 회원의 같은 제보는 +1 로 합친다", plus.kind === "supported" && plus.id === c1.id
    && (await sql`SELECT count(*)::int n FROM submission_supporter WHERE submission_id = ${c1.id}::uuid`)[0].n === 1);
  await expectReject("지금 일정과 같은 값뿐이면 받지 않는다", () => sub.submitScheduleReport(P.token, {
    request_id: rid(), entry_id: entry.id, payload: { type: "correction", title: "편제 CK", on_date: "2031-06-01", start: "20:00" } }), "이미 그 값");
  await expectReject("고칠 칸도 메모도 없으면 받지 않는다", () => sub.submitScheduleReport(P.token, {
    request_id: rid(), entry_id: entry.id, payload: { type: "correction" } }), "고칠 내용이나 메모");
  const noteOnly = await sub.submitScheduleReport(P.token, { request_id: rid(), entry_id: entry.id, payload: { type: "correction" }, note: "중계 채널이 바뀌었어요" });
  check("메모만 있는 고치기도 받는다(칸으로 못 쓰는 내용)", noteOnly.kind === "held");
  const sameTime = await sub.submitScheduleReport(P.token, { request_id: rid(), entry_id: entry.id,
    payload: { type: "correction", title: "편제 CK", on_date: "2031-06-02", start: "21:00", participants: "편제주최, 편제손님, 모르는사람, 편제손님" } });
  const [stored] = await sql<{ payload: Record<string, unknown> }[]>`SELECT payload FROM submission WHERE id = ${sameTime.id}::uuid`;
  check("이미 그 값인 칸(제목)은 지우고 나머지를 정규화해 남긴다(참가자 중복·공백 정리)",
    !("title" in stored.payload) && stored.payload.on_date === "2031-06-02" && stored.payload.start === "21:00"
      && stored.payload.participants === "편제주최, 편제손님, 모르는사람", JSON.stringify(stored.payload));

  await expectReject("새 일정은 근거 링크가 있어야 한다", () => sub.submitScheduleReport(P.token, {
    request_id: rid(), entry_id: null, payload: { type: "new", game_code: "lol", title: "새 대회", on_date: "2031-06-10" } }), "근거 링크");
  await expectReject("새 일정은 게임·제목·날짜가 있어야 한다", () => sub.submitScheduleReport(P.token, {
    request_id: rid(), entry_id: null, payload: { type: "new", game_code: "lol", title: "새 대회" }, evidence_url: "https://x.example/1" }), "날짜");
  await expectReject("없는 날짜는 받지 않는다", () => sub.submitScheduleReport(P.token, {
    request_id: rid(), entry_id: null, payload: { type: "new", game_code: "lol", title: "새 대회", on_date: "2031-02-30" }, evidence_url: "https://x.example/1" }), "없는 날짜");
  await expectReject("로그인하지 않으면 받지 않는다", () => sub.submitScheduleReport(null, {
    request_id: rid(), entry_id: entry.id, payload: cancel }), "로그인");
  const fresh = { type: "new", game_code: "lol", title: "편제 새 대회", on_date: "2031-06-10", start: "19:00", participants: "편제손님" };
  const n1 = await sub.submitScheduleReport(P.token, { request_id: rid(), entry_id: null, payload: fresh, evidence_url: "https://x.example/notice" });
  const n2 = await sub.submitScheduleReport(Q.token, { request_id: rid(), entry_id: null, payload: { ...fresh, title: " 편제  새 대회 " }, evidence_url: "https://x.example/other" });
  check("새 일정 알리기 — 보류로 받고, 같은 내용(공백만 다른 제목)은 +1", n1.kind === "held" && n2.kind === "supported" && n2.id === n1.id);
  const open = await sub.listOpenOnSchedule(Q.token, entry.id);
  check("일정의 열린 제보는 보낸 사람·메모·근거 없이, +1 한 회원에게는 mine",
    open.length === 3 && open.every((o) => !("note" in o) && !("author" in o)) && open.find((o) => o.id === c1.id)?.mine === true, JSON.stringify(open));

  // ── 한도 — 경기 제보와 같은 하루 한도를 같이 센다 ──────────────────────────────
  for (let i = 0; i < SUBMISSION_DAILY_LIMIT; i++) {
    await sub.submitScheduleReport(L.token, { request_id: rid(), entry_id: entry.id, payload: { type: "correction" }, note: `한도 ${i}` });
  }
  await expectReject("하루 한도를 넘으면 받지 않는다", () => sub.submitScheduleReport(L.token, {
    request_id: rid(), entry_id: entry.id, payload: { type: "correction" }, note: "한도 넘음" }), `${SUBMISSION_DAILY_LIMIT}건`);

  // ── 반영 — 편성표 저장 하나, 같은 트랜잭션에서 닫힌다 ───────────────────────────
  await expectReject("저장이 실패하면(그 사이 바뀐 일정) 제보도 열린 채다", () => schedule.saveScheduleEntry({ ...input(), status: "cancelled" },
    { id: entry.id, version: "1999-01-01", submission: { id: c1.id, actor: "owner-1" } }), "다른 수정이 먼저");
  check("…실패 뒤 제보는 여전히 보류", (await state(c1.id)).state === "held");
  const v1 = await version();
  await schedule.saveScheduleEntry({ ...input(), status: "cancelled" }, { id: entry.id, version: v1, submission: { id: c1.id, actor: "owner-1" } });
  const closed = await state(c1.id);
  check("★ 운영자 저장 = 편성표 반영 + 제보 확인 완료(작업자 기록)", closed.state === "verified" && closed.decided_by === "owner-1"
    && (await sql`SELECT status FROM schedule_entry WHERE id = ${entry.id}::uuid`)[0].status === "cancelled");
  const v2 = await version();
  await expectReject("닫힌 제보로 또 저장하면 저장 전체가 거부된다", () => schedule.saveScheduleEntry({ ...input(), title: "다시" },
    { id: entry.id, version: v2, submission: { id: c1.id, actor: "owner-1" } }), "이미 처리된");
  check("…그 저장은 편성표를 바꾸지 않았다", (await version()) === v2);
  const other = await schedule.saveScheduleEntry({ ...input(), title: "다른 일정" });
  await expectReject("다른 일정에 대한 제보로는 저장할 수 없다", () => schedule.saveScheduleEntry({ ...input(), title: "다른 일정 2" },
    { id: other.id, version: other.version, submission: { id: sameTime.id, actor: "owner-1" } }), "제보한 일정과 저장한 일정이 다릅니다");
  const made = await schedule.saveScheduleEntry({ ...input(), title: "편제 새 대회", sources: [{ url: "https://x.example/notice", title: "회원 제보 근거", posted_at: null }] },
    { submission: { id: n1.id, actor: "owner-1" } });
  const newClosed = await state(n1.id);
  check("새 일정 반영 — 만든 일정이 제보의 대상으로 적힌다", newClosed.state === "verified" && newClosed.schedule_entry_id === made.id);

  // ── 반영 없이 확인 · 반려 · 탈퇴 ─────────────────────────────────────────────
  await sub.verifySubmission(noteOnly.id, "owner-1", "이미 고쳤습니다");
  await sub.rejectSubmission(sameTime.id, "owner-1", "공지와 다릅니다");
  check("반영 없이 확인 · 반려 — 편성표는 그대로", (await state(noteOnly.id)).state === "verified" && (await state(sameTime.id)).state === "rejected"
    && (await sql`SELECT count(*)::int n FROM schedule_slot WHERE entry_id = ${entry.id}::uuid AND on_date = '2031-06-02'`)[0].n === 0);
  const mine = await sub.listMySubmissions(P.token);
  check("내 제보에 편성표 제보가 대상 일정과 함께 보인다", mine.some((m) => m.kind === "schedule_report" && m.schedule_entry_id === entry.id && m.state === "verified"));
  const queue = await sub.listSubmissionQueue();
  check("운영자 대기열에 일정 제목과 함께 온다", queue.some((q) => q.kind === "schedule_report" && q.schedule_title === "편제 CK"));
  await member.withdrawMember(P.token, { deleteContent: true });
  const [gone] = await sql<{ author_id: string | null; note: string | null }[]>`SELECT author_id, note FROM submission WHERE id = ${c1.id}::uuid`;
  check("탈퇴 — 메모·보낸 사람 연결은 지우고 반영된 편성표는 남는다", gone.author_id === null && gone.note === null
    && (await sql`SELECT status FROM schedule_entry WHERE id = ${entry.id}::uuid`)[0].status === "cancelled");
}
