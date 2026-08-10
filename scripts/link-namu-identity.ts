/**
 * 대회 로스터의 **나무위키 인물 문서**를 스트리머에 붙인다.
 *
 *   npm run link:namu            # 붙인다
 *   npm run link:namu -- --dry-run
 *
 * ★ 왜 필요한가
 *   옛 회차 로스터는 표기가 제각각이다 — '이상호'·'BJ이상호'·'탈론장인이상호'.
 *   SOOP 검색으로는 못 가른다. '이상호' 를 찾으면 lshooooo(이상호) 와 tlshtkw(이상호^) 가
 *   같이 나오고, 'BJ이상호' 를 찾으면 아예 다른 두 사람이 나온다. 그래서 포기하고 있었다.
 *
 *   그런데 나무위키 로스터 셀은 인물 문서로 링크돼 있고, 위 세 표기가 전부
 *   `/w/이상호` 하나로 링크된다. **출처가 직접 동일인이라고 말하는 것**이다.
 *
 * ★ 어떻게 붙이나
 *   이 스크립트는 **이미 확인된 스트리머에만** 문서를 붙인다.
 *   표기 → 방송국 아이디(SOOP 검색) → 우리 DB 에 있는 스트리머, 이 경로로 확정된
 *   사람의 문서만 기록한다. 문서에서 사람을 만들어내지 않는다.
 *
 *   그 다음부터 빌더가 "이 문서 = 이 스트리머" 를 알게 되므로, 같은 문서로 링크된
 *   다른 표기(BJ이상호 …)도 이어붙일 수 있다.
 */

import { closeDb, db } from "@soop-lol/core/lib/db/client";
import { setNamuPage } from "@soop-lol/core/lib/db/streamers";

import { fetchPersonLinks, fetchRosters } from "./lib/namu.mjs";
import { SEASONS } from "./meljang-seasons.mjs";

const dryRun = process.argv.includes("--dry-run");
const SEARCH = "https://sch.sooplive.co.kr/api.php";

const stripDeco = (s: string) =>
  s.replace(/^BJ\s*/i, "").replace(/[♥♡★☆♬♪~!?:;,*`'"^_.\-\s]/g, "").toLowerCase();

async function search(q: string): Promise<{ user_id: string; user_nick: string }[]> {
  const url = `${SEARCH}?m=bjSearch&v=3.0&szOrder=&szKeyword=${encodeURIComponent(q)}&nPageNo=1&nListCnt=20`;
  try {
    const r = await fetch(url, { headers: { Referer: "https://www.sooplive.co.kr/" } });
    if (!r.ok) return [];
    return ((await r.json()) as { DATA?: { user_id: string; user_nick: string }[] })?.DATA ?? [];
  } catch {
    return [];
  }
}

/** 표기 → 방송국 아이디. 유일하게 좁혀질 때만 (build-meljang 과 같은 규칙). */
async function channelId(nick: string): Promise<string | null> {
  const exact = (await search(nick)).filter((x) => x.user_nick === nick);
  if (exact.length === 1) return exact[0].user_id;
  const key = stripDeco(nick);
  if (!key) return null;
  const near = (await search(key)).filter((x) => stripDeco(x.user_nick) === key);
  return near.length === 1 ? near[0].user_id : null;
}

const sql = db();
try {
  const slugByChannel = new Map(
    (
      await sql<{ channel_id: string; slug: string; id: string }[]>`
        SELECT c.channel_id, s.slug, s.id
          FROM streamer_channel c JOIN streamer s ON s.id = c.streamer_id
      `
    ).map((r) => [r.channel_id, { slug: r.slug, id: r.id }] as const),
  );
  const already = new Map(
    (await sql<{ namu_page: string; slug: string }[]>`
      SELECT namu_page, slug FROM streamer WHERE namu_page IS NOT NULL
    `).map((r) => [r.namu_page, r.slug]),
  );

  let linked = 0;
  let skipped = 0;
  const conflicts: string[] = [];

  for (const [key, season] of Object.entries(SEASONS)) {
    const [links, rosters] = await Promise.all([
      fetchPersonLinks(season.namu[0]),
      fetchRosters(season.namu[0]),
    ]);
    if (!rosters) continue;

    // 로스터에 실제로 이름이 오른 사람만 본다 — 본문 아무 데나 걸린 링크는 쓰지 않는다.
    const inRoster = new Set(Object.values(rosters).flat().filter(Boolean) as string[]);
    for (const [nick, page] of links) {
      if (!inRoster.has(nick)) continue;
      if (already.has(page)) { skipped++; continue; }

      const ch = await channelId(nick);
      await new Promise((s) => setTimeout(s, 250));
      if (!ch) continue;
      const target = slugByChannel.get(ch);
      if (!target) continue;

      if (dryRun) {
        console.log(`  [dry] ${page.padEnd(24)} ← ${nick} (${key}) → ${target.slug}`);
      } else if (await setNamuPage(target.id, page)) {
        console.log(`  ${page.padEnd(24)} ← ${nick} (${key}) → ${target.slug}`);
      } else {
        // 문서가 남의 것이거나, 이 스트리머가 이미 다른 문서를 갖고 있거나 — 둘 다 충돌이다.
        // 어느 쪽이든 한쪽은 틀린 연결이라 사람이 봐야 한다. 덮어쓰지 않는다.
        conflicts.push(`${page} ↔ ${target.slug} 가 어긋난다 (표기 '${nick}', ${key})`);
        continue;
      }
      already.set(page, target.slug);
      linked++;
    }
  }

  console.log(`\n연결 ${linked}건 · 이미 있어 건너뜀 ${skipped}건${dryRun ? "  (dry-run)" : ""}`);
  if (conflicts.length > 0) {
    console.log(`\n⚠ 충돌 ${conflicts.length}건 — 한 문서를 두 스트리머가 다투면 둘 중 하나가 틀린 것이다:`);
    for (const c of conflicts) console.log(`   ${c}`);
  }
} catch (e) {
  console.error(`\n실패: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
