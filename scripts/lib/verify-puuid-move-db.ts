/**
 * puuid 교체가 검수 완료를 지키는지 실제 Postgres(PGlite)에서 확인한다 — verify-db.ts 가 부른다.
 * 2026-10-02 `repair:puuid` 가 사람이 완료한 442경기를 한꺼번에 풀었다(트리거 0043). 같은 일이 다시 없어야 한다.
 */

type Check = (name: string, ok: boolean, detail?: string) => void;

export async function verifyPuuidMoveDb(check: Check): Promise<void> {
  const { db } = await import("../../packages/core/lib/db/client.ts");
  const { repointPuuid } = await import("../../packages/core/lib/db/puuid-move.ts");
  const sql = db();
  console.log("\n▸ puuid 교체 — 검수 완료 유지");

  const oldP = "o".repeat(78), newP = "w".repeat(78), otherP = "x".repeat(78);
  for (const p of [oldP, otherP]) await sql`INSERT INTO riot_account (puuid, game_name, tag_line, platform_region, routing_region) VALUES (${p}, 'n', 'KR1', 'kr', 'asia')`;
  for (const id of ["pm:done", "pm:open", "pm:untouched"]) {
    await sql`INSERT INTO match (match_id, game_code, queue_id, mode_key, game_creation, source, origin) VALUES (${id}, 'lol', 0, '0', now(), 'manual', 'admin')`;
  }
  const part = (m: string, p: string, n: number) => sql`
    INSERT INTO match_participant (match_id, puuid, participant_id, team_id, champion_id, outcome, kills, deaths, assists)
    VALUES (${m}, ${p}, ${n}, 100, 1, 'win', 1, 1, 1)`;
  await part("pm:done", oldP, 1); await part("pm:open", oldP, 1); await part("pm:untouched", otherP, 1);
  await sql`UPDATE match SET review_completed_at = '2026-09-29T09:00:00Z' WHERE match_id IN ('pm:done', 'pm:untouched')`;
  const before = await sql<{ match_id: string; review_version: number }[]>`SELECT match_id, review_version FROM match WHERE match_id LIKE 'pm:%' ORDER BY 1`;
  const v = Object.fromEntries(before.map((r) => [r.match_id, r.review_version]));

  const r = await sql.begin((tx) => repointPuuid(tx, oldP, newP));
  const after = await sql<{ match_id: string; review_completed_at: Date | null; review_version: number }[]>`
    SELECT match_id, review_completed_at, review_version FROM match WHERE match_id LIKE 'pm:%' ORDER BY 1`;
  const a = Object.fromEntries(after.map((x) => [x.match_id, x]));

  check("참가자 puuid 가 새 값으로 바뀐다", (await sql`SELECT 1 FROM match_participant WHERE match_id = 'pm:done' AND puuid = ${newP}`).length === 1);
  check("옛 riot_account 행은 지워진다", (await sql`SELECT 1 FROM riot_account WHERE puuid = ${oldP}`).length === 0);
  check("완료였던 경기는 완료 시각이 그대로다", a["pm:done"].review_completed_at?.toISOString() === "2026-09-29T09:00:00.000Z");
  check("완료였던 경기의 변경 번호도 그대로다", a["pm:done"].review_version === v["pm:done"], `${v["pm:done"]} → ${a["pm:done"].review_version}`);
  check("원래 미완료였던 경기는 미완료로 남는다(완료를 만들어내지 않는다)", a["pm:open"].review_completed_at === null);
  check("이 계정이 안 낀 완료 경기는 건드리지 않는다", a["pm:untouched"].review_completed_at !== null && a["pm:untouched"].review_version === v["pm:untouched"]);
  check("보존한 완료 경기 수를 돌려준다", r.preserved_reviews === 1, String(r.preserved_reviews));

  // 대조: 보존 로직 없이 참조만 옮기면 트리거가 완료를 푼다 — 위 검사가 실제로 의미 있다는 증거.
  await part("pm:done", otherP, 2);
  await sql`UPDATE match SET review_completed_at = now() WHERE match_id = 'pm:done'`;
  await sql`UPDATE match_participant SET puuid = ${oldP} WHERE match_id = 'pm:done' AND participant_id = 2`;
  const [raw] = await sql<{ review_completed_at: Date | null }[]>`SELECT review_completed_at FROM match WHERE match_id = 'pm:done'`;
  check("대조: 보존 없이 puuid 를 바꾸면 트리거가 완료를 푼다", raw.review_completed_at === null);
}

/**
 * 닉네임 이력(0083) — 매일 갱신이 이름을 덮어써도 옛 이름이 남는가. ck:who 가 옛 VOD 이름을 찾는 근거다.
 * 이름을 쓰는 길이 여럿이라 트리거로 잡았다 — 그래서 앱 함수가 아니라 생 UPDATE 로도 확인한다.
 */
export async function verifyNameHistoryDb(check: Check): Promise<void> {
  const { db } = await import("../../packages/core/lib/db/client.ts");
  const { saveProfile } = await import("../../packages/core/lib/db/ingest.ts");
  const { repointPuuid } = await import("../../packages/core/lib/db/puuid-move.ts");
  const sql = db();
  console.log("\n▸ 닉네임 이력 (0083)");

  const p = "h".repeat(78), moved = "m".repeat(78);
  const names = async (puuid: string) => sql<{ game_name: string; tag_line: string; current: boolean; first: Date }[]>`
    SELECT game_name, tag_line, replaced_at IS NULL AS current, first_seen_at AS first
      FROM riot_account_name WHERE puuid = ${puuid} ORDER BY first_seen_at, game_name`;

  await sql`INSERT INTO riot_account (puuid, game_name, tag_line) VALUES (${p}, '임부선', '튼실하네')`;
  check("계정을 넣으면 지금 이름이 남는다", JSON.stringify((await names(p)).map((r) => [r.game_name, r.current])) === '[["임부선",true]]');

  await saveProfile({ puuid: p, game_name: "듀부선", tag_line: "튼실하네" });
  const afterRename = await names(p);
  check("매일 갱신이 이름을 바꾸면 옛 이름은 '바뀜' 으로 남는다",
    afterRename.some((r) => r.game_name === "임부선" && !r.current) && afterRename.some((r) => r.game_name === "듀부선" && r.current),
    JSON.stringify(afterRename));

  // 계정 조회가 실패하면 saveProfile 은 coalesce 로 같은 값을 다시 쓴다 — 아무것도 바뀌면 안 된다.
  await saveProfile({ puuid: p, game_name: null, tag_line: null, summoner_level: 300 });
  check("같은 이름을 다시 써도 이력은 그대로다", JSON.stringify(await names(p)) === JSON.stringify(afterRename));

  await sql`UPDATE riot_account SET game_name = '임부선' WHERE puuid = ${p}`;
  const back = await names(p);
  const firstOld = afterRename.find((r) => r.game_name === "임부선")!.first.getTime();
  check("예전 이름으로 돌아오면 그 이름이 다시 '지금' 이고, 처음 본 때는 그대로다",
    back.find((r) => r.game_name === "임부선")?.current === true
      && back.find((r) => r.game_name === "임부선")!.first.getTime() === firstOld
      && back.find((r) => r.game_name === "듀부선")?.current === false,
    JSON.stringify(back));

  await sql`INSERT INTO riot_account (puuid, game_name) VALUES (${"t".repeat(78)}, '태그모름')`;
  check("태그를 모르는 계정도 남는다('' 로)", (await sql`SELECT 1 FROM riot_account_name WHERE puuid = ${"t".repeat(78)} AND tag_line = ''`).length === 1);

  await sql.begin((tx) => repointPuuid(tx, p, moved));
  const movedNames = await names(moved);
  check("puuid 를 갈아끼우면 옛 이름까지 새 puuid 로 따라간다",
    movedNames.length === 2 && movedNames.some((r) => r.game_name === "듀부선" && !r.current)
      && movedNames.some((r) => r.game_name === "임부선" && r.current && r.first.getTime() === firstOld),
    JSON.stringify(movedNames));
  check("옛 puuid 의 이력은 남지 않는다", (await names(p)).length === 0);
}
