/**
 * FC온라인 Phase 0 실응답 점검. DB에는 쓰지 않고 gitignore 된 out/에 fixture만 남긴다.
 *
 *   npm run fco:probe -- --nickname "감독명"
 *   npm run fco:probe -- --nickname "감독명" --matchtypes 30,60 --limit 20
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { NexonClient } from "@soop-lol/core/lib/games/fconline/client";

function option(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function utcIso(raw: string): string | null {
  const explicitZone = /(?:Z|[+-]\d\d:?\d\d)$/u.test(raw);
  const normalized = raw.replace(" ", "T") + (explicitZone ? "" : "Z");
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const nickname = option("nickname")?.trim();
if (!nickname) {
  console.error('쓰는 법: npm run fco:probe -- --nickname "FC온라인 감독명" [--matchtypes 30,60] [--limit 20]');
  process.exit(1);
}
const apiKey = process.env.NEXON_API_KEY?.trim();
if (!apiKey) {
  console.error("NEXON_API_KEY가 없다. apps/web/.env.local에 넣어 주세요.");
  process.exit(1);
}
const matchTypes = (option("matchtypes") ?? "30,40,50,60")
  .split(",").map(Number).filter((value) => Number.isInteger(value) && value > 0);
const limit = Math.min(100, Math.max(1, Number(option("limit") ?? 20) || 20));

const client = new NexonClient({ apiKey });
const ouid = await client.ouidByNickname(nickname);
if (!ouid) {
  console.error(`감독명 '${nickname}'을 찾지 못했습니다.`);
  process.exit(2);
}

const basic = await client.userBasic(ouid);
const lists: Record<string, string[]> = {};
let selected: { matchType: number; matchId: string } | null = null;
for (const matchType of matchTypes) {
  const ids = await client.matchIds(ouid, matchType, 0, limit);
  lists[String(matchType)] = ids;
  if (!selected && ids[0]) selected = { matchType, matchId: ids[0] };
}

const detail = selected ? await client.matchDetail(selected.matchId) : null;
const participants = detail?.matchInfo ?? [];
const opponentOuidExposed = participants.some((player) => player.ouid && player.ouid !== ouid);
const fixture = {
  fetched_at: new Date().toISOString(),
  query: { nickname, match_types: matchTypes, limit },
  ouid,
  basic,
  match_lists: lists,
  selected,
  detail,
  observations: {
    participant_count: participants.length,
    opponent_ouid_exposed: opponentOuidExposed,
    match_date_raw: detail?.matchDate ?? null,
    match_date_as_documented_utc: detail ? utcIso(detail.matchDate) : null,
    // 시작/종료 여부는 응답 하나만으로 확정하지 않는다. VOD나 플레이 기록과 대조해야 한다.
    match_date_start_or_end: "unverified",
  },
};

const outputDir = join(process.cwd(), "out", "fconline");
await mkdir(outputDir, { recursive: true });
const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const output = join(outputDir, `${stamp}-fixture.json`);
await writeFile(output, JSON.stringify(fixture, null, 2) + "\n", "utf8");

console.log(`감독명 확인: ${basic?.nickname ?? nickname} · 레벨 ${basic?.level ?? "?"}`);
for (const matchType of matchTypes) console.log(`matchtype ${matchType}: ${lists[String(matchType)].length}건`);
if (detail) {
  console.log(`상세 확인: ${detail.matchId} · 참가자 ${participants.length}명 · 상대 OUID ${opponentOuidExposed ? "있음" : "없음"}`);
  console.log(`matchDate: ${detail.matchDate} (문서 기준 UTC → ${utcIso(detail.matchDate) ?? "해석 실패"})`);
} else {
  console.log("지정한 matchtype에서 상세를 확인할 경기를 찾지 못했습니다.");
}
console.log(`fixture 저장: ${output}`);
