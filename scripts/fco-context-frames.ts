/**
 * FC 화면 경기 검수용 — 결과 화면 앞뒤의 **원본 프레임**을 미리 뽑아 둔다.
 *
 *   npm run fco:frames -- --dry-run                      # 몇 장을 뽑을지만 센다 (아무것도 안 받는다)
 *   npm run fco:frames                                   # 전부 뽑는다 (이미 있는 프레임은 건너뛴다 — 끊겨도 다시 돌리면 이어진다)
 *   npm run fco:frames -- --vod 205798765                # 한 VOD 만
 *   npm run fco:frames -- --offsets=-120,-60,-20,20,60,120
 *
 * ★ 왜 미리 뽑나 (실측 2026-10-02): 썸네일 칸(192×108)을 키우면 닉네임·점수를 못 읽고, 즉석 추출은 1장 5.4초라 검수에 못 쓴다.
 *   한 VOD 를 묶어 뽑으면 장당 약 1.5초(6장 8.9초, 장당 약 6MB 내려받기) — 검수 전에 한 번 돌려 두면 화면은 즉시 뜬다.
 * ★ 뽑기는 `ck:probe --at` 그대로다(같은 이름 `out/ck/<VOD>/g<초 7자리>.jpg`, 있으면 건너뜀). DB 는 읽기만 한다.
 * ★★ 조사 기록 파일은 건드리지 않는다. ck:probe 는 그 VOD 의 probe.json 에 뽑은 프레임을 합쳐 적는데, 롤 병합(ck:merge)은
 *   probe.json 의 프레임을 "뽑았지만 안 읽은 근거"로 그 리드에 등록한다. 검수용 앞뒤 프레임이 거기 섞이면 같은 VOD 를
 *   롤로 조사할 때 롤 검수에 수십 장이 "메모 없음"으로 끼어든다. 그래서 ck:probe 전에 probe.json·scan-draft.latest.json 을
 *   잡아 두었다가 끝나면 그대로 되돌린다(2026-10-02 처음 돌렸을 때 28개 VOD 의 probe.json 에 섞였고, 정리했다).
 * ★ 공유 잠금(out/ck/auto/.lock)은 이 스크립트가 잡지 않는다 — 매일 자동 조사와 겹치게 하지 않으려면 `flock -n out/ck/auto/.lock npm run fco:frames` 로 돌린다.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { closeDb, db } from "../packages/core/lib/db/client.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1)
  ?? (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const dryRun = args.includes("--dry-run");
const onlyVod = flag("--vod");
const offsets = (flag("--offsets") ?? "-120,-60,-20,20,60,120").split(",").map((x) => Math.round(Number(x.trim())));
if (offsets.some((n) => !Number.isFinite(n) || n === 0)) { console.error("--offsets 는 0 이 아닌 초 값을 쉼표로 적는다 (예: -120,-60,20,60)"); process.exit(1); }
if (onlyVod && !/^\d+$/.test(onlyVod)) { console.error("--vod 는 숫자"); process.exit(1); }

const frameName = (sec: number) => `g${String(sec).padStart(7, "0")}.jpg`;

/**
 * VOD 길이(초) — 방송 끝을 넘는 지점은 요청하지 않는다(끝 직전 결과 화면의 +1·+2분은 영상 밖이다).
 * probe.json 의 total_sec(HLS 실측) → 썸네일 시트 목록 순으로 읽고, 둘 다 없으면 모른다(null — 자르지 않는다).
 */
function vodLength(vod: string): number | null {
  try {
    const p = JSON.parse(readFileSync(join("out", "ck", vod, "probe.json"), "utf8")) as { total_sec?: number };
    if (typeof p.total_sec === "number" && p.total_sec > 0) return p.total_sec;
  } catch { /* 다음 */ }
  try {
    const sh = JSON.parse(readFileSync(join("out", "ck", vod, "local", "sheets.json"), "utf8")) as { parts?: { offset: number; length: number }[] };
    const end = Math.max(...(sh.parts ?? []).map((x) => x.offset + x.length));
    if (Number.isFinite(end) && end > 0) return Math.floor(end);
  } catch { /* 모른다 */ }
  return null;
}

try {
  const sql = db();
  const rows = await sql<{ match_id: string }[]>`
    SELECT match_id FROM match
     WHERE game_code = 'fconline' AND source = 'manual' AND origin = 'vod_scan' AND match_id LIKE 'fcs:%'`;
  const byVod = new Map<string, number[]>();
  for (const { match_id } of rows) {
    const m = /^fcs:(\d+)@(\d+)$/.exec(match_id);
    if (!m || (onlyVod && m[1] !== onlyVod)) continue;
    byVod.set(m[1], [...(byVod.get(m[1]) ?? []), Number(m[2])]);
  }

  let want = 0, have = 0;
  const plan: { vod: string; secs: number[] }[] = [];
  for (const [vod, ats] of [...byVod].sort((a, b) => Number(a[0]) - Number(b[0]))) {
    const length = vodLength(vod);
    const secs = [...new Set(ats.flatMap((at) => offsets.map((o) => at + o)).filter((s) => s >= 0 && (length == null || s < length)))].sort((a, b) => a - b);
    const missing = secs.filter((s) => !existsSync(join("out", "ck", vod, frameName(s))));
    want += secs.length; have += secs.length - missing.length;
    if (missing.length) plan.push({ vod, secs: missing });
  }
  const todo = plan.reduce((n, p) => n + p.secs.length, 0);
  console.log(`VOD ${byVod.size}개 · 필요한 프레임 ${want}장 · 이미 있음 ${have} · 새로 뽑을 것 ${todo}장 (${plan.length}개 VOD)`
    + ` · 예상 ${Math.round((todo * 1.5 + plan.length * 5) / 60)}분 · 내려받기 약 ${(todo * 6 / 1024).toFixed(1)}GB`);
  if (dryRun || !todo) process.exit(0);

  let done = 0, failed = 0;
  for (const [i, p] of plan.entries()) {
    const t0 = Date.now();
    // 조사 기록 파일을 잡아 둔다 — 없던 파일이면 끝나고 지운다.
    // scan-draft.json 은 없을 때 ck:probe 가 새로 만든다(있으면 latest 로 비킨다) — 셋 다 원래대로 둔다.
const records = ["probe.json", "scan-draft.json", "scan-draft.latest.json"].map((name) => {
      const path = join("out", "ck", p.vod, name);
      return { path, before: existsSync(path) ? readFileSync(path) : null };
    });
    try {
      execFileSync("node", ["scripts/ck-probe.mjs", "--vod", p.vod, "--at", p.secs.join(",")], { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60_000 });
    } catch (e) {
      failed++;
      console.log(`  ⚠ ${p.vod} 실패 — ${String((e as Error).message).split("\n")[0].slice(0, 100)}`);
    } finally {
      for (const r of records) {
        if (r.before) writeFileSync(r.path, r.before);
        else rmSync(r.path, { force: true });
      }
    }
    const got = p.secs.filter((s) => existsSync(join("out", "ck", p.vod, frameName(s)))).length;
    done += got;
    console.log(`  [${i + 1}/${plan.length}] VOD ${p.vod}: ${got}/${p.secs.length}장 (${Math.round((Date.now() - t0) / 1000)}초)`);
  }
  console.log(`끝 — 뽑은 ${done}장 / 못 뽑은 ${todo - done}장 · 실패한 VOD ${failed}개`);
  process.exitCode = failed || todo - done > todo * 0.2 ? 1 : 0;
} finally {
  await closeDb();
}
