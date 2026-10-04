/**
 * 멸망전 나무위키의 **참가 팀 투표 순위** 표를 읽어 event_team.vote_rank 와 시드 파일(team_vote_ranks)에 넣는다.
 *
 *   node --env-file-if-exists=apps/web/.env.local scripts/fill-vote-ranks.mjs --all            # 미리보기
 *   node --env-file-if-exists=apps/web/.env.local scripts/fill-vote-ranks.mjs --all --apply    # 쓴다
 *
 * 2025 시즌2 부터 멸망전은 참가 신청 팀 전부를 유저 투표로 줄 세운다(상위 팀 본선 직행·예선 이점).
 * 문서의 「투표 결과별 배치」 표 — `투표 순위 | TEAM | TOP | … | 결과` 뒤로 `N위 | 팀명 | …` 행이 온다.
 * 표가 없는 회차는 건너뛴다(투표가 없었거나 문서에 없다 — 지어내지 않는다).
 * 시드 파일에도 적는 이유: seed:tournament 가 team_vote_ranks 로 같은 칸을 덮는다(없으면 NULL 로).
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { db, closeDb } from "@soop-lol/core/lib/db/client";
import { saveVoteRanks } from "@soop-lol/core/lib/db/tournaments";

import { namuUrl, normTeam } from "./lib/namu.mjs";
import { SEASONS } from "./meljang-seasons.mjs";

const APPLY = process.argv.includes("--apply");
const keys = process.argv.includes("--all")
  ? Object.keys(SEASONS).filter((k) => SEASONS[k].namu?.length)
  : process.argv.slice(2).filter((a) => !a.startsWith("--"));
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 「투표 순위」(또는 「득표 순위」) 표의 `N위 | 팀명` 행. 같은 팀이 두 번 나오면 먼저 본 것. */
export function parseVoteTable(html) {
  const tokens = html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, "\n").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#91;/g, "[").replace(/&#93;/g, "]")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .split("\n").map((s) => s.trim()).filter(Boolean);
  const start = tokens.findIndex((t, i) => /^(투표|득표) 순위$/.test(t) && tokens.slice(i + 1, i + 4).includes("TEAM"));
  if (start < 0) return null;
  const ranks = {};
  for (let i = start + 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (/^\d+(\.\d+)*\.$/.test(t) || t === "[편집]") break;   // 다음 절
    const m = /^(\d+)위$/.exec(t);
    if (!m) continue;
    let j = i + 1;
    // 각주([4])·표식(#·@)은 칸이 아니다
    while (j < tokens.length && (/^[#@*]$/.test(tokens[j]) || /^\[\d+\]$/.test(tokens[j]))) j++;
    const team = tokens[j];
    if (team && !(team in ranks)) ranks[team] = Number(m[1]);
  }
  return Object.keys(ranks).length ? ranks : null;
}

const sql = db();
try {
  for (const [i, key] of keys.entries()) {
    if (i) await sleep(1500);
    const [event] = await sql`SELECT id FROM event WHERE slug = ${key} AND game_code = 'lol'`;
    if (!event) continue;
    const title = SEASONS[key].namu[0];
    const html = await (await fetch(namuUrl(title), { headers: { "User-Agent": UA } })).text();
    const raw = parseVoteTable(html);
    if (!raw) { console.log(`· ${key}: 투표 순위 표 없음`); continue; }
    // 문서 표기 → DB 팀명(공백 등 표기 흔들림을 정규화로 맞춘다)
    const teams = await sql`SELECT name FROM event_team WHERE event_id = ${event.id}`;
    const byNorm = new Map(teams.map((t) => [normTeam(t.name), t.name]));
    const ranks = {}, unmatched = [];
    // 표기 흔들림: 정규화로 먼저, 안 되면 한 글자 차이(편집 거리 1)로 유일하게 맞는 팀 — 그건 따로 보고한다
    const dist = (a, b) => {
      const d = Array.from({ length: a.length + 1 }, (_, x) => [x, ...Array(b.length).fill(0)]);
      for (let y = 1; y <= b.length; y++) d[0][y] = y;
      for (let x = 1; x <= a.length; x++) for (let y = 1; y <= b.length; y++)
        d[x][y] = Math.min(d[x - 1][y] + 1, d[x][y - 1] + 1, d[x - 1][y - 1] + (a[x - 1] === b[y - 1] ? 0 : 1));
      return d[a.length][b.length];
    };
    const fuzzy = [];
    for (const [team, rank] of Object.entries(raw)) {
      let name = byNorm.get(normTeam(team));
      if (!name) {
        const near = [...byNorm].filter(([k]) => k.length >= 3 && dist(k, normTeam(team)) === 1);
        if (near.length === 1) { name = near[0][1]; fuzzy.push(`${team}→${name}`); }
      }
      if (name && !(name in ranks)) ranks[name] = rank; else if (!name) unmatched.push(`${rank}위 ${team}`);
    }
    if (fuzzy.length) console.log(`    표기 한 글자 차이로 맞춘 팀: ${fuzzy.join(", ")}`);
    console.log(`${APPLY ? "✓" : "·"} ${key}: 투표 순위 ${Object.keys(ranks).length}팀` + (unmatched.length ? ` · DB 에 없는 팀 ${unmatched.length}(${unmatched.slice(0, 4).join(", ")})` : ""));
    if (!APPLY) { console.log(`    ${Object.entries(ranks).sort((a, b) => a[1] - b[1]).slice(0, 6).map(([t, r]) => `${r}위 ${t}`).join(" · ")} …`); continue; }
    await saveVoteRanks(event.id, ranks);
    const file = `seed/tournaments-${key}.json`;
    if (existsSync(file)) {
      const doc = JSON.parse(readFileSync(file, "utf8"));
      const t = Array.isArray(doc) ? doc[0] : doc;
      t.team_vote_ranks = { ...(t.team_vote_ranks ?? {}), ...ranks };
      writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
    } else console.log(`    ⚠ 시드 파일 ${file} 이 없다 — 재시드 때 지워질 수 있다`);
  }
} finally {
  await closeDb();
}
