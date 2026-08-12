/**
 * 매일 자동 수집할 스트리머를 정한다.
 *
 *   npm run watch                        # 지금 걸린 명단을 본다
 *   npm run watch -- --add 김민교 이상호 저라뎃
 *   npm run watch -- --add-file seed/watchlist.txt
 *   npm run watch -- --remove 저라뎃
 *   npm run watch -- --clear
 *   npm run watch -- --suggest 60        # 애청자 상위 N 명을 제안만 한다
 *
 * ★ 왜 전부를 안 도나
 *   등록된 스트리머가 418명인데 매일 전부 훑으면 SOOP 에 하루 수천 번 요청하고
 *   시간도 몇 분씩 걸린다. **대형 스트리머 50~60명만** 자동으로 훑는다.
 *
 * ★ 그런데 참가자는 명단 밖도 전부 남긴다
 *   watch 는 "누구를 훑을까"이지 "누구를 기록할까"가 아니다. 훑은 방송에서
 *   나온 참가자는 등록 여부와 상관없이 `event_lead_participant` 에 **채널 아이디로**
 *   남는다. 나중에 그 사람이 등록되면 과거 기록이 통째로 이어진다.
 *
 * ★ 이름은 여러 방식으로 받는다
 *   표시명·slug·SOOP 채널 아이디 다 된다. 애매하면(둘 이상 걸리면) 넣지 않고
 *   뭐가 걸렸는지 보여준다 — 엉뚱한 사람을 조용히 넣는 것보다 낫다.
 */

import { closeDb, db } from "@soop-lol/core/lib/db/client";
import { readFileSync } from "node:fs";

import { fanCount } from "./lib/soop-vod.mjs";

const argv = process.argv.slice(2);
const after = (flag: string): string[] => {
  const i = argv.indexOf(flag);
  if (i < 0) return [];
  const out: string[] = [];
  for (let j = i + 1; j < argv.length && !argv[j].startsWith("--"); j++) out.push(argv[j]);
  return out;
};

const sql = db();
try {
  const suggest = argv.indexOf("--suggest");
  if (suggest >= 0) {
    const n = Number(argv[suggest + 1] ?? 60);
    const writeTo = after("--write")[0];

    // ★ 애청자 수를 **실시간으로 받는다.** note 에 적힌 값을 쓰면 안 된다 —
    //   그건 FA 로 들어온 325명에만 있고, 원래 있던 93명(이상호·김민교 등)은
    //   비어 있어서 정렬이 통째로 편향된다. 실제로 872,965명인 이상호가
    //   상위 20에서 빠졌다.
    const chans = await sql<{ display_name: string; slug: string; channel_id: string; watch: boolean }[]>`
      SELECT s.display_name, s.slug, s.watch, c.channel_id
        FROM streamer s
        JOIN streamer_channel c ON c.streamer_id = s.id AND c.platform = 'soop' AND c.active_to IS NULL
       ORDER BY s.display_name`;
    console.log(`${chans.length}개 채널의 애청자 수를 받는다 (SOOP 방송국 API)…`);

    // ★ 병렬로 돌리지 않는다. lib/soop-http 가 호스트별로 직렬화하므로 Promise.all
    //   로 감싸 봐야 실제 나가는 속도는 같고, 코드만 복잡해진다.
    //   418채널 × 400ms ≈ 3분. 이 명령은 명단을 정할 때만 쓰니 그 정도는 괜찮다.
    const rows: { display_name: string; slug: string; watch: boolean; fan: number | null }[] = [];
    let done = 0;
    for (const c of chans) {
      // 애청자 수는 lib 의 fanCount 가 단일 출처다 (UA 요구·null 규약 포함).
      const fan: number | null = await fanCount(c.channel_id);
      rows.push({ display_name: c.display_name, slug: c.slug, watch: c.watch, fan });
      if (++done % 100 === 0) console.log(`  ${done}/${chans.length}`);
    }

    rows.sort((a, b) => (b.fan ?? -1) - (a.fan ?? -1));
    const top = rows.slice(0, n);
    console.log(`\n애청자 상위 ${top.length}명 (확보 ${rows.filter((r) => r.fan !== null).length}/${rows.length})\n`);
    for (const [i, r] of top.entries()) {
      console.log(`${String(i + 1).padStart(3)}  ${String(r.fan ?? "?").padStart(8)}  ${r.watch ? "✓" : " "}  ${r.display_name}`);
    }
    if (writeTo) {
      // slug 로 적는다 — 표시명은 공백·특수문자가 섞여 파일에서 다루기 나쁘다.
      const body = top.map((r) => `${r.slug}\t# ${r.display_name} · 애청자 ${r.fan ?? "?"}`).join("\n");
      const { writeFileSync } = await import("node:fs");
      writeFileSync(writeTo, `# 매일 훑을 명단 (애청자 상위 ${n})\n${body}\n`);
      console.log(`\n${writeTo} 에 적었다. 손으로 고친 뒤:\n  npm run watch -- --add-file ${writeTo}`);
    } else {
      console.log(`\n파일로 만들려면:  npm run watch -- --suggest ${n} --write seed/watchlist.txt`);
    }
    process.exit(0);
  }

  if (argv.includes("--clear")) {
    const r = await sql`UPDATE streamer SET watch = false WHERE watch RETURNING id`;
    console.log(`${r.length}명을 명단에서 뺐다.`);
  }

  // --add-file 은 slug 또는 표시명 한 줄에 하나.
  //
  // ★ `#` 를 무조건 주석으로 치면 안 된다 — **표시명에 `#` 가 들어간다.**
  //   `#민찬기`, `＃김동하`, `항상#킴성태` 가 실제로 있다. 통째로 잘라내면
  //   그 사람만 조용히 빠지고, 60명 넣었는데 59명이 되는 식으로 티도 안 난다.
  //   그래서 주석은 **탭 뒤** 또는 **공백+#** 로만 인정한다.
  const stripComment = (line: string) => {
    if (/^#\s/.test(line)) return "";                  // 파일 머리말
    const body = line.includes("\t") ? line.slice(0, line.indexOf("\t")) : line.replace(/\s+#.*$/, "");
    return body.trim();
  };
  const names = [
    ...after("--add"),
    ...after("--add-file").flatMap((f) =>
      readFileSync(f, "utf8").split("\n").map(stripComment).filter(Boolean)),
  ];
  const removes = after("--remove");

  for (const [list, on] of [[names, true], [removes, false]] as const) {
    for (const raw of list) {
      // 표시명 · slug · SOOP 채널 아이디 셋 다 받는다.
      const hits = await sql<{ id: string; display_name: string; slug: string }[]>`
        SELECT DISTINCT s.id, s.display_name, s.slug
          FROM streamer s
          LEFT JOIN streamer_channel c ON c.streamer_id = s.id AND c.active_to IS NULL
         WHERE s.display_name = ${raw} OR s.slug = ${raw} OR c.channel_id = ${raw}
      `;
      if (hits.length === 0) { console.log(`  ✖ ${raw} — 등록된 스트리머가 아니다`); continue; }
      if (hits.length > 1) {
        // 조용히 하나를 고르지 않는다. 엉뚱한 사람을 넣으면 그게 매일 돈다.
        console.log(`  ⚠ ${raw} — ${hits.length}명이 걸린다: ${hits.map((h) => `${h.display_name}(${h.slug})`).join(", ")}`);
        continue;
      }
      await sql`UPDATE streamer SET watch = ${on} WHERE id = ${hits[0].id}::uuid`;
      console.log(`  ${on ? "＋" : "－"} ${hits[0].display_name} (${hits[0].slug})`);
    }
  }

  const now = await sql<{ display_name: string; slug: string; channel_id: string | null }[]>`
    SELECT s.display_name, s.slug, c.channel_id
      FROM streamer s
      LEFT JOIN streamer_channel c ON c.streamer_id = s.id AND c.platform = 'soop' AND c.active_to IS NULL
     WHERE s.watch
     ORDER BY s.display_name
  `;
  console.log(`\n=== 매일 훑을 명단 ${now.length}명 ===`);
  for (const r of now) console.log(`  ${r.display_name.padEnd(16)} ${r.slug.padEnd(18)} ${r.channel_id ?? "(채널 없음)"}`);
  const noChannel = now.filter((r) => !r.channel_id);
  if (noChannel.length > 0) {
    console.log(`\n⚠ 채널이 없어 훑을 수 없는 ${noChannel.length}명: ${noChannel.map((r) => r.display_name).join(", ")}`);
  }
  if (now.length === 0) console.log("  (비어 있다 — --add 로 넣어라)");
} finally {
  await closeDb();
}
