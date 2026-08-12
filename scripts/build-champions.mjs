/**
 * 챔피언 **한글 이름 → 챔피언 ID** 표를 만든다. Riot 공식 Data Dragon 이 원천이다.
 *
 *   npm run build:champions
 *
 * ★ 왜 필요한가
 *   내전은 Riot API 로 조회가 안 돼서 방송 **결과 화면을 읽어** 넣는다. 화면에는
 *   한글 이름만 나온다("자르반 4세", "미스 포츈"). 그런데 DB 는 champion_id 를 받는다.
 *
 * ★ 왜 손으로 안 적나
 *   실제로 적어 보려다 '제리' 를 895 로 쓸 뻔했다. 정답은 221 이다.
 *   챔피언 ID 는 규칙이 없어서 외울 수 있는 종류가 아니고, 한 글자 틀리면
 *   조용히 다른 챔피언 전적이 된다. 사람이 손댈 자리가 아니다.
 *
 * ★ Data Dragon 은 Riot 공식 정적 CDN 이다
 *   §11-9(타 사이트 자동 수집 금지)는 op.gg·lolsoop 같은 **경쟁 전적 사이트**를 말한다.
 *   Riot 이 이 용도로 공개한 자산을 쓰는 건 그 금지의 대상이 아니다.
 *   그래도 **한 번 받아 커밋한다** — 매번 부르면 남의 서비스에 기대는 셈이고,
 *   버전이 올라가며 이름이 바뀌면 우리 전적이 소리 없이 흔들린다.
 */

import { writeFileSync } from "node:fs";

const versions = await (await fetch("https://ddragon.leagueoflegends.com/api/versions.json")).json();
const version = process.argv[2] ?? versions[0];
const res = await fetch(`https://ddragon.leagueoflegends.com/cdn/${version}/data/ko_KR/champion.json`);
if (!res.ok) { console.error(`Data Dragon ${res.status} — 버전 ${version}`); process.exit(1); }
const data = (await res.json()).data;

const champs = Object.values(data)
  .map((c) => ({ id: Number(c.key), name: c.name, en: c.id }))
  .sort((a, b) => a.id - b.id);

if (champs.length < 150) { console.error(`챔피언이 ${champs.length}명뿐이다 — 응답 형태 변경 의심. 만들지 않는다.`); process.exit(1); }

const out = {
  "//": "자동 생성물이다. 손으로 고치지 마라 — npm run build:champions 로 다시 만든다.",
  version,
  generated_from: `https://ddragon.leagueoflegends.com/cdn/${version}/data/ko_KR/champion.json`,
  champions: champs,
};
writeFileSync("packages/core/lib/riot/champions.ko.json", `${JSON.stringify(out, null, 2)}\n`);
console.log(`챔피언 ${champs.length}명 · Data Dragon ${version} → packages/core/lib/riot/champions.ko.json`);
