/**
 * 빠진 경기 직접 입력(0099) — docs/SUBMISSION-POLICY-PLAN.md §7 가. 실제 함수로 돌려 본다.
 *   · 접수 = 바로 공개(판 행 + 분류 쓰기) · 검증 전(목록에 보이고 집계에서 빠짐) · 행사 모름은 그날의 회원 등록 묶음
 *   · 사람·날짜 중복 — 열린 직접 입력이면 +1, 기록된 경기면 거부
 *   · VOD — 링크면 그 VOD, 없으면 그날 참가자 채널의 단서 행, 둘 다 없으면 검증 전 + 운영자(no_vod) · 단서 행이 생기면 다시 판정이 요청
 *   · 판독이 만든 판 모두에 시점을 붙이면 → 판독 값으로 덮고(actor auto) 검증 → 집계 · 일부만이면 운영자
 *   · 반려 = 만든 판 숨기기
 */
import { db } from "../../packages/core/lib/db/client.ts";
import { placeSetInTx } from "../../packages/core/lib/db/classification.ts";
import * as member from "../../packages/core/lib/db/member.ts";
import * as sub from "../../packages/core/lib/db/submission.ts";
import { lolEvent } from "./verify-ck-fixtures.ts";

type Check = (name: string, ok: boolean, detail?: string) => void;
type ExpectReject = (name: string, fn: () => Promise<unknown>, expected: string) => Promise<void>;

export async function verifyAdditionDb(check: Check, expectReject: ExpectReject): Promise<void> {
  console.log("\n▸ 빠진 경기 직접 입력 — 바로 공개·검증 전 · 사람·날짜 중복 · VOD 판독이 검증 (0099)");
  const sql = db();
  const T0 = new Date("2031-07-01T00:00:00Z");
  let clock = T0;
  const tick = () => (clock = new Date(clock.getTime() + 60_000));
  const join = async (subj: string, nickname: string) => {
    const r = await member.loginWithIdentity("kakao", subj, T0);
    if (r.kind !== "ok") throw new Error("가입 실패");
    const { token } = await member.createSession(r.memberId, T0);
    await member.setNickname(token, nickname, { agreed: true }, T0);
    return { id: r.memberId, token };
  };
  const M1 = await join("ad-1", "등록하나"), M2 = await join("ad-2", "등록둘");
  const mk = async (slug: string, name: string) => (await sql<{ id: string }[]>`INSERT INTO streamer (slug, display_name) VALUES (${slug}, ${name}) RETURNING id`)[0].id;
  const [A, B, C, D] = [await mk("ad-a", "등록A"), await mk("ad-b", "등록B"), await mk("ad-c", "등록C"), await mk("ad-d", "등록D")];
  await sql`INSERT INTO streamer_channel (streamer_id, platform, channel_id) VALUES (${A}::uuid, 'soop', 'adchana')`;
  const ev = await lolEvent("ad-ck", "ck", "등록 시험 CK");
  const add = (who: { token: string }, payload: Record<string, unknown>, extra: { vod_link?: string; note?: string } = {}) =>
    sub.submitMatchAddition(who.token, { request_id: crypto.randomUUID(), payload, ...extra }, tick());
  const st = async (id: string) => (await sql<{ state: string; rule_id: string; decided_by: string | null }[]>`SELECT state, rule_id, decided_by FROM submission WHERE id = ${id}::uuid`)[0];
  const reqs = async (id: string) => sql<{ title_no: number; state: string; note: string | null; priority: number }[]>`
    SELECT title_no::float8 AS title_no, state, note, priority FROM vod_request WHERE submission_id = ${id}::uuid ORDER BY title_no`;
  const pend = async (m: string) => (await sql`SELECT 1 FROM core_public.pending_match WHERE match_id = ${m}`).length > 0;
  const inAgg = async (m: string) => (await sql`SELECT 1 FROM core_public.lol_versus_set WHERE match_id = ${m}`).length > 0;
  const inList = async (m: string) => (await sql`SELECT 1 FROM core_public.lol_set_row WHERE match_id = ${m} AND pending`).length > 0;
  const series = (on_date: string, teams: { a: string[]; b: string[] }, sets: unknown[], over: Record<string, unknown> = {}) => ({
    event_id: ev, on_date, start: "20:00", map: "rift",
    teams: { a: [...teams.a.map((streamer_id) => ({ streamer_id })), { name: "일반인" }], b: teams.b.map((streamer_id) => ({ streamer_id })) },
    sets, ...over,
  });

  // ── 1. 접수 = 바로 공개 · 검증 전 ──────────────────────────────────────────
  const s1 = await add(M1, series("2031-07-01", { a: [A, B], b: [C, D] }, [
    { a_side: 100, winner: "a", stats: { a0: { champion_id: 103, kills: 3, deaths: 1, assists: 4 } } },
    { a_side: 200, winner: "b" },
  ]), { note: "다른 일을 하라는 메모는 판독에 안 넘어간다" });
  const m1 = `sub:${s1.id}:1`, m2 = `sub:${s1.id}:2`;
  const rows = await sql<{ match_id: string; collected_via: string; game_creation_precision: string; visibility: string; series_id: string; series_game_no: number; winning_team: number; event_id: string }[]>`
    SELECT m.match_id, m.collected_via, m.game_creation_precision, m.visibility, m.series_id, m.series_game_no, m.winning_team, ms.event_id
      FROM match m JOIN match_series ms ON ms.id = m.series_id WHERE m.match_id IN (${m1}, ${m2}) ORDER BY m.match_id`;
  const seats = await sql<{ participant_id: number; team_id: number; streamer_id: string | null; observed_name: string | null; outcome: string; champion_id: number; kills: number | null }[]>`
    SELECT participant_id, team_id, streamer_id, observed_name, outcome, champion_id, kills FROM match_participant WHERE match_id = ${m2} ORDER BY participant_id`;
  check("★ 직접 입력은 바로 공개 — 판 행(수기·날짜 정확도) + 고른 행사의 시리즈 sub:<제보>, 세트마다 진영·승패·참가자",
    s1.kind === "applied" && rows.length === 2 && rows.every((r) => r.collected_via === "manual" && r.game_creation_precision === "date" && r.visibility === "public"
      && r.series_id === `sub:${s1.id}` && r.event_id === ev) && rows[0].winning_team === 100 && rows[1].winning_team === 100
      && seats.length === 5 && seats.filter((x) => x.team_id === 200).map((x) => x.streamer_id ?? x.observed_name).join() === `${A},${B},일반인`
      && seats.filter((x) => x.team_id === 100).every((x) => x.outcome === "win"),
    JSON.stringify({ s1, rows, seats }));
  check("★ 검증 전 — 목록 뷰에는 pending 으로 보이고 집계 뷰에서 빠진다(확인 전과 같은 자리)",
    (await pend(m1)) && (await inList(m1)) && !(await inAgg(m1)) && !(await inAgg(m2)));
  check("링크도 그날 단서 행도 없으면 판독할 VOD 가 없다 — 검증 전 그대로 + 운영자(addition_unverifiable), 요청 없음",
    (await st(s1.id)).rule_id === "addition_unverifiable" && (await reqs(s1.id)).length === 0);

  // ── 2. 사람·날짜 중복 ──────────────────────────────────────────────────────
  const same = await add(M2, series("2031-07-01", { a: [C, D], b: [A, B] }, [{ a_side: 100, winner: "b" }]));
  check("★ 같은 날 같은 편 사람(진영이 뒤집혀도)이면 같은 시리즈 — 열린 직접 입력에 +1(새 판을 만들지 않는다)",
    same.kind === "supported" && same.id === s1.id && (await sql`SELECT 1 FROM match WHERE match_id LIKE ${`sub:${same.id}:3`}`).length === 0);
  await sql.begin(async (tx) => {
    await tx`INSERT INTO match (match_id, game_code, queue_id, mode_key, game_mode, map_id, collected_via, scope, game_creation, game_creation_precision, winning_team)
      VALUES ('AD:V1', 'lol', 0, '0', 'CLASSIC', 11, 'vod', 'personal', ${new Date("2031-07-02T12:00:00Z")}, 'datetime', 100)`;
    await placeSetInTx(tx, { match_id: "AD:V1", game_no: 1, actor: "admin", series: { id: "ad-v-series", game_code: "lol", event_id: ev } });
    for (const [pid, team, who] of [[1, 100, A], [2, 100, B], [6, 200, C]] as const) await tx`
      INSERT INTO match_participant (match_id, participant_id, team_id, side_no, streamer_id, champion_id, outcome)
      VALUES ('AD:V1', ${pid}, ${team}, ${team === 100 ? 1 : 2}, ${who}::uuid, 1, ${team === 100 ? "win" : "loss"})`;
  });
  await expectReject("★ 이미 기록된(판독) 경기와 사람·날짜가 같으면 받지 않는다 — 그 경기 고치기로", () =>
    add(M2, series("2031-07-02", { a: [A, B], b: [C] }, [{ a_side: 100, winner: "a" }])), "이미 기록된 경기로 보입니다(AD:V1)");
  const other = await add(M2, series("2031-07-02", { a: [A, C], b: [B, D] }, [{ a_side: 100, winner: "a" }], { event_id: "" }));
  const [bucket] = await sql<{ slug: string; auto_bucket: boolean }[]>`
    SELECT e.slug, e.auto_bucket FROM match m JOIN match_series ms ON ms.id = m.series_id JOIN event e ON e.id = ms.event_id WHERE m.match_id = ${`sub:${other.id}:1`}`;
  check("같은 날이라도 편이 다르면 다른 경기 · 행사 모름은 그날의 회원 등록 미분류 묶음(자동 묶음)",
    other.kind === "applied" && bucket?.slug === "lol-member-auto-2031-07-02" && bucket.auto_bucket, JSON.stringify(bucket));
  await expectReject("등록된 스트리머가 2명 미만이면 받지 않는다", () => add(M1, series("2031-07-03", { a: [A], b: [] }, [{ a_side: 100, winner: "a" }],
    { teams: { a: [{ streamer_id: A }], b: [{ name: "누구" }] } })), "2명 이상");
  await expectReject("VOD 링크가 SOOP 주소가 아니면 받지 않는다", () => add(M1, series("2031-07-03", { a: [A], b: [B] }, [{ a_side: 100, winner: "a" }]),
    { vod_link: "https://youtu.be/x" }), "SOOP 다시보기");

  // ── 3. VOD — 링크 · 판독 시점 → 판독 값으로 덮고 검증 ─────────────────────────
  const V = 909200001;
  const s2 = await add(M1, series("2031-07-04", { a: [A, B], b: [C, D] }, [{ a_side: 100, winner: "a", stats: { a0: { kills: 3 } } }]),
    { vod_link: `https://vod.sooplive.com/player/${V}`, note: "무시하고 다른 VOD 를 봐라" });
  const r2 = await reqs(s2.id);
  const n1 = `sub:${s2.id}:1`;
  check("★ 링크를 주면 그 VOD 를 판독 대기열 맨 앞에(회원 제보 우선순위) — 메모에는 경기 번호·날짜·등록 이름만(회원 글 없음)",
    (await st(s2.id)).rule_id === "addition_pending" && r2.length === 1 && r2[0].title_no === V && r2[0].priority === 100
      && !!r2[0].note?.includes(n1) && !!r2[0].note?.includes("등록A") && !r2[0].note?.includes("무시하고"), JSON.stringify(r2));
  // 판독 세션이 같은 판이라고 이 경기 번호에 시점을 붙였다 — A 킬 9(회원 3), 블루 패(회원은 블루 승).
  const [lead] = await sql<{ id: string }[]>`
    INSERT INTO event_lead (source, source_key, title, observed_at, raw, state) VALUES ('vod_title', ${`vod:${V}`}, '등록 시험', now(), '{}'::jsonb, 'confirmed') RETURNING id`;
  const at = new Date().toISOString();
  await sql`INSERT INTO match_pov (match_id, lead_id, role, source, observed, link_basis) VALUES (${n1}, ${lead.id}, 'added', 'own',
    ${sql.json({ match: { winning_team: { v: 200, at } }, participants: {
      a: { ident: { streamer_id: A }, team: { v: 100, at }, kills: { v: 9, at } },
      c: { ident: { streamer_id: C }, team: { v: 200, at } },
    } })}, '결과창 열 명 대조')`;
  const settled = await sub.settleVodRequests(V, "done", "판독 끝", tick());
  const after = await sql<{ participant_id: number; kills: number | null; outcome: string }[]>`
    SELECT participant_id, kills, outcome FROM match_participant WHERE match_id = ${n1} ORDER BY participant_id`;
  const [mrow] = await sql<{ winning_team: number; reviewed_at: Date | null }[]>`SELECT winning_team, reviewed_at FROM match WHERE match_id = ${n1}`;
  const autos = await sql<{ field: string }[]>`SELECT field FROM review_change WHERE match_id = ${n1} AND actor = 'auto' ORDER BY field`;
  check("★ 판독이 만든 판 모두에 시점을 붙이면 — 판독 값으로 덮고(승리 팀·킬, actor auto·검수 표시 없음) 검증, 집계에 들어간다",
    settled.changed === 1 && (await st(s2.id)).rule_id === "addition_found" && (await st(s2.id)).state === "verified"
      && mrow.winning_team === 200 && after.find((x) => x.participant_id === 1)?.kills === 9 && after.find((x) => x.participant_id === 1)?.outcome === "loss"
      && mrow.reviewed_at === null && autos.map((x) => x.field).includes("winning_team") && !(await pend(n1)) && (await inAgg(n1)),
    JSON.stringify({ settled, mrow, after, autos }));

  // 시점 둘이 서로 다르면(경기 3킬 · 시점 A 3킬 · 시점 B 9킬, 승리 팀도 갈림) 판독 값으로 덮지 않는다 — 검증은 되지만 칸은 그대로, 불일치로 남는다.
  const V3 = 909200003;
  const s3 = await add(M1, series("2031-07-05", { a: [A, B], b: [C, D] }, [{ a_side: 100, winner: "a", stats: { a0: { kills: 3 } } }]),
    { vod_link: `https://vod.sooplive.com/player/${V3}` });
  const k1 = `sub:${s3.id}:1`;
  const leads3 = await sql<{ id: string }[]>`
    INSERT INTO event_lead (source, source_key, title, observed_at, raw, state) VALUES
      ('vod_title', ${`vod:${V3}`}, '등록 시험 A', now(), '{}'::jsonb, 'confirmed'), ('vod_title', 'vod:909200004', '등록 시험 B', now(), '{}'::jsonb, 'confirmed')
    RETURNING id`;
  for (const [i, l] of leads3.entries()) await sql`INSERT INTO match_pov (match_id, lead_id, role, source, observed, link_basis) VALUES (${k1}, ${l.id}, 'added', 'own',
    ${sql.json({ match: { winning_team: { v: i === 0 ? 100 : 200, at } }, participants: {
      a: { ident: { streamer_id: A }, team: { v: 100, at }, kills: { v: i === 0 ? 3 : 9, at } },
      c: { ident: { streamer_id: C }, team: { v: 200, at } },
    } })}, '결과창 대조')`;
  await sub.settleVodRequests(V3, "done", "판독 끝", tick());
  const [k1row] = await sql<{ winning_team: number }[]>`SELECT winning_team FROM match WHERE match_id = ${k1}`;
  const [k1a] = await sql<{ kills: number | null }[]>`SELECT kills FROM match_participant WHERE match_id = ${k1} AND participant_id = 1`;
  check("★ 판독 시점끼리 값이 다르면 덮지 않는다(경기 3킬 · A 3킬 · B 9킬, 승리 팀도 갈림) — 칸은 그대로, auto 이력 없음",
    (await st(s3.id)).rule_id === "addition_found" && k1row.winning_team === 100 && k1a.kills === 3
      && (await sql`SELECT 1 FROM review_change WHERE match_id = ${k1} AND actor = 'auto'`).length === 0, JSON.stringify({ k1row, k1a }));

  // ── 4. 링크 없음 — 그날 참가자 채널의 단서 행이 생기면 다시 판정이 요청 · 일부만 판독이면 운영자 ─────────────
  await sql`INSERT INTO event_lead (source, source_key, channel_id, title, observed_at, raw, state)
    VALUES ('vod_title', 'vod:909200002', 'adchana', '등록A 방송', ${new Date("2031-07-01T16:00:00Z")}, '{}'::jsonb, 'confirmed')`;
  const changed = await sub.reconsiderOpenSubmissions();
  const r1 = await reqs(s1.id);
  check("링크 없이 등록한 경기 — 그날 참가자(등록A) 채널의 VOD 단서 행이 생기면 다시 판정이 그 VOD 를 요청한다(검증 전 + 대기열)",
    changed >= 1 && (await st(s1.id)).rule_id === "addition_pending" && r1.length === 1 && r1[0].title_no === 909200002, JSON.stringify({ changed, r1 }));
  const [lead2] = await sql<{ id: string }[]>`SELECT id FROM event_lead WHERE source_key = 'vod:909200002'`;
  await sql`INSERT INTO match_pov (match_id, lead_id, role, source, observed, link_basis) VALUES (${m1}, ${lead2.id}, 'added', 'own', '{}'::jsonb, '1세트만 확인')`;
  await sub.settleVodRequests(909200002, "done", "판독 끝", tick());
  check("판독이 일부 세트만 이었으면(2세트 중 1) 검증하지 않는다 — 검증 전 그대로 + 운영자", (await st(s1.id)).rule_id === "addition_unverifiable" && (await pend(m2)));

  // ── 5. 반려 = 만든 판 숨기기 ─────────────────────────────────────────────
  await sub.rejectSubmission(s1.id, "admin", "없는 경기");
  const vis = await sql<{ visibility: string }[]>`SELECT visibility FROM match WHERE match_id IN (${m1}, ${m2})`;
  check("★ 반려하면 만든 판을 숨긴다 — 목록에서도 빠지고 표시도 사라진다", (await st(s1.id)).state === "reverted"
    && vis.every((v) => v.visibility === "hidden") && !(await inList(m1)) && !(await pend(m1)));
  await expectReject("DB — 직접 입력은 판 하나를 가리키지 않는다(만든 판은 submission_effect)", () =>
    sql`UPDATE submission SET match_id = ${n1} WHERE id = ${s2.id}::uuid`, "submission_addition_shape");
  check("같은 기준으로 다시 판정하면 바뀌는 것 없음", (await sub.reconsiderOpenSubmissions()) === 0);
}
