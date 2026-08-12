/**
 * 내전에서 만난 **모르는 참가자**가 누구인지 알아낸다.
 *
 *   npm run candidates:identify              # 확인만 한다 (기본값 — 아무것도 안 바꾼다)
 *   npm run candidates:identify -- --apply   # 실제로 등록한다
 *   npm run candidates:identify -- --season 27
 *
 * ★ 무슨 문제를 푸나
 *   내전 한 판에 10명이 있는데 우리가 아는 사람은 그중 일부다. 나머지는
 *   `account_candidate` 에 puuid 로만 쌓인다 — 누군지 모르는 채로.
 *
 * ★ 어떻게 아나 — SOOP 멸망전 FA 등록과 대조한다
 *   FA 등록은 스트리머가 **본인 손으로 입력한 라이엇 ID** 다. 제출 시점에 SOOP 이
 *   Riot 으로 실존 검증까지 한다. 그래서 후보의 puuid 를 라이엇 ID 로 풀어
 *   FA 명단에 정확히 있으면, 그 사람이 누구인지 **근거를 갖고** 말할 수 있다.
 *   evidence.source = 'self_declared' (§11-2).
 *
 * ★ 대조는 puuid 로 한다
 *   FA 의 라이엇 ID 문자열을 그대로 비교하지 않는다. SOOP 표기가 라이엇 정본과
 *   어긋나기 때문이다 — 태그에 공백이 들어가고(`#산 본`), 게임명 공백 수가
 *   다르다(`TT TT` ↔ `TT  TT`). 양쪽을 **account-v1 으로 풀어 puuid 로 맞춘다.**
 *   정본은 언제나 Riot 이다.
 *
 * ★ 이름이 비슷하다고 같은 사람으로 치지 않는다
 *   라이엇 게임명이 방송국 닉네임과 닮았다는 건 근거가 아니다. seed/README.md 에
 *   실제로 걸린 예가 있다 — `스맵임` 이 lv1 언랭 남의 계정에 붙었다.
 *   FA puuid 일치가 아니면 후보로 남기고 사람이 본다.
 *
 * ★ 자동으로 쓰지 않는다
 *   `--apply` 없이는 아무것도 바꾸지 않는다. 공개 화면에 나갈 행을 자동 잡이
 *   혼자 만들면 부계정 오노출이 사람 눈을 건너뛰고 나간다.
 */

import { closeDb, db } from "@soop-lol/core/lib/db/client";
import {
  createStreamer,
  getStreamer,
  linkAccount,
  setCandidateState,
  upsertRiotAccount,
  upsertStreamerChannel,
} from "@soop-lol/core/lib/db/streamers";
import { RiotClient } from "@soop-lol/core/lib/riot/client";

import { kstDate, makeOpt } from "./lib/cli.mjs";
import { faPageUrl, fetchFaList } from "./lib/soop-fa.mjs";

const argv = process.argv.slice(2);
const opt = makeOpt(argv);
const apply = argv.includes("--apply");
const SEASON = Number(opt("--season", "27"));
const LIMIT = Number(opt("--limit", "500"));

// ★ 가드가 생성자보다 먼저다 — RiotClient 는 빈 키에서 던지므로 순서가 바뀌면
//   이 안내는 죽은 코드가 되고 사용자는 스택트레이스를 본다(실제로 그랬다).
if (!process.env.RIOT_API_KEY) {
  console.error("RIOT_API_KEY 가 없다. apps/web/.env.local 을 확인해라.");
  process.exit(1);
}
const riot = new RiotClient({ apiKey: process.env.RIOT_API_KEY });

const FA_PAGE = faPageUrl(SEASON);
const today = kstDate();
const sql = db();

interface FaEntry {
  userId: string;
  userNick: string;
  gameNick: string;
  totalGameNickList: string[] | null;
}

try {
  // ── 1. 후보 ────────────────────────────────────────────────────────
  const candidates = await sql<
    { id: string; puuid: string; game_name: string | null; tag_line: string | null; seen_count: number; seen_with: string[] }[]
  >`
    SELECT id, puuid, game_name, tag_line, seen_count, seen_with
      FROM account_candidate
     WHERE state = 'pending'
     ORDER BY seen_count DESC, last_seen_at DESC
     LIMIT ${LIMIT}
  `;
  if (candidates.length === 0) {
    console.log("승인 대기 후보가 없다. 워커가 내전을 수집하면 여기 쌓인다.");
    process.exit(0);
  }
  console.log(`후보 ${candidates.length}명 검사${apply ? "" : "  (확인만 — 아무것도 바꾸지 않는다)"}\n`);

  // ── 2. FA 명단 ─────────────────────────────────────────────────────
  const fa: FaEntry[] = await fetchFaList(SEASON);
  if (fa.length === 0) {
    console.error(`FA 시즌 ${SEASON} 을 못 읽었다. 열려 있는 건 현재 시즌뿐이다.`);
    process.exit(1);
  }
  console.log(`FA 시즌 ${SEASON} — ${fa.length}명 · 라이엇 ID ${fa.reduce((n, f) => n + (f.totalGameNickList?.length ?? 0), 0)}개`);

  // ── 3. 후보 → 라이엇 ID → FA 대조 ──────────────────────────────────
  //
  // 순서가 중요하다. FA 501개를 전부 푸는 게 아니라 **후보 쪽에서 출발**한다 —
  // Development 키는 2분에 100회라, 매번 501번 부르면 한 번 돌리는 데 10분이 넘는다.
  //
  //   ① 후보 puuid → 현재 라이엇 ID (account-v1). 후보 수만큼만 부른다
  //   ② 느슨하게 정규화해 FA 명단에서 **후보군**을 좁힌다 (공백 제거·소문자)
  //   ③ 좁혀진 것만 FA 쪽 표기로 다시 풀어 **puuid 가 같은지 확인**한다
  //
  // ②만으로 끝내지 않는 이유: 정규화 일치는 '비슷한 이름'이지 같은 계정이 아니다.
  // 최종 판정은 언제나 puuid 다(§11-1). ③이 그 못이다.
  const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();
  const faByName = new Map<string, { fa: FaEntry; riotId: string }[]>();
  for (const f of fa) {
    for (const riotId of f.totalGameNickList ?? []) {
      const key = norm(riotId);
      (faByName.get(key) ?? faByName.set(key, []).get(key)!).push({ fa: f, riotId });
    }
  }

  const byPuuid = new Map<string, { fa: FaEntry; riotId: string }>();
  let looked = 0;
  let confirmed = 0;
  for (const c of candidates) {
    // ① 현재 라이엇 ID. 매치에 적힌 이름은 낡았을 수 있으므로 다시 푼다.
    const acc = await riot.accountByPuuid(c.puuid).catch(() => null);
    looked++;
    if (!acc?.gameName) continue;
    const cand = `${acc.gameName}#${acc.tagLine ?? ""}`;

    // ② 이름으로 후보군만 좁힌다. 여기서 걸렸다고 같은 사람은 아니다.
    const maybe = faByName.get(norm(cand)) ?? [];
    if (maybe.length === 0) continue;

    // ③ FA 표기로 풀어 puuid 가 같을 때만 인정한다.
    for (const m of maybe) {
      const hash = m.riotId.lastIndexOf("#");
      if (hash < 0) continue;
      const fromFa = await riot
        .accountByRiotId(m.riotId.slice(0, hash), m.riotId.slice(hash + 1))
        .catch(() => null);
      if (fromFa?.puuid === c.puuid) {
        byPuuid.set(c.puuid, m);
        confirmed++;
        break;
      }
    }
    if (looked % 50 === 0) console.log(`  후보 해석 ${looked}/${candidates.length} · 확정 ${confirmed}`);
  }
  console.log(`후보 ${looked}건 해석 · FA puuid 일치 ${confirmed}건\n`);

  // ── 4. 판정 ────────────────────────────────────────────────────────
  type Candidate = (typeof candidates)[number];
  const hits: { c: Candidate; fa: FaEntry; riotId: string }[] = [];
  const misses: Candidate[] = [];
  for (const c of candidates) {
    const m = byPuuid.get(c.puuid);
    if (m) hits.push({ c, fa: m.fa, riotId: m.riotId });
    else misses.push(c);
  }

  // 이미 등록된 스트리머의 **부계정**인지, 아예 새 사람인지 갈라 본다.
  const existing = new Map(
    (await sql<{ channel_id: string; id: string; display_name: string }[]>`
      SELECT c.channel_id, s.id, s.display_name
        FROM streamer_channel c JOIN streamer s ON s.id = c.streamer_id
       WHERE c.platform = 'soop' AND c.active_to IS NULL
    `).map((r) => [r.channel_id, { id: r.id, name: r.display_name }]),
  );

  console.log(`=== FA 일치 ${hits.length}명 ===`);
  for (const h of hits) {
    const own = existing.get(h.fa.userId);
    console.log(
      `  ${h.riotId.padEnd(28)} → ${h.fa.userNick} (${h.fa.userId})`
      + `${own ? `  ※ 이미 등록된 '${own.name}' 의 다른 계정` : "  ※ 신규"}`
      + `  [내전 ${h.c.seen_count}회, 아는 사람 ${h.c.seen_with.length}명과]`,
    );
  }
  console.log(`\n=== FA 불일치 ${misses.length}명 — pending 유지 (사람이 본다) ===`);
  for (const m of misses.slice(0, 20)) {
    const name = m.game_name ? `${m.game_name}#${m.tag_line ?? "?"}` : m.puuid.slice(0, 12) + "…";
    console.log(`  ${name.padEnd(28)} 내전 ${m.seen_count}회 · 아는 사람 ${m.seen_with.length}명과`);
  }
  if (misses.length > 20) console.log(`  … 외 ${misses.length - 20}명`);

  if (!apply) {
    if (hits.length > 0) console.log(`\n실제로 등록하려면:  npm run candidates:identify -- --apply`);
    process.exit(0);
  }

  // ── 5. 적용 ────────────────────────────────────────────────────────
  let created = 0;
  let linked = 0;
  for (const h of hits) {
    const own = existing.get(h.fa.userId);
    const evidence = {
      source: "self_declared" as const,
      url: FA_PAGE,
      note: `SOOP 멸망전 FA 등록 시 본인이 입력한 라이엇 ID (시즌${SEASON}, ${today} 확인). `
        + `내전 ${h.c.seen_count}회에서 관측됨`,
    };
    // slug 은 소문자·숫자·하이픈만. SOOP 채널 아이디가 대문자를 쓰는 경우가 있다.
    const slug = h.fa.userId.toLowerCase().replace(/[^a-z0-9-]/g, "-");

    // ★ raw SQL 로 직접 INSERT 하지 않는다 — core 접근자를 경유한다.
    //   전에 여기서 streamer_account 를 직접 넣었다가 linkAccount() 가 하는
    //   **ingest_cursor 등록이 빠져서**, 이 경로로 연결된 계정이 백필 큐에
    //   영영 안 들어가는 사고가 났다(아키텍처 감사에서 발견). 백필은 시한부라
    //   그 구멍은 영구 손실이었다. 접근자에는 이런 부작용이 계약으로 붙어 있다.
    //
    //   한 트랜잭션이 아니게 된 것은 감수한다 — 전부 멱등 upsert 라 중간에
    //   끊겨도 다시 돌리면 아문다. 원자성보다 부작용 누락이 훨씬 비쌌다.
    let streamerId = own?.id;
    if (!streamerId) {
      const existing2 = await getStreamer(slug);
      if (existing2) {
        streamerId = existing2.id;
      } else {
        const created2 = await createStreamer({
          slug,
          display_name: h.fa.userNick,
          note: `SOOP 멸망전 FA 시즌${SEASON} 등록 · 내전 관측으로 발견 (${today})`,
        });
        streamerId = created2.id;
        created++;
      }
      await upsertStreamerChannel({
        streamer_id: streamerId,
        platform: "soop",
        channel_id: h.fa.userId,
        label: "본채널",
        is_primary: true,
      });
    }
    // riot_account 가 먼저 있어야 streamer_account 의 FK 가 선다.
    const hash2 = h.riotId.lastIndexOf("#");
    await upsertRiotAccount({
      puuid: h.c.puuid,
      game_name: h.riotId.slice(0, hash2),
      tag_line: h.riotId.slice(hash2 + 1),
    });
    // evidence 검증 + ingest_cursor(백필 큐) 등록까지 linkAccount 가 한다.
    await linkAccount({
      streamer_id: streamerId,
      puuid: h.c.puuid,
      label: h.riotId === h.fa.gameNick ? "본계" : "부계",
      confidence: "likely",
      evidence,
    });
    await setCandidateState(h.c.id, "approved");
    linked++;
  }

  console.log(`\n스트리머 생성 ${created}명 · 계정 연결 ${linked}건 · 후보 ${misses.length}명은 그대로 둔다`);
  console.log(`\n다음:  npm run worker -- derive     # 새 계정으로 과거 조우를 재파생한다`);
} finally {
  await closeDb();
}
