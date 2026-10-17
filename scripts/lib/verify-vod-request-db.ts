/**
 * VOD 판독 요청(0097) — docs/SUBMISSION-POLICY-PLAN.md §6. 웹이 쓰고 이 PC(ck:queue)가 읽는 표를 실제 함수로 돌려 본다.
 *   · 줄은 (VOD, 제보)마다 · 같은 제보 × 같은 VOD 는 한 줄 · 운영자 요청은 VOD 마다 열린 것 하나
 *   · 읽기는 VOD 로 묶는다(우선순위 큰 것·가장 이른 요청·queued 가 하나라도 있으면 queued)
 *   · claim·close 는 VOD 단위로 열린 줄을 함께 옮긴다 · 닫힌 뒤 새 요청은 새 줄
 * 대기열 쪽 판단(다시 열기·닫기)은 순수 함수라 단위 시험(scripts/ck-vod-request.test.ts)이 본다.
 */
import { db } from "../../packages/core/lib/db/client.ts";
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

  const closed = await vr.closeVodRequests(V, "done", "판독 끝", T);
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
}
