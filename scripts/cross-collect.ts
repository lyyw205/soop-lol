/**
 * **대회 로스터 전원의 방송을 모은다.** 교차검증의 전제 조건이다.
 *
 *   npm run ck:cross -- --event ck-leesangho-2026-07-09-kimmingyo
 *   npm run ck:cross -- --event meljang-2026-geng --pad 1
 *   npm run ck:cross -- --event ... --dry-run     # 누구를 돌릴지만 본다
 *
 * ★ 왜 스크립트로 만들었나 — 사람이 기억하면 반드시 빼먹는다
 *   "10명 로스터면 10명을 다 모은다" 를 규칙으로 정해 놓고, 스맵CK 한 번만
 *   지키고 그다음 CK 들에서 한 명만 돌리거나 아예 안 돌렸다. 그 결과:
 *
 *     스맵CK   로스터 7채널 수집 → **놓친 5세트를 되찾았다**(린다랑b 화면)
 *     교CK     김군 1채널만      → 1·2세트 결과창을 끝내 못 찾았다
 *     강만식CK 0채널             → 3세트를 대전기록으로만 때웠다
 *     서도일CK 0채널             → 2세트가 채팅 공지 하나뿐이다
 *
 *   한 채널만 보면 **그 채널이 알트탭한 판은 통째로 사라진다.** 같은 경기를
 *   평균 6명이 동시에 방송하므로, 한 명이 놓친 결과창은 대개 다른 사람에게 있다.
 *
 * ★ 무엇을 하나
 *   1. 대회(event)의 팀 명단을 읽어 **등록된 SOOP 채널을 전부** 뽑는다
 *   2. 대회 기간(±pad 일)에 대해 채널마다 `ck:collect` 를 돌린다
 *   3. 채널이 없는 선수는 **이름을 찍어서 알린다** — 조용히 빠지면 안 된다
 *
 * 그다음은 `ck:prep --per-session N` 으로 여러 시점의 결과창을 뽑는다.
 */

import { spawnSync } from "node:child_process";

import { closeDb, db } from "@soop-lol/core/lib/db/client";

import { makeOpt } from "./lib/cli.mjs";

const argv = process.argv.slice(2);
const opt = makeOpt(argv);
const DRY = argv.includes("--dry-run");
const EVENT = opt("--event", "");
/** 대회 기간 앞뒤로 며칠 더 볼지. 방송은 자정을 넘겨 이어지므로 기본 1일. */
const PAD = Number(opt("--pad", 1));

if (!EVENT) {
  console.error("대회 slug 를 달라:  npm run ck:cross -- --event <slug>");
  process.exit(1);
}

const sql = db();
try {
  const [ev] = await sql<{ id: string; name: string; from: string; to: string }[]>`
    SELECT id, name,
           ((coalesce(starts_at, now()) AT TIME ZONE 'Asia/Seoul')::date - ${PAD}::int)::text AS "from",
           ((coalesce(ends_at, starts_at, now()) AT TIME ZONE 'Asia/Seoul')::date + ${PAD}::int)::text AS "to"
      FROM event WHERE slug = ${EVENT}
  `;
  if (!ev) { console.error(`대회 '${EVENT}' 가 없다.`); process.exit(1); }

  const roster = await sql<{ name: string; display_name: string; channel_id: string | null }[]>`
    SELECT t.name, s.display_name, c.channel_id
      FROM event_team t
      JOIN event_team_member mm ON mm.event_team_id = t.id
      JOIN streamer s ON s.id = mm.streamer_id
      LEFT JOIN streamer_channel c
             ON c.streamer_id = s.id AND c.platform = 'soop' AND c.active_to IS NULL
     WHERE t.event_id = ${ev.id}
     ORDER BY t.name, s.display_name
  `;

  console.log(`${ev.name}`);
  console.log(`기간 ${ev.from} ~ ${ev.to} · 로스터 ${roster.length}명\n`);

  const channels = [...new Set(roster.map((r) => r.channel_id).filter((x): x is string => !!x))];
  const noChannel = roster.filter((r) => !r.channel_id);

  for (const r of roster) {
    console.log(`  ${r.name.padEnd(10)} ${r.display_name.padEnd(12)} ${r.channel_id ?? "⚠ SOOP 채널 미등록"}`);
  }
  // ★ 채널이 없는 사람을 조용히 넘기지 않는다. 그만큼 교차검증에 구멍이 남는다.
  if (noChannel.length > 0) {
    console.log(`\n⚠ 채널이 없어 못 보는 선수 ${noChannel.length}명 — ${noChannel.map((r) => r.display_name).join(", ")}`);
    console.log(`  그 사람 시점의 결과창은 못 구한다. 채널을 등록하면 다시 돌릴 수 있다.`);
  }
  console.log(`\n▸ 훑을 채널 ${channels.length}개${DRY ? "  (확인만)" : ""}\n`);
  if (DRY) process.exit(0);

  let ok = 0;
  for (const [i, ch] of channels.entries()) {
    console.log(`──── [${i + 1}/${channels.length}] ${ch} ────`);
    const r = spawnSync("npm", ["run", "ck:collect", "--", "--channel", ch,
      // ★ --date 는 확인 프레임 폴더 이름에만 쓰인다. 대회별로 갈라 둔다.
      "--date", `${ev.from}`, "--from", ev.from, "--to", ev.to,
      "--board-budget", "0", "--chat-budget", "0"], { stdio: "inherit" });
    if (r.status === 0) ok++;
    else console.error(`  ✖ ${ch} 실패 (exit ${r.status})`);
  }
  console.log(`\n채널 ${ok}/${channels.length} 완료. 다음:`);
  console.log(`  npm run ck:prep -- --date <날짜> --per-session 5`);
} finally {
  await closeDb();
}
