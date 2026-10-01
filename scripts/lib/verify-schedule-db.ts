/**
 * 편성표 저장 계약·공개 경계를 실제 Postgres(PGlite)에서 확인한다 — verify-db.ts 가 부른다.
 * docs/SCHEDULE-PLAN.md §6 "DB·저장"
 */

type Check = (name: string, ok: boolean, detail?: string) => void;
type ExpectReject = (name: string, fn: () => Promise<unknown>, expected: string) => Promise<void>;

export async function verifyScheduleDb(check: Check, expectReject: ExpectReject): Promise<void> {
  const { db } = await import("../../packages/core/lib/db/client.ts");
  const schedule = await import("../../packages/core/lib/db/schedule.ts");
  const pub = await import("../../packages/core/lib/db/schedule-public.ts");
  const { listPublicTournamentEvents } = await import("../../packages/core/lib/db/public-tournaments.ts");
  const sql = db();

  console.log("\n▸ 편성표 — 저장 계약");
  const kst = (s: string) => new Date(`${s}:00+09:00`);
  const [host] = await sql<{ id: string }[]>`
    INSERT INTO streamer (slug, display_name) VALUES ('sched-host', '편성 주최') RETURNING id`;
  await sql`INSERT INTO streamer_channel (streamer_id, platform, channel_id, is_primary) VALUES (${host.id}, 'soop', 'schedhost', true)`;
  const [hidden] = await sql<{ id: string }[]>`
    INSERT INTO streamer (slug, display_name, visibility) VALUES ('sched-hidden', '숨긴 참가자', 'hidden') RETURNING id`;
  const [lolCk] = await sql<{ id: string }[]>`INSERT INTO event (slug, name, kind, game_code) VALUES ('sched-ck', '편성 CK', 'ck', 'lol') RETURNING id`;
  const [fcEv] = await sql<{ id: string }[]>`INSERT INTO event (slug, name, kind, game_code) VALUES ('sched-fc', '편성 FC 대회', 'tournament', 'fconline') RETURNING id`;

  const base = () => ({
    game_code: "lol" as const, title: "검증 CK", scale: "minor" as const, planned_kind: "ck" as const,
    sponsor: null, description: "공개 설명", admin_note: "관리자만", status: "scheduled" as const,
    event_id: null as string | null, visibility: "public" as const,
    slots: [{ label: null, on_date: "2026-10-03", starts_at: kst("2026-10-03T20:00"), ends_at: kst("2026-10-03T23:00"), channel_id: null }],
    participants: [{ streamer_id: host.id, role: "host" as const, team: null }, { streamer_id: hidden.id, role: "player" as const, team: null }],
    sources: [{ url: "https://ch.sooplive.co.kr/schedhost/post/1", title: "공지", posted_at: null }],
  });

  const saved = await schedule.saveScheduleEntry(base());
  check("일정이 저장되고 version 을 돌려준다", Boolean(saved.id && saved.version));

  await expectReject("없는 날짜(2026-02-30)는 다음 달로 넘기지 않고 거부한다",
    () => schedule.saveScheduleEntry({ ...base(), slots: [{ ...base().slots[0], on_date: "2026-02-30", starts_at: null, ends_at: null }] }),
    "없는 날짜");
  await expectReject("DB 도 시작 시각의 KST 날짜 ≠ 칸 날짜를 거부한다(CHECK)",
    () => sql`INSERT INTO schedule_slot (entry_id, on_date, starts_at) VALUES (${saved.id}, '2026-10-04', ${kst("2026-10-03T20:00")})`,
    "schedule_slot_start_on_date");
  await expectReject("DB 도 끝 ≤ 시작을 거부한다(CHECK)",
    () => sql`INSERT INTO schedule_slot (entry_id, on_date, starts_at, ends_at) VALUES (${saved.id}, '2026-10-03', ${kst("2026-10-03T20:00")}, ${kst("2026-10-03T20:00")})`,
    "schedule_slot_end_after_start");
  await expectReject("공개인데 출처가 없으면 저장을 거부한다",
    () => schedule.saveScheduleEntry({ ...base(), sources: [] }), "출처");

  // 원자성 — 없는 스트리머를 참가자로 넣어 트랜잭션 도중(FK)에 실패시킨다. 앞에서 바꾼 제목·칸이 남으면 안 된다.
  await expectReject("저장 도중 실패하면 예외가 난다",
    () => schedule.saveScheduleEntry({
      ...base(), title: "바뀌면 안 되는 제목",
      slots: [{ ...base().slots[0], on_date: "2026-10-09", starts_at: null, ends_at: null }],
      participants: [{ streamer_id: "00000000-0000-4000-8000-0000000000aa", role: "player", team: null }],
    }, { id: saved.id, version: saved.version }),
    "foreign key");
  const after = await schedule.getScheduleForAdmin(saved.id);
  check("★ 도중 실패하면 아무것도 안 바뀐다 — 제목·칸·참가자·version 그대로",
    after?.input.title === "검증 CK" && after.input.slots.length === 1 && after.input.slots[0].on_date === "2026-10-03"
      && after.participants.length === 2 && after.version === saved.version,
    JSON.stringify({ title: after?.input.title, slots: after?.input.slots.map((s) => s.on_date), v: after?.version === saved.version }));

  const v2 = await schedule.saveScheduleEntry({ ...base(), title: "검증 CK (수정)" }, { id: saved.id, version: saved.version });
  check("올바른 version 으로는 수정된다", v2.version !== saved.version);
  await expectReject("★ 오래된 version 으로 저장하면 거부한다 — 다른 수정을 덮어쓰지 않는다",
    () => schedule.saveScheduleEntry({ ...base(), title: "덮어쓰기" }, { id: saved.id, version: saved.version }),
    "다른 수정이 먼저");

  await expectReject("결과 연결은 개최 확인(held)일 때만",
    () => schedule.saveScheduleEntry({ ...base(), event_id: lolCk.id }, { id: saved.id, version: v2.version }), "개최 확인");
  await expectReject("★ 다른 게임의 event 에는 연결할 수 없다",
    () => schedule.saveScheduleEntry({ ...base(), status: "held", event_id: fcEv.id }, { id: saved.id, version: v2.version }), "게임");
  const v3 = await schedule.saveScheduleEntry({ ...base(), status: "held", event_id: lolCk.id }, { id: saved.id, version: v2.version });
  check("같은 게임의 event 에는 held 로 연결된다", Boolean(v3.version));
  await expectReject("★ 결과와 연결된 채로 게임을 바꾸면 거부한다",
    () => schedule.saveScheduleEntry({ ...base(), game_code: "fconline", status: "held", event_id: fcEv.id }, { id: saved.id, version: v3.version }),
    "게임을 바꿀 수 없습니다");

  console.log("\n▸ 편성표 — 공개 경계");
  const pubEntry = await sql`SELECT * FROM core_public.schedule_entry WHERE schedule_id = ${saved.id}`;
  check("공개 일정이 공개 뷰에 나온다", pubEntry.length === 1);
  check("공개 뷰에 관리자 메모 칸이 없다", pubEntry.length === 1 && !("admin_note" in pubEntry[0]));
  const pubPeople = await sql<{ streamer_id: string }[]>`SELECT streamer_id FROM core_public.schedule_participant WHERE schedule_id = ${saved.id}`;
  check("★ 숨긴 스트리머는 공개 참가자에서 빠진다",
    pubPeople.length === 1 && pubPeople[0].streamer_id === host.id, JSON.stringify(pubPeople));

  // 출처 없는 공개 일정을 접근자를 우회해 직접 넣어도 뷰가 내보내지 않는다.
  const [raw] = await sql<{ id: string }[]>`
    INSERT INTO schedule_entry (game_code, title, scale, planned_kind) VALUES ('lol', '출처 없음', 'minor', 'ck') RETURNING id`;
  await sql`INSERT INTO schedule_slot (entry_id, on_date) VALUES (${raw.id}, '2026-10-03')`;
  check("★ 출처 없는 일정은(직접 넣어도) 공개 뷰에 없다",
    (await sql`SELECT 1 FROM core_public.schedule_entry WHERE schedule_id = ${raw.id}`).length === 0
      && (await sql`SELECT 1 FROM core_public.schedule_slot WHERE schedule_id = ${raw.id}`).length === 0);

  const hiddenEntry = await schedule.saveScheduleEntry({ ...base(), title: "숨긴 일정", visibility: "hidden" });
  const leaks = await sql<{ n: number }[]>`
    SELECT (SELECT count(*) FROM core_public.schedule_slot WHERE schedule_id = ${hiddenEntry.id})
         + (SELECT count(*) FROM core_public.schedule_source WHERE schedule_id = ${hiddenEntry.id})
         + (SELECT count(*) FROM core_public.schedule_participant WHERE schedule_id = ${hiddenEntry.id}) AS n`;
  check("★ 숨긴 일정의 칸·출처·참가자는 하위 공개 뷰에도 없다(부모 조건 상속)", Number(leaks[0].n) === 0, String(leaks[0].n));

  console.log("\n▸ 편성표 — 공개 조회");
  const major = await schedule.saveScheduleEntry({
    ...base(), title: "여러 날 FC 대회", game_code: "fconline", scale: "major", planned_kind: "tournament", status: "held", event_id: fcEv.id,
    participants: [{ streamer_id: host.id, role: "host", team: null }],
    slots: [
      { label: "개막", on_date: "2026-09-28", starts_at: kst("2026-09-28T19:00"), ends_at: null, channel_id: null },
      { label: "결승", on_date: "2026-10-12", starts_at: null, ends_at: null, channel_id: "final-ch" },
    ],
  });
  const win = await pub.listPublicSchedule({ from: "2026-10-01", to: "2026-10-07" });
  const majorRow = win.find((e) => e.schedule_id === major.id);
  check("★ 기간 전에 시작해 기간 뒤에 끝나는 대회도 겹치면 나온다(칸 전체와 함께)",
    majorRow?.slots.length === 2, JSON.stringify(majorRow?.slots.map((s) => s.on_date)));
  check("방송 채널 — 명시값은 그대로, 없으면 주최 한 명·채널 하나일 때 그 채널",
    majorRow?.slots[0].channel_id === "schedhost" && majorRow?.slots[1].channel_id === "final-ch",
    JSON.stringify(majorRow?.slots.map((s) => s.channel_id)));
  check("FC 대회 목록에 있는 event 와 연결된 개최 확인 일정은 결과 링크를 갖는다",
    majorRow?.result?.page === "fc_event" && majorRow.result.slug === "sched-fc", JSON.stringify(majorRow?.result));
  const ckRow = win.find((e) => e.schedule_id === saved.id);
  check("★ 롤 CK event 와 연결돼도 결과 링크가 없다 — 롤 대회 상세는 kind='tournament' 만 연다(404 방지)",
    ckRow !== undefined && ckRow.result === null, JSON.stringify(ckRow?.result));
  const lolT = (await listPublicTournamentEvents()).find((t) => t.slug);
  if (lolT) {
    const t = await schedule.saveScheduleEntry({ ...base(), title: "롤 대회 결과", status: "held", event_id: lolT.event_id });
    const row = (await pub.listPublicSchedule({ from: "2026-10-01", to: "2026-10-07" })).find((e) => e.schedule_id === t.id);
    check("롤 대회 목록에 있는 대회와 연결되면 결과 링크를 갖는다", row?.result?.page === "lol_tournament" && row.result.slug === lolT.slug,
      JSON.stringify(row?.result));
  } else {
    check("롤 대회 목록이 비어 있지 않다(양성 사례를 만들 수 있다)", false, "앞 단계가 공개 대회를 만들지 않았다");
  }
  check("게임 필터", (await pub.listPublicSchedule({ from: "2026-10-01", to: "2026-10-07", game: "fconline" })).every((e) => e.game_code === "fconline"));
  check("스트리머 필터 — 숨긴 참가자 slug 로는 아무것도 안 나온다",
    (await pub.listPublicSchedule({ from: "2026-10-01", to: "2026-10-07", streamer: "sched-hidden" })).length === 0);
  check("스트리머 필터 — 주최 slug 로는 그 일정들이 나온다",
    (await pub.listPublicSchedule({ from: "2026-10-01", to: "2026-10-07", streamer: "sched-host" })).some((e) => e.schedule_id === major.id));
  const far = await pub.listPublicSchedule({ from: "2026-10-01", to: "2027-12-31" });
  check(`조회 기간은 최대 ${pub.SCHEDULE_MAX_DAYS}일로 잘린다`, far.every((e) => e.slots.some((s) => s.on_date <= "2026-10-31")));
}
