/**
 * SOOP 멸망전 **FA 등록**에서 시드 명단을 만든다. 인지도(애청자 수) 순으로 정렬한다.
 *
 *   node --env-file-if-exists=apps/web/.env.local scripts/build-soop-fa.mjs
 *   node ... scripts/build-soop-fa.mjs --top 100        # 상위 100명만
 *   node ... scripts/build-soop-fa.mjs --min-fan 20000  # 애청자 2만 이상만
 *   node ... scripts/build-soop-fa.mjs --all            # 이미 등록된 사람도 포함(갱신용)
 *
 * ★ 왜 FA 인가
 *   스트리머가 **대회 참가 신청 때 본인 손으로 입력한 라이엇 ID** 다. 제출 시점에
 *   SOOP 이 Riot 으로 실존 검증까지 한다. 전적 사이트를 긁지 않고(§11-9) 근거를
 *   남길 수 있는(§11-2) 유일한 대량 경로다. evidence.source = 'self_declared'.
 *
 * ★ 왜 애청자 수로 정렬하나
 *   명단을 다 넣을 수는 있어도 **검증은 위에서부터** 하게 된다. 어차피 순서가
 *   필요하면 그 순서는 관측값이어야 한다. SOOP 방송국 API 의 `fan_cnt` 가
 *   SOOP 자신이 세는 애청자 수다 — 우리가 지어낸 점수가 아니다.
 *
 *   FA 의 `bjmatchPoint` 를 쓰지 않는 이유: 그건 **체급(실력)** 이고 인지도가 아니다.
 *   대회 밸런스용 점수라 인지도 정렬에 쓰면 뜻이 어긋난다.
 *
 * ★ 라이엇 ID 는 여기서 해석하지 않는다
 *   SOOP 표기가 라이엇 정본과 어긋난다(태그 공백, 게임명 공백 수). 해석은
 *   `seed-streamers.ts` 가 account-v1 으로 한다 — 정본은 항상 Riot 이다.
 */

import { closeDb, db } from "@soop-lol/core/lib/db/client";
import { writeFileSync } from "node:fs";

import { kstDate, makeOpt } from "./lib/cli.mjs";
import { faPageUrl, fetchFaList } from "./lib/soop-fa.mjs";
import { fanCount } from "./lib/soop-vod.mjs";

const argv = process.argv.slice(2);
const flag = makeOpt(argv);
const SEASON = Number(flag("--season", 27));
const TOP = Number(flag("--top", 0)) || Infinity;
const MIN_FAN = Number(flag("--min-fan", 0));
const ALL = argv.includes("--all");
const OUT = flag("--out", `seed/streamers-soop-fa-${SEASON}.json`);

// 사람이 보는 페이지. evidence.url 이 된다 — 나중에 누가 봐도 출처를 되짚을 수 있어야 한다.
const FA_PAGE = faPageUrl(SEASON);
const today = kstDate();

const fa = await fetchFaList(SEASON);
if (fa.length === 0) {
  console.error(`seasonIdx=${SEASON} 에 FA 등록이 없다. 열려 있는 건 현재 시즌뿐이다.`);
  process.exit(1);
}
console.log(`FA 시즌 ${SEASON} — ${fa.length}명`);


const sql = db();
const known = new Set(
  (await sql`
    SELECT channel_id FROM streamer_channel
     WHERE platform = ${"soop"} AND active_to IS NULL
  `).map((r) => r.channel_id),
);
console.log(`우리 DB 에 이미 있는 SOOP 채널 ${known.size}개`);

// 방송국 API 를 418번 부른다. 남의 서버다 — 간격은 lib/soop-http 가 건다(직렬).
const rows = [];
let done = 0;
for (const f of fa) {
  rows.push({ fa: f, fan: await fanCount(f.userId) });
  if (++done % 100 === 0) console.log(`  애청자 조회 ${done}/${fa.length}`);
}
rows.sort((a, b) => (b.fan ?? -1) - (a.fan ?? -1));

const picked = rows
  .filter((r) => ALL || !known.has(r.fa.userId))
  .filter((r) => (r.fan ?? 0) >= MIN_FAN)
  .slice(0, TOP);

// ★ fan(애청자 수)을 시드 항목과 **같은 배열에** 들고 간다. 전에는 seed 와 picked 를
//   같은 인덱스로 섞어 읽었는데, 계정 없는 항목이 seed 에서만 걸러지면 그 뒤 줄의
//   애청자 수가 전부 남의 값으로 찍혔다(적대 리뷰에서 발견).
const seedWithFan = picked.map(({ fa: f, fan }) => ({ fan, item: ({
  // slug 은 소문자·숫자·하이픈만 허용된다. SOOP 채널 아이디가 대문자를 쓰는 경우가 있다.
  slug: f.userId.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
  display_name: f.userNick,
  platform: "soop",
  channel_id: f.userId,
  channel_url: `https://ch.sooplive.co.kr/${f.userId}`,
  note: fan === null
    ? `SOOP 멸망전 FA 시즌${SEASON} 등록 (애청자 수 미확인)`
    : `SOOP 멸망전 FA 시즌${SEASON} 등록 · 애청자 ${fan.toLocaleString("ko-KR")}명 (${today} 기준)`,
  accounts: (f.totalGameNickList ?? []).map((riotId, i) => ({
    riot_id: riotId,
    // 첫 번째가 FA 의 대표 계정(gameNick)이다. 그 이상은 순서만 알 뿐이라 라벨을 붙이지 않는다.
    is_main: riotId === f.gameNick,
    label: riotId === f.gameNick ? "본계" : `계정${i + 1}`,
    // 본인이 직접 입력했지만 우리가 방송에서 확인한 건 아니다 — 'verified' 로 올리지 않는다.
    confidence: "likely",
    evidence: {
      source: "self_declared",
      url: FA_PAGE,
      note: `SOOP 멸망전 FA 등록 시 본인이 입력한 라이엇 ID (시즌${SEASON}, ${today} 확인)`,
    },
  })),
}) })).filter((x) => x.item.accounts.length > 0);
const seed = seedWithFan.map((x) => x.item);

writeFileSync(OUT, `${JSON.stringify(seed, null, 2)}\n`);

const gotFan = rows.filter((r) => r.fan !== null).length;
console.log(
  `\n애청자 수 확보 ${gotFan}/${rows.length}`
  + ` · ${ALL ? "전체" : "미등록"} 중 ${seed.length}명을 ${OUT} 에 적었다`,
);
console.log(`\n상위 15명 (파일 순서 = 인지도 순)`);
for (const [i, x] of seedWithFan.slice(0, 15).entries()) {
  console.log(
    `${String(i + 1).padStart(3)}  ${String(x.fan ?? "?").padStart(7)}  `
    + `${x.item.display_name.padEnd(16)} ${x.item.accounts.map((a) => a.riot_id).join(", ")}`,
  );
}
console.log(`\n다음:  npm run seed -- ${OUT} --dry-run`);

await closeDb();
