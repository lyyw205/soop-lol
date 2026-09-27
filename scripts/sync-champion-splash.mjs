/**
 * 챔피언 스플래시 아트를 웹 앱과 함께 배포한다. 개인 프로필 카드의 배경이 이 그림이다.
 *
 *   npm run sync:champion-splash
 *
 * ★ 왜 CDN 을 그대로 쓰지 않나
 *   sync-champion-icons.mjs 와 같은 이유다 — 화면 렌더가 외부 호스트에 매달리면
 *   Data Dragon 이 느린 날 카드가 통째로 비어 보인다. 한 번 받아 두고 로컬에서 낸다.
 *
 * ★ 왜 쓰는 것만 받지 않나
 *   "누가 무슨 챔피언을 제일 많이 했나" 는 경기가 쌓일 때마다 바뀐다. 그때마다 그림이
 *   없어서 배경이 빠지는 것보다, 아이콘처럼 전부 받아 두는 편이 단순하다.
 *   파일은 git 에 넣지 않는다(아이콘과 같다) — 이 스크립트가 언제든 다시 만든다.
 *
 * ⚠ 스플래시는 버전 없는 경로(`cdn/img/champion/splash`)다. 아이콘과 달리 버전이
 *   섞이지 않으므로 champions.ko.json 의 version 을 쓰지 않는다.
 */
import { access, mkdir, readFile, writeFile } from "node:fs/promises";

const table = JSON.parse(await readFile("packages/core/lib/riot/champions.ko.json", "utf8"));
const target = "apps/web/public/images/champion-splash";
await mkdir(target, { recursive: true });

const missing = [];
for (const champion of table.champions) {
  try { await access(`${target}/${champion.en}.jpg`); }
  catch { missing.push(champion); }
}

let complete = table.champions.length - missing.length;
const failed = [];
async function worker() {
  for (;;) {
    const champion = missing.pop();
    if (!champion) return;
    const url = `https://ddragon.leagueoflegends.com/cdn/img/champion/splash/${champion.en}_0.jpg`;
    const response = await fetch(url);
    // 스플래시가 없는 항목은 건너뛰고 이름을 남긴다 — 하나 때문에 전체를 멈추지 않는다.
    if (!response.ok) { failed.push(`${champion.en}(${response.status})`); continue; }
    await writeFile(`${target}/${champion.en}.jpg`, new Uint8Array(await response.arrayBuffer()));
    complete++;
  }
}
await Promise.all(Array.from({ length: 8 }, worker));
console.log(`챔피언 스플래시 ${complete}/${table.champions.length}장 → ${target}`);
if (failed.length) console.log(`못 받은 것 ${failed.length}개: ${failed.join(", ")}`);
