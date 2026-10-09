import { writeFileSync } from "node:fs";
const UA = (await import("node:fs")).readFileSync("packages/core/lib/games/fconline/club/site-client.ts","utf8").match(/USER_AGENT\s*=\s*"([^"]+)"/)[1];
const H = { "User-Agent": UA, "X-Requested-With": "XMLHttpRequest" };
const r = await fetch("https://fconline.nexon.com/profile/common/PopProfile?strCharacterName=" + encodeURIComponent("저창FC"), { headers: H });
const t = await r.text();
writeFileSync(process.argv[2] + "/pop.html", t);
console.log(r.status, r.url, t.length);
for (const m of t.matchAll(/SetSquadInfo[\s\S]{0,40}|SquadGetUserInfo[\s\S]{0,200}|\$\.ajax\([\s\S]{0,300}/g)) console.log("---", m[0].replace(/\s+/g," ").slice(0,300));
const scripts = [...t.matchAll(/<script[^>]+src="([^"]+)"/g)].map(m=>m[1]); console.log("scripts:", scripts.join(" "));
