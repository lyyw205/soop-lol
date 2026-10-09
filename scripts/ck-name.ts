/**
 * **화면에서 읽은 이름 = 이 스트리머** 를 사용자가 확인해 줬을 때, 다음 조사가 다시 묻지 않게 등록한다.
 *
 *   npm run ck:name -- <화면이름> <slug> --note "사용자 확인(2026-10-09): …"            # 미리보기
 *   npm run ck:name -- <화면이름> <slug> --note "…" --apply                            # 기록
 *   … --riot 이름#태그   같은 이름의 라이엇 계정이 여럿이면 하나를 집는다
 *
 * ── 왜 필요한가 ─────────────────────────────────────────────────────────
 * 2026-10-05 미확인 이름 화면에서 '듀부선' 64자리를 듀단에 붙였는데, 그 뒤 기록된 경기 71자리는
 * 또 미확인이었다. 화면의 연결은 **그때 있던 자리**에만 사람을 적고 "듀부선 = 듀단" 이라는 사실은
 * 어디에도 남기지 않았다. 조사 세션이 이름을 사람으로 바꾸는 곳은 `ck:who` 하나인데, 거기엔
 * `듀부선#튼실하네` 가 주인 없는 계정으로만 보였다.
 *
 * 그래서 한 번에 둘을 한다:
 *   1. 그 이름의 라이엇 계정이 DB 에 있으면 이 사람 계정으로 연결한다(`linkAccount` — 근거 필수).
 *      그러면 매일 닉네임 갱신 대상이 되고, 닉네임이 바뀌어도 `ck:who` 가 이력으로 찾는다(0083).
 *   2. 그 이름으로 남은 미확인 자리를 전부 이 사람에게 붙인다. 계정을 모르는 이름(태그 미상)은
 *      이 연결이 곧 기록이다 — `ck:who` 가 "연결된 자리" 로 읽는다.
 *
 * ★ 사용자 확인은 그 칸의 사람 검수다 — 사람이 만진 경기도 덮고 검수 완료를 지킨다(`confirmedByUser`).
 * ★ 이 계정에 이미 다른 주인이 있으면 멈춘다. 부계정 오연결은 실제 분쟁이 된다(CLAUDE.md 2).
 */
import { closeDb, db } from "@soop-lol/core/lib/db/client";
import { listUnidentifiedParticipants, reviewUnidentifiedParticipants } from "@soop-lol/core/lib/db/ck";
import { linkAccount } from "@soop-lol/core/lib/db/streamers";

import { makeOpt } from "./lib/cli.mjs";

const argv = process.argv.slice(2);
const opt = makeOpt(argv);
const NOTE = opt("--note", "").trim();
const RIOT = opt("--riot", "").trim();
const APPLY = argv.includes("--apply");
const valueFlags = new Set(["--note", "--riot"]);
const positional = argv.filter((a, i) => !a.startsWith("--") && !valueFlags.has(argv[i - 1] ?? ""));
const [NAME, SLUG] = positional;

if (!NAME || !SLUG || !NOTE) {
  console.error('쓰기:  npm run ck:name -- <화면이름> <slug> --note "사용자 확인(YYYY-MM-DD): …" [--riot 이름#태그] [--apply]');
  process.exit(1);
}

/** ck:who 와 같은 정규화 — 공백·구두점만 지운다. */
const norm = (s: string | null) => String(s ?? "").normalize("NFKC").replace(/[\s\-_.]+/gu, "").toLowerCase();

const sql = db();
try {
  const [streamer] = await sql<{ id: string; slug: string; display_name: string }[]>`
    SELECT id, slug, display_name FROM streamer WHERE slug = ${SLUG}`;
  if (!streamer) throw new Error(`등록 안 된 slug: ${SLUG} — 사람부터 등록한다.`);
  console.log(`${NAME} → ${streamer.display_name} (${streamer.slug})${APPLY ? "" : "   [미리보기 — --apply 로 기록]"}\n`);

  // ── 1. 계정 ────────────────────────────────────────────────────────
  const [riotName, riotTag] = RIOT.split("#");
  const accounts = (await sql<{ puuid: string; game_name: string | null; tag_line: string | null; owners: { slug: string; display_name: string }[] }[]>`
    SELECT ra.puuid, ra.game_name, ra.tag_line,
           COALESCE((SELECT jsonb_agg(jsonb_build_object('slug', s.slug, 'display_name', s.display_name))
                       FROM streamer_account sa JOIN streamer s ON s.id = sa.streamer_id
                      WHERE sa.puuid = ra.puuid AND sa.active_to IS NULL), '[]') AS owners
      FROM riot_account ra
     WHERE ra.game_name IS NOT NULL`).filter((a) => RIOT
    ? a.game_name === riotName && a.tag_line === riotTag
    : norm(a.game_name) === norm(NAME));

  let linkPuuid: string | null = null;
  if (RIOT && accounts.length === 0) throw new Error(`${RIOT} 계정이 DB 에 없다.`);
  if (accounts.length === 0) {
    console.log("계정  같은 이름의 라이엇 계정이 DB 에 없다 — 자리 연결만 남긴다(ck:who 가 '연결된 자리' 로 찾는다).");
  } else if (accounts.length > 1) {
    throw new Error(`같은 이름의 계정이 ${accounts.length}개다 — --riot 으로 하나를 집는다: `
      + accounts.map((a) => `${a.game_name}#${a.tag_line}`).join(", "));
  } else {
    const a = accounts[0];
    const others = a.owners.filter((o) => o.slug !== streamer.slug);
    if (others.length > 0) {
      throw new Error(`${a.game_name}#${a.tag_line} 은 이미 ${others.map((o) => o.display_name).join(", ")} 의 계정이다 — 확인 전엔 옮기지 않는다.`);
    }
    if (a.owners.length > 0) {
      console.log(`계정  ${a.game_name}#${a.tag_line} — 이미 ${streamer.display_name} 계정이다.`);
    } else {
      linkPuuid = a.puuid;
      console.log(`계정  ${a.game_name}#${a.tag_line} → ${streamer.display_name} 로 연결 (manual · likely)`);
    }
  }

  // ── 2. 자리 ────────────────────────────────────────────────────────
  const targets = (await listUnidentifiedParticipants(1000, 0, NAME))
    .filter((r) => r.observed_name === NAME).flatMap((r) => r.targets);
  // 같은 경기에 이 사람이 이미 있으면 붙일 수 없다(match_participant_streamer_uq). 통째 취소 대신 빼고 알린다.
  const taken = new Set((await sql<{ match_id: string }[]>`
    SELECT DISTINCT match_id FROM match_participant
     WHERE streamer_id = ${streamer.id} AND match_id = ANY(${targets.map((t) => t.match_id)}::text[])`).map((r) => r.match_id));
  const seats = targets.filter((t) => !taken.has(t.match_id));
  const [hidden] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM match_participant mp JOIN match m ON m.match_id = mp.match_id
     WHERE mp.observed_name = ${NAME} AND mp.streamer_id IS NULL AND mp.puuid IS NULL AND m.visibility <> 'public'`;
  console.log(`자리  미확인 ${targets.length}자리 중 ${seats.length}자리 연결`
    + (taken.size ? ` · 이미 ${streamer.display_name} 이(가) 있는 경기 ${taken.size}개는 뺀다: ${[...taken].join(", ")}` : "")
    + (hidden.n ? ` · 비공개 경기 ${hidden.n}자리는 건드리지 않는다` : ""));
  for (const t of seats) console.log(`      ${t.match_id} #${t.participant_id}${t.reviewed_at ? "  (사람이 만진 경기)" : ""}`);

  if (APPLY) {
    if (linkPuuid) {
      await linkAccount({
        streamer_id: streamer.id, puuid: linkPuuid, evidence: { source: "manual", note: NOTE }, confidence: "likely",
      });
      console.log("\n✓ 계정 연결");
    }
    if (seats.length > 0) {
      const r = await reviewUnidentifiedParticipants(seats, streamer.id, { confirmedByUser: true });
      console.log(`✓ 자리 ${r.linked}개 연결 (경기 ${r.matches.length}개`
        + (r.kept_completed.length ? ` · 검수 완료 유지 ${r.kept_completed.length}개` : "") + ")");
    }
  }
} catch (e) {
  console.error(`✖ ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
