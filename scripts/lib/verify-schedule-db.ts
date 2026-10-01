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

  console.log("\n▸ 편성표 — 변경 이력·상세·다가오는 일정 (2단계)");
  const { describeChange } = await import("../../packages/core/lib/metrics/schedule.ts");
  const hist = await schedule.saveScheduleEntry({ ...base(), title: "이력 시험" });
  const histCount = async () => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM schedule_change WHERE entry_id = ${hist.id}`)[0].n;
  check("처음 저장은 이력이 없다", (await histCount()) === 0);
  const h2 = await schedule.saveScheduleEntry({ ...base(), title: "이력 시험" }, { id: hist.id, version: hist.version });
  check("값이 그대로인 저장은 이력을 남기지 않는다", (await histCount()) === 0);
  const h3 = await schedule.saveScheduleEntry({ ...base(), title: "이력 시험",
    slots: [{ label: null, on_date: "2026-10-04", starts_at: kst("2026-10-04T19:00"), ends_at: null, channel_id: null }] }, { id: hist.id, version: h2.version });
  const rows = await schedule.listScheduleChanges(hist.id);
  check("★ 날짜를 옮기면 slots 이력 한 줄 — 'A → B'", rows.length === 1 && rows[0].field === "slots"
    && describeChange(rows[0]) === "일정 변경: 10/3 20:00–23:00 → 10/4 19:00 시작", rows.map(describeChange).join(" | "));
  const h4 = await schedule.saveScheduleEntry({ ...base(), title: "이력 시험 (오타 고침)",
    slots: [{ label: null, on_date: "2026-10-04", starts_at: kst("2026-10-04T19:00"), ends_at: null, channel_id: null }] },
    { id: hist.id, version: h3.version, recordHistory: false });
  check("★ 오타 수정으로 저장하면 이력을 남기지 않는다", (await histCount()) === 1);
  await expectReject("저장이 실패하면 이력도 남지 않는다(같은 트랜잭션)",
    () => schedule.saveScheduleEntry({ ...base(), status: "cancelled",
      participants: [{ streamer_id: "00000000-0000-4000-8000-0000000000bb", role: "player", team: null }] }, { id: hist.id, version: h4.version }),
    "foreign key");
  check("  └ 실패한 저장의 '무산' 이력이 없다", (await histCount()) === 1);
  const h5 = await schedule.saveScheduleEntry({ ...base(), title: "이력 시험 (오타 고침)", status: "cancelled",
    slots: [{ label: null, on_date: "2026-10-04", starts_at: kst("2026-10-04T19:00"), ends_at: null, channel_id: null }] }, { id: hist.id, version: h4.version });
  const pubChanges = await pub.listPublicScheduleChanges(hist.id);
  check("공개 이력은 최근 것부터 — 무산 처리 → 일정 변경", pubChanges.map(describeChange).join(" | ") === "예정 → 무산 | 일정 변경: 10/3 20:00–23:00 → 10/4 19:00 시작",
    pubChanges.map(describeChange).join(" | "));
  const one = await pub.getPublicScheduleEntry(hist.id);
  check("상세: 공개 일정 하나를 읽는다(일정 변경 시각 포함)", one?.title === "이력 시험 (오타 고침)" && one.slots_changed_at !== null);
  await schedule.saveScheduleEntry({ ...base(), title: "이력 시험 (오타 고침)", status: "cancelled", visibility: "hidden",
    slots: [{ label: null, on_date: "2026-10-04", starts_at: kst("2026-10-04T19:00"), ends_at: null, channel_id: null }] }, { id: hist.id, version: h5.version });
  check("★ 숨긴 일정은 상세도 이력도 공개로 나오지 않는다",
    (await pub.getPublicScheduleEntry(hist.id)) === null && (await pub.listPublicScheduleChanges(hist.id)).length === 0);
  check("상세: 없는 id·형식이 아닌 id 는 null", (await pub.getPublicScheduleEntry("00000000-0000-4000-8000-000000000000")) === null
    && (await pub.getPublicScheduleEntry("not-a-uuid")) === null);

  const upcoming = await pub.listUpcomingScheduleFor("sched-host", kst("2026-10-02T12:00"));
  check("★ 다가오는 일정: 무산·지난 일정은 빼고, 이미 시작한 대회는 다음 칸 기준",
    upcoming.length > 0 && upcoming.every((e) => e.status !== "cancelled") && upcoming.some((e) => e.schedule_id === major.id && e.next.label === "결승"),
    JSON.stringify(upcoming.map((e) => [e.title, e.next.on_date])));
  check("다가오는 일정: 가장 가까운 다음 칸 순", upcoming.every((e, i) => i === 0 || upcoming[i - 1].next.on_date <= e.next.on_date));
  check("다가오는 일정: 숨긴 참가자 slug 로는 비어 있다", (await pub.listUpcomingScheduleFor("sched-hidden", kst("2026-10-02T12:00"))).length === 0);

  const far = await pub.listPublicSchedule({ from: "2026-10-01", to: "2027-12-31" });
  check(`조회 기간은 최대 ${pub.SCHEDULE_MAX_DAYS}일로 잘린다`, far.every((e) => e.slots.some((s) => s.on_date <= "2026-10-31")));
}
