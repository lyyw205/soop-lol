/**
 * 현재 champions.ko.json 버전의 Data Dragon 아이콘을 웹 앱과 함께 배포한다.
 * 한 번 동기화한 뒤 화면에서는 외부 CDN을 요청하지 않는다.
 *
 *   npm run sync:champion-icons
 */
import { access, mkdir, readFile, writeFile } from "node:fs/promises";

const table = JSON.parse(await readFile("packages/core/lib/riot/champions.ko.json", "utf8"));
const target = "apps/web/public/images/champions";
await mkdir(target, { recursive: true });

const missing = [];
for (const champion of table.champions) {
  try { await access(`${target}/${champion.en}.png`); }
  catch { missing.push(champion); }
}

let complete = table.champions.length - missing.length;
async function worker() {
  while (missing.length) {
    const champion = missing.pop();
    if (!champion) return;
    const url = `https://ddragon.leagueoflegends.com/cdn/${table.version}/img/champion/${champion.en}.png`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${champion.en}: Data Dragon ${response.status}`);
    await writeFile(`${target}/${champion.en}.png`, new Uint8Array(await response.arrayBuffer()));
    complete++;
  }
}
await Promise.all(Array.from({ length: 12 }, worker));
console.log(`챔피언 아이콘 ${complete}개 · Data Dragon ${table.version} → ${target}`);
