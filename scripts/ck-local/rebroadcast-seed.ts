/**
 * "남의 방송 화면" 판별기 학습용 정답을 DB 에서 뽑는다 — 사람·조사 세션이 이미 남긴 구조화된 표시를 쓴다.
 *
 *   node --env-file-if-exists=apps/web/.env.local scripts/ck-local/rebroadcast-seed.ts
 *   → out/ck-rebroadcast/labels.jsonl   {vod, at, label: "rebroadcast"|"own", channel, match_id, frame}
 *
 * ★ 정답: 시점 출처가 `rebroadcast`(남의 방송을 띄운 화면)인 시점의 근거 사진. 반대 사례: `own`(본인 클라이언트) 근거 사진.
 *   키워드로 관찰 글을 뒤지지 않는다("재송출 아님" 같은 반대 뜻이 섞인다). 정답은 시점 기록의 source 하나다.
 * ★ 썸네일 시트 목록(out/ck/<VOD>/local/sheets.json)이 있는 VOD 만 — 특징은 시트의 칸에서 계산한다.
 * ★ DB 에 쓰지 않는다. 판별기 설계와 정책: docs/CK-LOCAL-DETECTOR.md §21 (2026-10-09 사용자 결정 — 무관한 방송은 경기 근거 아님).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { closeDb, db } from "@soop-lol/core/lib/db/client";

const rows = await db()<{ vod: string; at: number; source: string; channel: string; match_id: string; frame: string }[]>`
  SELECT substring(l.source_key from 5) AS vod, f.at_sec::float8 AS at, p.source, l.channel_id AS channel, p.match_id, f.frame_path AS frame
    FROM match_pov p
    JOIN match_evidence_frame f ON f.lead_id = p.lead_id AND f.match_id = p.match_id
    JOIN event_lead l ON l.id = p.lead_id
   WHERE f.at_sec IS NOT NULL AND l.source_key LIKE 'vod:%'`;
await closeDb();
const out = rows
  .filter((r) => existsSync(`out/ck/${r.vod}/local/sheets.json`))
  .map((r) => ({ vod: Number(r.vod), at: r.at, label: r.source === "rebroadcast" ? "rebroadcast" : "own", channel: r.channel, match_id: r.match_id, frame: r.frame }));
mkdirSync("out/ck-rebroadcast", { recursive: true });
writeFileSync("out/ck-rebroadcast/labels.jsonl", out.map((r) => JSON.stringify(r)).join("\n") + "\n");
const count = (l: string) => out.filter((r) => r.label === l);
const vods = (xs: typeof out) => new Set(xs.map((r) => r.vod)).size;
const chans = (xs: typeof out) => new Set(xs.map((r) => r.channel)).size;
console.log(`남의 방송 ${count("rebroadcast").length}장(VOD ${vods(count("rebroadcast"))} · 채널 ${chans(count("rebroadcast"))}) · `
  + `본인 화면 ${count("own").length}장(VOD ${vods(count("own"))} · 채널 ${chans(count("own"))}) → out/ck-rebroadcast/labels.jsonl`);
