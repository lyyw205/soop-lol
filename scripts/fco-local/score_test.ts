/**
 * FC 5단계 검증 채점 — 화면만 보고 찾은 경기(out/fco-test/<vod>.screen.json)를 넥슨 API 정답과 맞춘다. 읽기만 한다.
 *   node --env-file-if-exists=apps/web/.env.local scripts/fco-local/score_test.ts 207333649 …
 * 맞춤 규칙은 저장 도구(screen.ts compareMatches)와 같다: 종료 시각 ±3분 + 두 닉네임(정규화) + 스코어.
 */
import { existsSync, readFileSync } from "node:fs";
import { db, closeDb } from "@soop-lol/core/lib/db/client";
import { vodDetail } from "../lib/soop-vod.mjs";
import { normalizeName } from "@soop-lol/core/lib/games/fconline/screen";

const sql = db();
let T = { api: 0, found: 0, exact: 0, wrongScore: 0, wrongName: 0, extra: 0 };
for (const vod of process.argv.slice(2).map(Number)) {
  const d = await vodDetail(vod);
  const startMs = Date.parse(`${String(d.broad_start).replace(" ", "T")}+09:00`);
  const lenSec = Math.round(Number(d.total_file_duration) / 1000);
  const ch = d.bj_id ?? d.user_id;
  const api = await sql<{ pid: string; t: Date; parts: { n: string; s: number | null }[] }[]>`
    SELECT d.provider_match_id pid, m.game_creation t,
      (SELECT json_agg(json_build_object('n', p.nickname, 's', coalesce(p.score_display, p.goals)) ORDER BY p.side_no) FROM fco_match_participant p WHERE p.match_id = m.match_id) parts
      FROM match m JOIN fco_match_detail d ON d.match_id = m.match_id
     WHERE m.source = 'provider_api' AND m.game_creation BETWEEN ${new Date(startMs)} AND ${new Date(startMs + lenSec * 1000)}
       AND EXISTS (SELECT 1 FROM fco_match_participant p JOIN streamer_channel c ON c.streamer_id = p.streamer_id AND c.channel_id = ${ch} WHERE p.match_id = m.match_id)`;
  const f = `out/fco-test/${vod}.screen.json`;
  const got: { at_sec: number; sides: { nickname: string; score: number | null }[] }[] = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : [];
  const used = new Set<number>();
  console.log(`\n## ${vod} (${ch}) API 경기 ${api.length} · 화면에서 읽은 경기 ${got.length}`);
  for (const a of api.sort((x, y) => +x.t - +y.t)) {
    const endSec = Math.round((+a.t - startMs) / 1000);
    const ix = got.findIndex((g, i) => !used.has(i) && Math.abs(g.at_sec - endSec) <= 180);
    T.api++;
    if (ix < 0) { console.log(`  ✗ 못 찾음  종료 ${endSec}s  ${a.parts.map((p) => `${p.n} ${p.s}`).join(" : ")}`); continue; }
    used.add(ix); T.found++;
    const g = got[ix];
    const key = (n: string) => normalizeName(n);
    const apiBy = new Map(a.parts.map((p) => [key(p.n), p.s]));
    const namesOk = g.sides.every((s) => apiBy.has(key(s.nickname)));
    const scoreOk = namesOk && g.sides.every((s) => s.score == null || apiBy.get(key(s.nickname)) === s.score);
    if (namesOk && scoreOk) T.exact++; else if (!namesOk) T.wrongName++; else T.wrongScore++;
    console.log(`  ${namesOk && scoreOk ? "✓" : "△"} 종료 ${endSec}s ↔ 화면 ${g.at_sec}s (${g.at_sec - endSec >= 0 ? "+" : ""}${g.at_sec - endSec}s)  API ${a.parts.map((p) => `${p.n} ${p.s}`).join(" : ")}  | 읽음 ${g.sides.map((s) => `${s.nickname} ${s.score ?? "?"}`).join(" : ")}`);
  }
  got.forEach((g, i) => { if (!used.has(i)) { T.extra++; console.log(`  + API 에 없는 경기 ${g.at_sec}s  ${g.sides.map((s) => `${s.nickname} ${s.score ?? "?"}`).join(" : ")}`); } });
  const o = existsSync(`out/fco-test/${vod}.out.json`) ? JSON.parse(readFileSync(`out/fco-test/${vod}.out.json`, "utf8")) : null;
  if (o) console.log(`  비용 $${o.total_cost_usd?.toFixed(2)} · ${(o.duration_ms / 60000).toFixed(1)}분 · 턴 ${o.num_turns}`);
}
console.log(`\n합계: API 경기 ${T.api} · 찾음 ${T.found} (${Math.round(100 * T.found / Math.max(T.api, 1))}%) · 이름·스코어 다 맞음 ${T.exact} · 스코어 틀림 ${T.wrongScore} · 이름 불일치 ${T.wrongName} · API 에 없는 경기 ${T.extra}`);
await closeDb();
