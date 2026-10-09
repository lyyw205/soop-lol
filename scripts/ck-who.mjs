/**
 * **판독한 이름을 사람·챔피언으로 되짚는다.** 정확히 없으면 **가까운 것**을 내놓는다.
 *
 *   npm run ck:who -- 난벌레팡이다 붕어에옹 달리아
 *
 * ── 왜 퍼지여야 하는가 ────────────────────────────────────────────────
 * 결과 화면의 한글은 작아서 **한 글자씩 틀린다.** 2026-08-19 조사(30단서)에서
 * 조회 0건이 난 이름 9개를 뒤늦게 확대해 고쳐 읽었는데, **전부 편집거리 2 이내**였다:
 *
 *   난벌레팡이다 → 난벌레곰팡이다(1) · 붕어에옹 → 붕어에몽(1) · 바드앵용 → 바뜨엥용(2)
 *   똥딴지구독점yo → 뚱딴지구독점yo(1) · 뒈레이 → 둬레이(1) · 떼깔룩 → 떼껄룩(1)
 *   사나이목직한주먹 → 사나이묵직한주먹(1) · 달리아 → 탈리야(2) · 라산드라 → 리산드라(1)
 *
 * 그중 **여섯은 진짜 사람**이었다. 정확 일치만 봤으면 "미등록" 으로 버렸을 것이다.
 * 그래서 0건일 때 "없다" 가 아니라 **"이거 아니냐"** 를 돌려준다.
 *
 * ⚠ 후보는 답이 아니다. **확대해서 확인하고** 쓴다(SKILL.md 7단계).
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";

import { closeDb, db } from "@soop-lol/core/lib/db/client";
import { kstDateString } from "@soop-lol/core/lib/time";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const MAX = Number((process.argv.find((a) => a.startsWith("--max=")) ?? "--max=2").slice(6));
if (args.length === 0) {
  console.error("쓰기:  npm run ck:who -- <인게임명|챔피언> ...   [--max=2]");
  process.exit(1);
}

/** 공백·구두점만 지운다. 그 이상 뭉개면 다른 사람이 붙는다. */
const norm = (s) => String(s ?? "").normalize("NFKC").replace(/[\s\-_.]+/gu, "").toLowerCase();

/**
 * ★ 결과 화면은 **긴 이름을 잘라서** `꼬우면여물고니가탱…` 처럼 보여준다.
 * 잘린 이름은 편집거리로는 절대 안 잡힌다 — 뒤가 통째로 없으니 거리가 10 을 넘는다.
 * 2026-08-21 조사에서 `꼬우면여물고니가탱` 이 "가까운 것도 없다" 로 나왔는데
 * 실제로는 등록된 `꼬우면여물고니가탱커해띠발럼들아#칼챔해뿔라`(정현민)였다.
 * 그래서 **앞부분 일치**를 따로 본다.
 */
const stripEllipsis = (s) => String(s ?? "").replace(/[.\u2026\u22ef]+$/u, "");

/**
 * 한글을 자모로 편다. **글자 단위 거리만으로는 순위가 안 갈린다** —
 * '달리아' 에서 '탈리야'(정답)와 '갈리오'가 똑같이 거리 2 라 id 순으로 밀려
 * 정답이 목록 밖으로 나갔다. 자모로 보면 `달→탈` 은 초성 하나(ㄷ↔ㅌ)만 다르고
 * `달→질` 은 초성+중성이 다르다. 눈으로 잘못 읽는 건 대개 **자모 하나**다.
 */
const CHO = 588, JUNG = 28, BASE = 0xac00;
const jamo = (s) => [...s].flatMap((ch) => {
  const c = ch.codePointAt(0) - BASE;
  if (c < 0 || c > 11171) return [ch];
  const t = c % JUNG;
  return t === 0 ? [c / CHO | 0, (c % CHO) / JUNG | 0] : [c / CHO | 0, (c % CHO) / JUNG | 0, t];
}).map(String);

/** 표준 편집거리. 이름이 짧아 O(nm) 으로 충분하다. */
function dist(a, b) {
  if (a.length === b.length && [...a].every((c, i) => c === b[i])) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

const sql = db();
/** 사람 후보 — 인게임명이 제일 강하고, 표시명·별명도 같이 본다. */
const people = new Map();   // 정규화 문자열 → [{kind, raw, slug, name}]
const push = (key, v) => {
  const k = norm(key);
  if (!k) return;
  if (!people.has(k)) people.set(k, []);
  people.get(k).push(v);
};
for (const r of await sql`
  SELECT ra.game_name, ra.tag_line, s.slug, s.display_name
    FROM riot_account ra
    LEFT JOIN streamer_account sa ON sa.puuid = ra.puuid
    LEFT JOIN streamer s ON s.id = sa.streamer_id`) {
  push(r.game_name, { kind: "인게임", raw: `${r.game_name}#${r.tag_line}`, slug: r.slug, name: r.display_name });
}
/**
 * ★ **앞선 조사에서 `unlinked_account` 로 확정한 이름도 본다.**
 * `riot_account` 에는 태그를 몰라 안 넣은 계정이 많다 — 그건 시드의 `unlinked_accounts`
 * 에만 남는다. 2026-08-21 에 `임팡벌레` 를 세 대회에서 '미등록' 으로 버렸는데,
 * 2026-04-01 시드에 이미 **임아니**로 확정돼 있었다. 같은 실수를 막는다.
 */
const seedFiles = existsSync("seed") ? readdirSync("seed").filter((f) => f.startsWith("tournaments-") && f.endsWith(".json")) : [];
const bySlug = new Map();
const seedSeen = new Set();
for (const r of await sql`SELECT slug, display_name FROM streamer`) bySlug.set(r.slug, r.display_name);
for (const f of seedFiles) {
  let doc;
  try { doc = JSON.parse(readFileSync(`seed/${f}`, "utf8")); } catch { continue; }
  for (const ev of Array.isArray(doc) ? doc : [doc]) {
    const take = (slug, name) => {
      if (!slug || !name) return;
      const key = `${slug}|${norm(name)}`;
      if (seedSeen.has(key)) return;          // 같은 매핑이 여러 시드에 있다 — 한 번만 보여준다
      seedSeen.add(key);
      push(name, { kind: "시드", raw: name, slug, name: bySlug.get(slug) ?? slug });
    };
    for (const [slug, name] of Object.entries(ev.unlinked_accounts ?? {})) take(slug, name);
    for (const g of ev.games ?? []) {
      for (const arr of Object.values(g.lineup ?? {})) {
        for (const e of arr ?? []) take(e.slug, e.unlinked_account);
      }
    }
  }
}

for (const r of await sql`SELECT slug, display_name, aliases FROM streamer`) {
  push(r.display_name, { kind: "표시명", raw: r.display_name, slug: r.slug, name: r.display_name });
  for (const a of r.aliases ?? []) push(a, { kind: "별명", raw: a, slug: r.slug, name: r.display_name });
}

/** 같은 사람이 이 이름으로 이미 잡혀 있으면 덧붙이지 않는다 — 계정·표시명이 더 센 근거다. */
const pushNew = (key, v) => {
  if ((people.get(norm(key)) ?? []).some((x) => x.slug && x.slug === v.slug)) return;
  push(key, v);
};
/**
 * ★ **옛 닉네임**(0083). 매일 갱신이 riot_account 의 이름을 덮어써서, 백필로 옛 VOD 를 보면
 *   화면엔 그때 이름이 나오는데 DB 엔 지금 이름만 있었다. 바뀐 뒤 기록된 이름을 따로 본다.
 */
for (const r of await sql`
  SELECT n.game_name, n.tag_line, n.replaced_at, s.slug, s.display_name
    FROM riot_account_name n
    LEFT JOIN streamer_account sa ON sa.puuid = n.puuid AND sa.active_to IS NULL
    LEFT JOIN streamer s ON s.id = sa.streamer_id
   WHERE n.replaced_at IS NOT NULL`) {
  pushNew(r.game_name, { kind: "옛 인게임", raw: `${r.game_name}${r.tag_line ? `#${r.tag_line}` : ""} ~${kstDateString(r.replaced_at)}`, slug: r.slug, name: r.display_name });
}
/**
 * ★ **이미 사람이 붙은 자리의 화면 이름.** 2026-10-09 '말하는감자' 가 98자리나 채니로 붙어 있었는데
 *   조사 세션은 그걸 못 보고 미확인으로 남겼다 — 태그를 몰라 계정이 없는 이름은 여기에만 기록이 있다.
 *   ('듀부선' 도 화면에서 64자리를 듀단에 붙였지만 다음 조사가 몰랐다.) 한 이름이 여러 사람에게
 *   붙어 있으면 전부 보여준다 — 그 자체가 확인할 거리다.
 */
for (const r of await sql`
  SELECT mp.observed_name, s.slug, s.display_name, count(*)::int AS seats
    FROM match_participant mp JOIN streamer s ON s.id = mp.streamer_id
   WHERE mp.observed_name IS NOT NULL
   GROUP BY 1, 2, 3`) {
  pushNew(r.observed_name, { kind: "연결된 자리", raw: `${r.observed_name} ${r.seats}자리`, slug: r.slug, name: r.display_name });
}
await closeDb();

/** 챔피언 — seed:tournament 가 거부하기 전에 여기서 잡는다. */
const champs = JSON.parse(readFileSync("packages/core/lib/riot/champions.ko.json", "utf8")).champions;
const champByNorm = new Map(champs.map((c) => [norm(c.name), c]));

console.log(`사람 ${people.size}종 · 챔피언 ${champs.length}종 · 편집거리 ${MAX} 까지 본다\n`);

for (const q of args) {
  const k = norm(stripEllipsis(q));
  const exactP = people.get(k) ?? [];
  const exactC = champByNorm.get(k);

  /**
   * 잘린 이름 후보. 3 글자부터 본다 — `진철수` 가 등록 계정 `진철수아빠`(진성준짱)의
   * 앞부분인데 4 글자 문턱에 걸려 안 잡혔다. 2 글자는 아무 데나 걸려서 안 본다.
   */
  const prefixP = [];
  if (k.length >= 3 && !exactP.length) {
    for (const [key, vs] of people) {
      if (key.length > k.length && key.startsWith(k)) for (const v of vs) prefixP.push(v);
    }
  }
  if (prefixP.length > 0) {
    console.log(`▸ ${q}  — **잘린 이름**이다. 앞부분이 이것과 맞는다`);
    for (const v of prefixP.slice(0, 8)) {
      console.log(`    ${v.slug ?? "(매핑없음)"} ${v.name ?? ""} [${v.kind} ${v.raw}]`);
    }
    if (prefixP.length > 1) console.log(`    ⚠ 후보가 ${prefixP.length} 개다 — 하나로 안 좁혀지면 로스터에서 뺀다.`);
    continue;
  }

  // ★ 한쪽만 정확히 맞아도 **다른 쪽 후보는 계속 찾는다.**
  //   결과 화면은 이름 칸과 챔피언 칸이 위아래로 붙어 있어 어느 쪽을 읽은 건지 헷갈린다 —
  //   실제로 '조이.'(사람 쪼이.)가 챔피언 '조이' 에 정확히 맞아 사람 검색이 통째로 건너뛰어졌다.
  if (exactP.length > 0 && exactC) {
    const bits = [];
    for (const p of exactP) bits.push(`${p.slug ?? "(매핑없음)"} ${p.name ?? ""} [${p.kind} ${p.raw}]`);
    bits.push(`챔피언 ${exactC.name} (id ${exactC.id})`);
    console.log(`✓ ${q}  — 사람·챔피언 **둘 다** 정확히 맞는다. 문맥으로 골라라\n    ${bits.join("\n    ")}`);
    continue;
  }
  if (exactP.length > 0 || exactC) {
    const bits = [];
    for (const p of exactP) bits.push(`${p.slug ?? "(매핑없음)"} ${p.name ?? ""} [${p.kind} ${p.raw}]`);
    if (exactC) bits.push(`챔피언 ${exactC.name} (id ${exactC.id})`);
    console.log(`✓ ${q}\n    ${bits.join("\n    ")}`);
    // 맞은 쪽 말고 **반대쪽**의 가까운 후보를 덧붙인다.
    const other = [];
    if (exactC && exactP.length === 0) {
      for (const [key, vs] of people) {
        const d = dist(k, key);
        if (d > 0 && d <= MAX) for (const v of vs) other.push({ d, j: dist(jamo(k), jamo(key)), txt: `${v.slug ?? "(매핑없음)"} ${v.name ?? ""} [${v.kind} ${v.raw}]` });
      }
      other.sort((a, b) => a.d - b.d || a.j - b.j);
      if (other.length > 0) {
        console.log(`  · 사람 쪽 가까운 후보 ${Math.min(other.length, 5)}/${other.length} — 이름 칸을 읽은 거라면 이쪽이다`);
        for (const n of other.slice(0, 5)) console.log(`    거리 ${n.d}·자모 ${n.j}  ${n.txt}`);
      }
    }
    if (exactP.length > 0 && !exactC) {
      for (const [key, c] of champByNorm) {
        const d = dist(k, key);
        if (d > 0 && d <= MAX) other.push({ d, j: dist(jamo(k), jamo(key)), txt: `${c.name} (id ${c.id})` });
      }
      other.sort((a, b) => a.d - b.d || a.j - b.j);
      if (other.length > 0) {
        console.log(`  · 챔피언 쪽 가까운 후보 ${Math.min(other.length, 5)}/${other.length} — 챔피언 칸을 읽은 거라면 이쪽이다`);
        for (const n of other.slice(0, 5)) console.log(`    거리 ${n.d}·자모 ${n.j}  ${n.txt}`);
      }
    }
    continue;
  }

  // ── 정확히 없다. 가까운 것을 찾는다 ──────────────────────────────
  //
  // ★ 사람과 챔피언을 **따로 센다.** 한 통에 넣고 상위 N 개만 보이면 사람 후보가
  //   챔피언을 밀어낸다 — 실제로 '달리아' 를 넣었을 때 정답 '탈리야'(거리 2)가
  //   거리 2 짜리 사람 이름 다섯에 밀려 안 보였다. 결과 화면에서 이름 칸과
  //   챔피언 칸은 위아래로 붙어 있어 **어느 쪽을 읽은 건지 헷갈리는 게 정상**이다.
  const nearP = [];
  for (const [key, vs] of people) {
    const d = dist(k, key);
    if (d <= MAX) for (const v of vs) nearP.push({ d, j: dist(jamo(k), jamo(key)), txt: `${v.slug ?? "(매핑없음)"} ${v.name ?? ""} [${v.kind} ${v.raw}]` });
  }
  const nearC = [];
  for (const [key, c] of champByNorm) {
    const d = dist(k, key);
    if (d <= MAX) nearC.push({ d, j: dist(jamo(k), jamo(key)), txt: `${c.name} (id ${c.id})` });
  }
  nearP.sort((a, b) => a.d - b.d || a.j - b.j);
  nearC.sort((a, b) => a.d - b.d || a.j - b.j);

  if (nearP.length === 0 && nearC.length === 0) {
    console.log(`✖ ${q}\n    가까운 것도 없다 — 정말 미등록이거나 크게 잘못 읽었다.`);
    continue;
  }
  console.log(`~ ${q}  — 정확히는 없다.`);
  if (nearP.length > 0) {
    console.log(`  사람 후보 ${Math.min(nearP.length, 8)}/${nearP.length}`);
    for (const n of nearP.slice(0, 8)) console.log(`    거리 ${n.d}·자모 ${n.j}  ${n.txt}`);
  }
  if (nearC.length > 0) {
    console.log(`  챔피언 후보 ${Math.min(nearC.length, 8)}/${nearC.length}`);
    for (const n of nearC.slice(0, 8)) console.log(`    거리 ${n.d}·자모 ${n.j}  ${n.txt}`);
  }
  console.log(`    ⚠ 후보일 뿐이다. **프레임을 확대해서 확인하고** 쓴다.`);
}
