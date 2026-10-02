/**
 * 판 목록이 쓰는 빌드 아이콘(아이템·소환사 주문·룬)을 Data Dragon 에서 받아 웹 앱과 함께 배포한다.
 * 버전은 champions.ko.json 과 같다. 한 번 받은 뒤 화면은 외부 CDN 을 요청하지 않는다(챔피언 아이콘과 같은 방식).
 *
 *   npm run sync:build-icons
 *
 * 만드는 것:
 *   apps/web/public/images/lol/item/<id>.png · spell/<id>.png · rune/<id>.png
 *   packages/core/lib/riot/build-icons.json   — 주문·룬의 숫자 id → 한글 이름(아이템은 이름만)
 */
import { access, mkdir, readFile, writeFile } from "node:fs/promises";

const { version } = JSON.parse(await readFile("packages/core/lib/riot/champions.ko.json", "utf8"));
const base = `https://ddragon.leagueoflegends.com/cdn/${version}`;
const get = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(`${url} ${r.status}`); return r; };

const items = (await (await get(`${base}/data/ko_KR/item.json`)).json()).data;
const spells = (await (await get(`${base}/data/ko_KR/summoner.json`)).json()).data;
const runes = await (await get(`${base}/data/ko_KR/runesReforged.json`)).json();

const jobs = [];
const out = { version, item: {}, spell: {}, rune: {} };
for (const [id, it] of Object.entries(items)) {
  out.item[id] = it.name;
  jobs.push([`${base}/img/item/${id}.png`, `item/${id}.png`]);
}
for (const sp of Object.values(spells)) {
  out.spell[sp.key] = sp.name;
  jobs.push([`${base}/img/spell/${sp.image.full}`, `spell/${sp.key}.png`]);
}
for (const style of runes) {
  out.rune[style.id] = style.name;
  jobs.push([`https://ddragon.leagueoflegends.com/cdn/img/${style.icon}`, `rune/${style.id}.png`]);
  for (const slot of style.slots) for (const r of slot.runes) {
    out.rune[r.id] = r.name;
    jobs.push([`https://ddragon.leagueoflegends.com/cdn/img/${r.icon}`, `rune/${r.id}.png`]);
  }
}

const root = "apps/web/public/images/lol";
for (const d of ["item", "spell", "rune"]) await mkdir(`${root}/${d}`, { recursive: true });
let fetched = 0;
async function worker() {
  for (;;) {
    const job = jobs.pop();
    if (!job) return;
    const [url, rel] = job;
    try { await access(`${root}/${rel}`); continue; } catch { /* 받는다 */ }
    await writeFile(`${root}/${rel}`, new Uint8Array(await (await get(url)).arrayBuffer()));
    fetched++;
  }
}
await Promise.all(Array.from({ length: 12 }, worker));
await writeFile("packages/core/lib/riot/build-icons.json", `${JSON.stringify(out, null, 1)}\n`);
console.log(`빌드 아이콘 — 새로 받음 ${fetched} · 아이템 ${Object.keys(out.item).length} · 주문 ${Object.keys(out.spell).length} · 룬 ${Object.keys(out.rune).length} · Data Dragon ${version}`);
