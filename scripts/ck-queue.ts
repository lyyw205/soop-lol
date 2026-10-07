/**
 * 매일 와치리스트 조사의 대상 — **채널마다 이전에 조사한 다음부터 오늘까지** (2026-10-08 개편).
 *
 *   npm run ck:queue                               # 롤 대상 표만 본다
 *   npm run ck:queue -- plan --write <q.json> --state <s.json>
 *   npm run ck:queue -- fc --write <q.json> --state <s.json>      # FC: 맥락 미조사 API 경기가 있는 스트리머
 *   npm run ck:queue -- snapshot --key vod:<번호>|fc:<slug> --state <s.json>
 *   npm run ck:queue -- settle   --key vod:<번호>|fc:<slug> --state <s.json>   # 0 진척 · 4 진척 없음
 *
 * `scripts/ck-auto.sh`(매일 아침 타이머)가 부른다. DB 에는 쓰지 않는다 — 상태는 --state 파일 하나다.
 *
 * ★ 매일 조사와 백필은 다른 일이다
 *   매일 조사 = 와치리스트 채널의 새 VOD 를 빠짐없이 따라간다. 백필 = 사용자가 정한 과거 기간을 메운다.
 *   예전엔 "최근 3일 + 기간 밖 running 전부" 를 집어서 ① PC·타이머가 3일 넘게 쉬면 그 사이 VOD 가 영영
 *   빠졌고(9/28~10/8 공백이 그렇게 생겼다) ② 백필이 보류한 VOD 까지 매 회차 다시 열었다.
 *   그래서 대상은 **채널의 "마지막으로 조사를 끝낸 VOD" 이후**이고, 백필의 running 은 줍지 않는다.
 *   매일 조사가 손댔다 못 끝낸 VOD 만 상태 파일(pending)로 기억해 다음 날 잇는다.
 *
 * ★ 완료 판정은 `vodWork`(core/metrics/ck-vod-status) 하나다 — 백필과 같은 함수라 한쪽이 끝낸 VOD 를
 *   다른 쪽이 다시 보지 않는다. 카테고리로 거르지 않는다(토크로 켜고 내전하는 방송이 있다).
 * ★ 마지막 조사 지점이 아주 오래면(기본 14일 넘게) 그 앞은 자르고 경고한다 — 그건 백필 몫이다.
 * ★ 같은 대상이 세 번 연속 진척 없이 끝나면 건너뛴다(stall). 진척이 생기면 횟수를 지운다.
 * ★ FC 는 API 맥락 판정만 한다 — 넥슨 API 가 최근 30일 경기를 이미 안다. 대상은 그 30일 안의
 *   맥락 '미조사' 경기가 있는 와치리스트 FC 스트리머다. 화면으로 경기를 새로 읽는 일(30일 이전)은 백필 몫이다.
 * ★ 조회가 잘리면 시끄럽게 말하고 종료 코드 2 를 낸다.
 */

import { listWatched } from "@soop-lol/core/lib/db/watchlist";
import { closeDb, db } from "@soop-lol/core/lib/db/client";
import { listFcoContextQueue } from "@soop-lol/core/lib/games/fconline/context";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { kstDate, makeOpt } from "./lib/cli.mjs";
import { CK_RECENT_DAYS, recentFrom, titleExclusion, vodWork, type VodReason } from "@soop-lol/core/lib/metrics/ck-vod-status";
import { kstDateString } from "@soop-lol/core/lib/time";
import { listBroadcasts } from "./lib/soop-vod.mjs";

const argv = process.argv.slice(2);
const COMMAND = argv[0] && !argv[0].startsWith("--") ? argv[0] : "plan";
const opt = makeOpt(argv);
const WRITE = opt("--write", "");
const STATE_PATH = opt("--state", "");
const KEY = opt("--key", "");
const MAX_LOOKBACK = Number(opt("--max-lookback-days", "14"));
const STALL_LIMIT = Number(opt("--stall-limit", "3"));
const FC_DAYS = 30;
const TODAY = kstDate(0);

interface State {
  /** 매일 조사가 손댔지만 아직 안 끝난 VOD — 마지막 조사 지점과 상관없이 다음 날 잇는다. */
  pending: Record<string, { channel_id: string; since: string }>;
  /** 연속 진척 없음 횟수. STALL_LIMIT 에 닿으면 건너뛴다. */
  stall: Record<string, { count: number; last: string }>;
  /** 세션 직전의 지문(snapshot). settle 이 비교한다. */
  snap: Record<string, string>;
}
function loadState(): State {
  const empty: State = { pending: {}, stall: {}, snap: {} };
  if (!STATE_PATH || !existsSync(STATE_PATH)) return empty;
  return { ...empty, ...JSON.parse(readFileSync(STATE_PATH, "utf8")) };
}
function saveState(s: State) {
  if (!STATE_PATH) return;
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}
function writeOut(payload: unknown) {
  if (!WRITE) return;
  mkdirSync(dirname(WRITE), { recursive: true });
  writeFileSync(WRITE, JSON.stringify(payload, null, 2));
  console.log(`\n${WRITE} 에 적었다.`);
}
const stalled = (s: State, key: string) => (s.stall[key]?.count ?? 0) >= STALL_LIMIT;

interface Item {
  key: string; title_no: number; channel_id: string; streamer: string; slug: string;
  title: string; ended_at: string; hours: number; category: string | null; reason: VodReason;
}

const sql = db();

/** 롤: 채널마다 마지막으로 조사를 끝낸 VOD 이후 + 매일 조사가 남긴 pending. */
async function plan(): Promise<number> {
  const state = loadState();
  const watch = (await listWatched("lol")).filter((w) => {
    if (!w.channel_id) console.log(`⚠ 채널이 없어 못 훑는다: ${w.display_name}`);
    return !!w.channel_id;
  });
  const channels = watch.map((w) => w.channel_id!);

  // 마지막 조사 지점 = 조사 도장이 있고 vodWork 가 할 일 없음으로 보는 VOD 중 가장 늦은 것.
  const scanned = await sql<{ source_key: string; channel_id: string; observed_at: Date; raw: Record<string, any> }[]>`
    SELECT source_key, channel_id, observed_at, raw FROM event_lead
     WHERE source = 'vod_title' AND channel_id = ANY(${channels}) AND raw ? 'scan'`;
  const mark = new Map<string, Date>();
  for (const l of scanned) {
    if (vodWork(l.raw, null).reason !== null) continue;
    const prev = mark.get(l.channel_id);
    if (!prev || l.observed_at > prev) mark.set(l.channel_id, l.observed_at);
  }

  const floor = kstDate(MAX_LOOKBACK);
  const truncated: string[] = [], clipped: string[] = [];
  const found: (Omit<Item, "reason" | "key"> & { duration_sec: number | null })[] = [];
  for (const w of watch) {
    const last = mark.get(w.channel_id!);
    let from = last ? kstDateString(last) : recentFrom(new Date(), CK_RECENT_DAYS);
    if (from < floor) { clipped.push(`${w.display_name}(${from})`); from = floor; }
    const list = await listBroadcasts(w.channel_id!, { from, to: TODAY });
    if ((list as typeof list & { truncated?: boolean }).truncated) truncated.push(w.display_name);
    for (const v of list) {
      found.push({
        title_no: v.title_no, channel_id: v.channel_id, streamer: w.display_name, slug: w.slug,
        title: v.title, ended_at: v.ended_at, hours: Math.round(v.hours * 10) / 10, category: v.category,
        duration_sec: v.hours > 0 ? Math.round(v.hours * 3600) : null,
      });
    }
  }

  // pending 중 이번 목록에 안 잡힌 것(마지막 조사 지점보다 앞) — 단서 행에서 되살린다.
  const listed = new Set(found.map((v) => `vod:${v.title_no}`));
  const orphanKeys = Object.keys(state.pending).filter((k) => !listed.has(k));
  const keys = [...listed, ...orphanKeys];
  const leads = keys.length === 0 ? [] : await sql<{ source_key: string; channel_id: string; title: string; observed_at: Date; raw: Record<string, any> }[]>`
    SELECT source_key, channel_id, title, observed_at, raw FROM event_lead WHERE source = 'vod_title' AND source_key = ANY(${keys})`;
  const byKey = new Map(leads.map((l) => [l.source_key, l]));

  const queue: Item[] = [];
  const skippedStall: string[] = [];
  let done = 0, excluded = 0;
  const consider = (it: Omit<Item, "reason">, duration_sec: number | null) => {
    if (titleExclusion(it.title)) { excluded++; return; }
    const { reason } = vodWork(byKey.get(it.key)?.raw, duration_sec);
    if (!reason) { done++; delete state.pending[it.key]; delete state.stall[it.key]; return; }
    if (stalled(state, it.key)) { skippedStall.push(`${it.key}(${it.streamer})`); return; }
    queue.push({ ...it, reason });
  };
  for (const { duration_sec, ...v } of found) consider({ key: `vod:${v.title_no}`, ...v }, duration_sec);
  for (const key of orphanKeys) {
    const l = byKey.get(key);
    const w = watch.find((x) => x.channel_id === (l?.channel_id ?? state.pending[key].channel_id));
    if (!l || !w) { delete state.pending[key]; continue; }  // 와치리스트에서 빠졌거나 단서가 없다
    consider({ key, title_no: Number(key.slice(4)), channel_id: l.channel_id, streamer: w.display_name, slug: w.slug,
      title: l.title, ended_at: l.observed_at.toISOString(), hours: 0, category: null }, null);
  }
  queue.sort((a, b) => a.ended_at.localeCompare(b.ended_at));  // 오래된 것부터
  saveState(state);

  console.log(`롤 와치리스트 ${watch.length}명 · VOD ${found.length}개(+이어받기 ${orphanKeys.length}) · 조사 끝 ${done} · 제목으로 제외 ${excluded} · 큐 ${queue.length}`);
  for (const q of queue) console.log(`  ${q.ended_at}  ${q.key}  ${q.hours}h  ${q.streamer}  [${q.reason}]  ${q.title}`);
  if (skippedStall.length) console.log(`\n⚠ 진척 없음 ${STALL_LIMIT}회로 건너뛴 VOD: ${skippedStall.join(", ")} — 원인 확인 뒤 상태 파일에서 stall 을 지운다`);
  if (clipped.length) console.log(`\n⚠ 마지막 조사 지점이 ${MAX_LOOKBACK}일보다 오래돼 ${floor} 부터만 본다(그 앞은 백필 몫): ${clipped.join(", ")}`);
  if (truncated.length) console.log(`\n⚠ VOD 목록이 잘렸다 — 큐가 불완전하다: ${truncated.join(", ")}`);
  writeOut({ generated_at: new Date().toISOString(), truncated, clipped, skipped_stall: skippedStall, queue });
  return truncated.length ? 2 : 0;
}

/** FC: 최근 30일 API 경기 중 맥락 미조사가 있는 와치리스트 FC 스트리머. */
async function fc(): Promise<number> {
  const state = loadState();
  const from = kstDate(FC_DAYS - 1);
  const queue: { key: string; slug: string; streamer: string; uninvestigated: number }[] = [];
  const skippedStall: string[] = [];
  for (const w of await listWatched("fconline")) {
    const key = `fc:${w.slug}`;
    const n = (await listFcoContextQueue({ from, streamer: w.slug, status: "uninvestigated" })).length;
    if (n === 0) { delete state.stall[key]; continue; }
    if (stalled(state, key)) { skippedStall.push(`${w.display_name}(${n}건)`); continue; }
    queue.push({ key, slug: w.slug, streamer: w.display_name, uninvestigated: n });
  }
  saveState(state);
  console.log(`FC 와치리스트 · ${from} ~ ${TODAY} · 맥락 미조사 경기가 있는 스트리머 ${queue.length}명`);
  for (const q of queue) console.log(`  ${q.streamer} (${q.slug}) — 미조사 ${q.uninvestigated}건`);
  if (skippedStall.length) console.log(`\n⚠ 진척 없음 ${STALL_LIMIT}회로 건너뜀: ${skippedStall.join(", ")}`);
  writeOut({ generated_at: new Date().toISOString(), from, to: TODAY, skipped_stall: skippedStall, queue });
  return 0;
}

/** 진척 지문 — 롤은 단서 행의 갱신 시각·할 일, FC 는 미조사 경기 수. */
async function fingerprint(key: string): Promise<{ fp: string; finished: boolean }> {
  if (key.startsWith("vod:")) {
    const [l] = await sql<{ updated_at: Date; raw: Record<string, any> }[]>`
      SELECT updated_at, raw FROM event_lead WHERE source = 'vod_title' AND source_key = ${key}`;
    if (!l) return { fp: "none", finished: false };
    const { reason } = vodWork(l.raw, null);
    return { fp: `${l.updated_at.toISOString()}|${reason}`, finished: reason === null };
  }
  if (key.startsWith("fc:")) {
    const n = (await listFcoContextQueue({ from: kstDate(FC_DAYS - 1), streamer: key.slice(3), status: "uninvestigated" })).length;
    return { fp: String(n), finished: n === 0 };
  }
  throw new Error(`--key 는 vod:<번호> 또는 fc:<slug>: ${key}`);
}

async function snapshot(): Promise<number> {
  const state = loadState();
  state.snap[KEY] = (await fingerprint(KEY)).fp;
  saveState(state);
  return 0;
}

async function settle(): Promise<number> {
  const state = loadState();
  const before = state.snap[KEY];
  const { fp, finished } = await fingerprint(KEY);
  delete state.snap[KEY];
  const progressed = before !== undefined && fp !== before;
  if (finished) {
    delete state.pending[KEY]; delete state.stall[KEY];
    console.log(`${KEY}: 끝`);
  } else {
    if (KEY.startsWith("vod:")) {
      const [l] = await sql<{ channel_id: string }[]>`SELECT channel_id FROM event_lead WHERE source = 'vod_title' AND source_key = ${KEY}`;
      state.pending[KEY] ??= { channel_id: l?.channel_id ?? "", since: TODAY };
    }
    if (progressed) { delete state.stall[KEY]; console.log(`${KEY}: 진척 있음 — 다음 회차가 잇는다`); }
    else {
      const count = (state.stall[KEY]?.count ?? 0) + 1;
      state.stall[KEY] = { count, last: new Date().toISOString() };
      console.log(`${KEY}: 진척 없음 ${count}/${STALL_LIMIT}`);
    }
  }
  saveState(state);
  return finished || progressed ? 0 : 4;
}

let code = 0;
try {
  if (COMMAND === "plan") code = await plan();
  else if (COMMAND === "fc") code = await fc();
  else if (COMMAND === "snapshot" || COMMAND === "settle") {
    if (!KEY || !STATE_PATH) throw new Error(`${COMMAND} 에는 --key 와 --state 가 필요하다`);
    code = COMMAND === "snapshot" ? await snapshot() : await settle();
  } else throw new Error(`알 수 없는 명령: ${COMMAND} (plan|fc|snapshot|settle)`);
} finally {
  await closeDb();
}
process.exit(code);
