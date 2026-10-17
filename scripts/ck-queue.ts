/**
 * 매일 와치리스트 조사의 대상 — **채널마다 이전에 조사한 다음부터 오늘까지** (2026-10-08 개편).
 *
 *   npm run ck:queue                               # 롤 대상 표만 본다
 *   npm run ck:queue -- plan --write <q.json> --state <s.json>
 *   npm run ck:queue -- fc --write <q.json> --state <s.json>      # FC: 맥락 미조사 API 경기가 있는 스트리머
 *   npm run ck:queue -- begin  --vod <번호> --dir <실행 폴더> --state <s.json>   # 롤 세션 직전: before·재개 요약·반복 제한
 *   npm run ck:queue -- finish --vod <번호> --dir <실행 폴더> --state <s.json>   # 롤 세션 직후: 0 진척 · 4 진척 없음/반복 제한 · 3 끝
 *   npm run ck:queue -- access --vod <번호> --status unavailable|temporary|retry --reason <근거>   # 조사 세션이 부른다
 *   npm run ck:queue -- snapshot|settle --key fc:<slug> --state <s.json>          # FC 세션 전후 · settle 0 진척 · 4 진척 없음
 *   npm run ck:queue -- reopen --vods <번호,…> --reason <왜> --state <s.json> [--apply]   # 끝난 롤 조사를 다시 연다(기본은 미리보기)
 *
 * `scripts/ck-auto.sh --poll`(매시간 타이머)이 plan --enqueue로 발견 목록을 보존한다.
 * 대상 선정 상태는 --state 파일 하나다. DB 에 쓰는 건 access(접근 기록)·reopen(조사 다시 열기)·판독 요청 상태(0097)뿐이다.
 *
 * ★ 판독 요청(0097 vod_request — 회원 제보·운영자)은 plan 이 와치리스트보다 **먼저** 본다. 할 일은 scripts/lib/ck-vod-request.ts 가 정한다:
 *   감시 목록 밖 채널이어도 대기열에 넣고(우선순위 → claim 이 맨 앞으로), 끝난 조사였으면 다시 연다. finish·access 가 요청을 닫는다.
 *   요청 상태를 쓰는 것은 --enqueue 일 때뿐이다(미리보기·--dry-run 은 읽기만).
 *
 * ★ 매일 조사와 백필은 다른 일이다
 *   매일 조사 = 와치리스트 채널의 새 VOD 를 빠짐없이 따라간다. 백필 = 사용자가 정한 과거 기간을 메운다.
 *   예전엔 "최근 3일 + 기간 밖 running 전부" 를 집어서 ① PC·타이머가 3일 넘게 쉬면 그 사이 VOD 가 영영
 *   빠졌고(9/28~10/8 공백이 그렇게 생겼다) ② 백필이 보류한 VOD 까지 매 회차 다시 열었다.
 *   그래서 대상은 **채널의 "마지막으로 조사를 끝낸 VOD" 이후**이고, 백필의 running 은 줍지 않는다.
 *   자동 조사가 발견한 미완료 VOD는 조사 시작 전부터 pending으로 기억해 다음 회차가 잇는다.
 *
 * ★ 완료 판정은 `vodWork`(core/metrics/ck-vod-status) 하나다 — 백필과 같은 함수라 한쪽이 끝낸 VOD 를
 *   다른 쪽이 다시 보지 않는다. 카테고리로 거르지 않는다(토크로 켜고 내전하는 방송이 있다).
 * ★ 마지막 조사 지점이 아주 오래면(기본 14일 넘게) 그 앞은 자르고 경고한다 — 그건 백필 몫이다.
 * ★ 롤 세션의 진척 판정·반복 제한·재개 요약은 **백필과 같은 함수**다(core 의 madeProgress·progressKind·backfillContext,
 *   scripts/lib/ck-backfill-guard.ts). 백필 파일은 고치지 않고 불러 쓴다 — 반복 제한 기록만 자기 폴더(out/ck/auto/guards)에 둔다.
 *   접근 불가 기록도 백필과 같은 core 함수(recordVodAccess)를 쓴다(ck:backfill access 는 백필 잠금 안에서만 돈다).
 * ★ FC 는 같은 대상(스트리머)이 세 번 연속 미조사 수를 못 줄이면 건너뛴다(stall). 진척이 생기면 횟수를 지운다.
 * ★ FC 는 API 맥락 판정만 한다 — 넥슨 API 가 최근 30일 경기를 이미 안다. 대상은 그 30일 안의
 *   맥락 '미조사' 경기가 있는 와치리스트 FC 스트리머다. 화면으로 경기를 새로 읽는 일(30일 이전)은 백필 몫이다.
 * ★ 조회가 잘리면 시끄럽게 말하고 종료 코드 2 를 낸다.
 */

import { listWatched } from "@soop-lol/core/lib/db/watchlist";
import { closeDb, db } from "@soop-lol/core/lib/db/client";
import { noteWriteBlocked } from "@soop-lol/core/lib/db/write-block";
import { listFcoContextQueue } from "@soop-lol/core/lib/games/fconline/context";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { kstDate, makeOpt } from "./lib/cli.mjs";
import { CK_RECENT_DAYS, recentFrom, titleExclusion, vodWork, type VodReason } from "@soop-lol/core/lib/metrics/ck-vod-status";
import { kstDateString } from "@soop-lol/core/lib/time";
import { listBroadcasts, playableFiles, vodBroadcastTimes, vodDetail } from "./lib/soop-vod.mjs";
import { backfillContext, lastFinishedScans, recordVodAccess, savedPovCounts, vodRaws } from "@soop-lol/core/lib/db/ck-backfill";
import { madeProgress, progressKind, type VodWork } from "@soop-lol/core/lib/metrics/ck-vod-status";
import { advanceGuard, guardBlocked, parseGuard, MAX_NO_OUTCOME_SESSIONS, type BackfillGuard } from "./lib/ck-backfill-guard.ts";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { rememberPending, vodTime, type PendingVod } from "./lib/ck-auto-queue.ts";
import { planVodRequests, type RequestFacts, type VodMeta } from "./lib/ck-vod-request.ts";
import { claimVodRequests, listOpenVodRequests, type OpenVodRequest } from "@soop-lol/core/lib/db/vod-request";
import { reconsiderOpenSubmissions, settleVodRequests } from "@soop-lol/core/lib/db/submission";

const argv = process.argv.slice(2);
const COMMAND = argv[0] && !argv[0].startsWith("--") ? argv[0] : "plan";
const opt = makeOpt(argv);
const WRITE = opt("--write", "");
const STATE_PATH = opt("--state", "");
const KEY = opt("--key", "");
const MAX_LOOKBACK = Number(opt("--max-lookback-days", "14"));
const STALL_LIMIT = Number(opt("--stall-limit", "3"));
const FC_DAYS = 30;
const VOD = Number(opt("--vod", "0"));
const RUN_DIR = opt("--dir", "");
const GUARD_DIR = "out/ck/auto/guards";
const TODAY = kstDate(0);

interface State {
  /** 발견했지만 아직 안 끝난 VOD — 마지막 조사 지점이 앞서가도 잊지 않는다. */
  pending: Record<string, PendingVod>;
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
  const tmp = `${STATE_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, STATE_PATH);
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
  title: string; ended_at: string; hours: number; category: string | null;
  /** 매일 조사는 VodReason, 판독 요청은 "<VodReason> · <누가> 판독 요청". */
  reason: VodReason | string;
  priority?: number;
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

  // 마지막 조사 지점 = 조사 도장이 있고 vodWork 가 할 일 없음으로 보는 VOD 중 가장 늦은 것(채널마다 최신부터 몇 개씩만 받는다).
  const mark = await lastFinishedScans(channels);

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
    const work = vodWork(byKey.get(it.key)?.raw, duration_sec);
    if (!work.reason) { done++; delete state.pending[it.key]; rmGuard(it.title_no); return; }
    if (guardBlocked(readGuard(it.title_no), work)) { skippedStall.push(`${it.key}(${it.streamer})`); return; }
    const item = { ...it, reason: work.reason };
    queue.push(item);
    if (argv.includes("--enqueue")) rememberPending(state.pending, { ...item, duration_sec }, TODAY);
  };
  for (const { duration_sec, ...v } of found) consider({ key: `vod:${v.title_no}`, ...v }, duration_sec);
  for (const key of orphanKeys) {
    const l = byKey.get(key);
    const w = watch.find((x) => x.channel_id === (l?.channel_id ?? state.pending[key].channel_id));
    const saved = state.pending[key].item;
    if (!w || (!l && !saved)) { delete state.pending[key]; continue; }
    if (saved) {
      consider({ ...saved, streamer: w.display_name, slug: w.slug }, saved.duration_sec ?? null);
      continue;
    }
    if (!l) continue;
    consider({ key, title_no: Number(key.slice(4)), channel_id: l.channel_id, streamer: w.display_name, slug: w.slug,
      title: l.title, ended_at: l.observed_at.toISOString(), hours: 0, category: null }, null);
  }
  // 판독 요청 — 같은 VOD 가 매일 조사에도 있으면 요청 쪽(우선순위·사유)으로 바꾼다.
  const req = await requestedItems(watch, found, state);
  const requestedKeys = new Set(req.map((x) => x.key));
  const merged = [...req, ...queue.filter((x) => !requestedKeys.has(x.key))];
  queue.length = 0; queue.push(...merged);
  queue.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || vodTime(a.ended_at) - vodTime(b.ended_at));  // 요청 먼저, 그다음 오래된 것부터
  saveState(state);

  console.log(`롤 와치리스트 ${watch.length}명 · VOD ${found.length}개(+이어받기 ${orphanKeys.length}) · 조사 끝 ${done} · 제목으로 제외 ${excluded} · 판독 요청 ${req.length} · 큐 ${queue.length}`);
  for (const q of queue) console.log(`  ${q.ended_at}  ${q.key}  ${q.hours}h  ${q.streamer}  [${q.reason}]  ${q.title}`);
  if (skippedStall.length) console.log(`\n⚠ 결과 진척 없이 ${MAX_NO_OUTCOME_SESSIONS}회 연속 조사해 건너뛴 VOD: ${skippedStall.join(", ")} — 원인 확인 뒤 ${GUARD_DIR}/lol-<번호>.json 을 지운다`);
  if (clipped.length) console.log(`\n⚠ 마지막 조사 지점이 ${MAX_LOOKBACK}일보다 오래돼 ${floor} 부터만 본다(그 앞은 백필 몫): ${clipped.join(", ")}`);
  if (truncated.length) console.log(`\n⚠ VOD 목록이 잘렸다 — 큐가 불완전하다: ${truncated.join(", ")}`);
  writeOut({ generated_at: new Date().toISOString(), truncated, clipped, skipped_stall: skippedStall, queue });
  return truncated.length ? 2 : 0;
}

/**
 * 판독 요청(0097) → 대기열 줄. 사실(VOD 정보·조사 상태·반복 제한)을 모아 planVodRequests 에 넘기고, --enqueue 면 그 결과를 쓴다
 * (끝난 조사 다시 열기 · queued → claimed · 영상 없음/끝 닫기). VOD 정보는 이번 목록 → pending → 단서 행 → SOOP 상세 순서로 찾는다.
 */
async function requestedItems(watch: Awaited<ReturnType<typeof listWatched>>, found: { title_no: number; channel_id: string; streamer: string; slug: string;
  title: string; ended_at: string; hours: number; category: string | null; duration_sec: number | null }[], state: State): Promise<Item[]> {
  // 열린 제보를 먼저 다시 판정한다 — 링크 없이 등록한 직접 입력은 그날 VOD 의 단서 행이 생긴 뒤에야 요청을 낸다(판정의 할 일 vod_priority).
  if (argv.includes("--enqueue")) {
    const changed = await reconsiderOpenSubmissions();
    if (changed) console.log(`열린 제보 다시 판정 — 바뀐 것 ${changed}건`);
  }
  const requests = await listOpenVodRequests();
  if (!requests.length) return [];
  const keys = requests.map((r) => `vod:${r.title_no}`);
  const leads = await sql<{ source_key: string; channel_id: string; title: string; observed_at: Date; raw: Record<string, any> }[]>`
    SELECT source_key, channel_id, title, observed_at, raw FROM event_lead WHERE source = 'vod_title' AND source_key = ANY(${keys})`;
  const leadOf = new Map(leads.map((l) => [l.source_key, l]));
  const names = await channelNames([...new Set([...requests.map((r) => r.channel_id), ...leads.map((l) => l.channel_id)].filter((c): c is string => !!c))], watch);
  const facts = new Map<number, RequestFacts>();
  for (const r of requests) {
    const key = `vod:${r.title_no}`, lead = leadOf.get(key);
    const listed = found.find((v) => v.title_no === r.title_no);
    let meta: VodMeta | null = null, seconds: number | null = listed?.duration_sec ?? null;
    if (listed) meta = { key, title_no: r.title_no, channel_id: listed.channel_id, streamer: listed.streamer, slug: listed.slug, title: listed.title,
      ended_at: listed.ended_at, hours: listed.hours, category: listed.category, duration_sec: listed.duration_sec };
    else if (state.pending[key]?.item) { const { reason: _r, priority: _p, ...saved } = state.pending[key].item!; meta = saved; seconds = saved.duration_sec ?? null; }
    else if (lead) {
      const n = names.get(lead.channel_id);
      meta = { key, title_no: r.title_no, channel_id: lead.channel_id, streamer: n?.name ?? lead.channel_id, slug: n?.slug ?? lead.channel_id,
        title: lead.title, ended_at: lead.observed_at.toISOString(), hours: 0, category: null };
    } else {
      meta = await metaFromSoop(r, names).catch((e) => { console.log(`  ⚠ ${key}: SOOP 상세 실패 — ${(e as Error).message}`); return null; });
      seconds = meta?.duration_sec ?? null;
    }
    const work = vodWork(lead?.raw, seconds);
    facts.set(r.title_no, { meta, work, scan_status: lead?.raw?.scan?.status ?? null, blocked: guardBlocked(readGuard(r.title_no), work) });
  }
  const plan = planVodRequests(requests, facts);
  if (argv.includes("--enqueue")) {
    if (plan.reopen.length) await reopenDone(plan.reopen.map((n) => `vod:${n}`), "판독 요청(0097) — 요청 뒤 이 VOD 를 다시 본다", requestResume(requests), state);
    for (const c of plan.claim) await claimVodRequests(c.title_no, c.channel_id);
    // 닫기는 요청한 제보의 다시 판정과 한 트랜잭션(VOD 단서가 확인·운영자 대기로 옮겨 간다).
    for (const c of plan.close) await settleVodRequests(c.title_no, c.state, c.note);
  }
  const tag = argv.includes("--enqueue") ? "" : " (미리보기 — 요청 상태는 안 바꿨다)";
  console.log(`판독 요청 VOD ${requests.length}개${tag} · 대기열 ${plan.enqueue.length} · 다시 엶 ${plan.reopen.length} · 닫음 ${plan.close.length} · 대기 ${plan.waiting.length}`);
  for (const c of plan.close) console.log(`  닫음 vod:${c.title_no} → ${c.state} (${c.note})`);
  for (const w of plan.waiting) console.log(`  ⚠ 대기 vod:${w.title_no} — ${w.why}`);
  return plan.enqueue;
}

/** 채널 → 스트리머 이름(감시 목록 밖도 — 등록된 채널이면). */
async function channelNames(channels: string[], watch: Awaited<ReturnType<typeof listWatched>>): Promise<Map<string, { name: string; slug: string }>> {
  const out = new Map<string, { name: string; slug: string }>();
  for (const w of watch) if (w.channel_id) out.set(w.channel_id, { name: w.display_name, slug: w.slug });
  const rest = channels.filter((c) => !out.has(c));
  if (rest.length) {
    for (const r of await sql<{ channel_id: string; display_name: string; slug: string }[]>`
      SELECT c.channel_id, s.display_name, s.slug FROM streamer_channel c JOIN streamer s ON s.id = c.streamer_id
       WHERE c.platform = 'soop' AND c.channel_id = ANY(${rest})`) out.set(r.channel_id, { name: r.display_name, slug: r.slug });
  }
  return out;
}

/** 단서 행도 목록에도 없는 VOD(링크만 받은 요청) — SOOP 상세에서 채널·방송 끝·길이를 읽는다. 못 읽으면 null(지어내지 않는다). */
async function metaFromSoop(r: OpenVodRequest, names: Map<string, { name: string; slug: string }>): Promise<VodMeta | null> {
  const detail = await vodDetail(r.title_no);
  if (!detail) { console.log(`  ⚠ vod:${r.title_no}: SOOP 상세 응답 없음(삭제·비공개일 수 있다)`); return null; }
  const channel_id: string | null = detail.bj_id ?? detail.user_id ?? r.channel_id ?? null;
  const ended = vodBroadcastTimes(detail).end;
  if (!channel_id || !/^[\w-]+$/.test(channel_id) || !ended) return null;
  const ms = playableFiles(detail).reduce((a: number, f: { duration: number }) => a + f.duration, 0);
  const n = names.get(channel_id);
  return { key: `vod:${r.title_no}`, title_no: r.title_no, channel_id, streamer: n?.name ?? detail.bj_nick ?? detail.writer_nick ?? channel_id,
    slug: n?.slug ?? channel_id, title: detail.title ?? `VOD ${r.title_no}`, ended_at: ended,
    hours: Math.round((ms / 3_600_000) * 10) / 10, category: null, duration_sec: ms > 0 ? Math.round(ms / 1000) : null };
}

/** 요청으로 다시 열 때의 인계 — 이전 결론은 유지하고 요청 메모의 경기를 찾는다(품질 의심으로 다시 여는 reopen 과 다르다). */
function requestResume(requests: OpenVodRequest[]) {
  return (key: string) => {
    const r = requests.find((x) => `vod:${x.title_no}` === key);
    return {
      next_action: "판독 요청으로 다시 열었다(회원 제보·운영자). 이전 조사의 사실·결론은 그대로 두고, 요청 뒤에 들어온 경기 정보를 확인한다. "
        + "ck:merge --find-match --vod 로 DB 의 기존 경기를 먼저 본다. 같은 판이면 그 경기 번호로 기록하고 새 판을 만들지 않는다. "
        + "전 범위 확인 조건은 평소와 같다.",
      request_notes: r?.notes ?? [],
    };
  };
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

// ── 롤: 세션 전후 — 백필 after 와 같은 판정 ─────────────────────────
function guardFile(vod: number) { return join(GUARD_DIR, `lol-${vod}.json`); }
function readGuard(vod: number): BackfillGuard | null {
  const f = guardFile(vod);
  return existsSync(f) ? parseGuard(JSON.parse(readFileSync(f, "utf8"))) : null;
}
function rmGuard(vod: number) { rmSync(guardFile(vod), { force: true }); }
async function workOf(vod: number): Promise<VodWork> {
  const w = vodWork((await vodRaws([vod])).get(vod), null);
  w.saved_matches = (await savedPovCounts([vod])).get(vod) ?? 0;
  return w;
}
const curPath = (vod: number) => join(RUN_DIR, `current-${vod}.json`);

async function begin(): Promise<number> {
  if (!VOD || !RUN_DIR) throw new Error("begin 에는 --vod 와 --dir 가 필요하다");
  const before = await workOf(VOD);
  if (before.reason === null) { console.log(`vod:${VOD}: 이미 끝 — 건너뛴다`); return 3; }
  if (guardBlocked(readGuard(VOD), before)) {
    console.log(`vod:${VOD}: 결과 진척 없이 ${MAX_NO_OUTCOME_SESSIONS}회 연속 조사해 보류 — ${guardFile(VOD)} 확인 후 지우면 재개`);
    return 4;
  }
  mkdirSync(RUN_DIR, { recursive: true });
  writeFileSync(curPath(VOD), JSON.stringify({ vod: VOD, before, attempt_id: randomUUID() }, null, 2));
  writeFileSync(join(RUN_DIR, `resume-${VOD}.json`), JSON.stringify(await backfillContext(VOD, "lol"), null, 2));
  return 0;
}

async function finish(): Promise<number> {
  if (!VOD || !RUN_DIR) throw new Error("finish 에는 --vod 와 --dir 가 필요하다");
  const c = JSON.parse(readFileSync(curPath(VOD), "utf8")) as { before: VodWork; attempt_id: string };
  const after = await workOf(VOD);
  const progress = madeProgress(c.before, after);
  mkdirSync(GUARD_DIR, { recursive: true });
  const guard = advanceGuard(readGuard(VOD), c.attempt_id, c.before, after);
  writeFileSync(guardFile(VOD), JSON.stringify(guard, null, 2));
  const blocked = guardBlocked(guard, after);
  // 사용량 집계(scripts/ck-session-usage.ts)가 읽는 모양 — 백필 after.json 과 같다.
  writeFileSync(join(RUN_DIR, `after-${VOD}.json`), JSON.stringify({ vod: VOD, progress,
    progress_kind: progressKind(c.before, after), guard, blocked, before: c.before, after }, null, 2));
  const state = loadState();
  const key = `vod:${VOD}`;
  if (after.reason === null) { delete state.pending[key]; rmGuard(VOD); }
  // 판독 요청(0097) — 끝났으면 done, 접근 불가면 unavailable 로 닫는다(열린 요청이 없으면 아무것도 안 바뀐다).
  // 닫으면서 요청한 제보를 다시 판정한다(같은 트랜잭션 — submission.ts settleVodRequests).
  const settled = after.unavailable ? await settleVodRequests(VOD, "unavailable", "조사 세션이 접근 불가로 기록")
    : after.reason === null ? await settleVodRequests(VOD, "done", "판독 끝") : { closed: 0, changed: 0 };
  if (settled.closed) console.log(`${key}: 판독 요청 ${settled.closed}건 닫음 · 판정이 바뀐 제보 ${settled.changed}건`);
  else {
    const [l] = await sql<{ channel_id: string }[]>`SELECT channel_id FROM event_lead WHERE source = 'vod_title' AND source_key = ${key}`;
    state.pending[key] ??= { channel_id: l?.channel_id ?? "", since: TODAY };
  }
  saveState(state);
  const label = after.unavailable ? "접근 불가" : after.reason === null ? "끝" : `미완료 [${after.reason}]`;
  console.log(`${key}: ${label} · 못 본 ${after.uncovered ?? "?"}초 · 실패 ${after.failed}초 · 미해결 ${after.unresolved} · 저장 시점 ${after.saved_matches ?? 0} · 연 원본 ${after.opened}`
    + (progress ? "" : " · 진척 없음") + (blocked ? ` · 결과 진척 없이 ${MAX_NO_OUTCOME_SESSIONS}회 — 보류` : ""));
  if (after.reason === null) return 3;
  return progress && !blocked ? 0 : 4;
}

/**
 * 끝난(done) 롤 조사를 다시 연다 — 조사 품질이 의심될 때(예: 2026-10-08 Haiku 5.5 시험 회차가 닫은 VOD).
 * 도장을 running 으로 되돌리고 인계(resume)에 재조사 지시를 남긴 뒤 pending 에 올린다. 마지막 조사 지점
 * 앞이라도 pending 이라 다음 회차가 줍는다. 이력은 scan.reopened 에 쌓는다. 경기·검수 기록은 건드리지 않는다.
 */
async function reopen(): Promise<number> {
  const reason = opt("--reason", "").trim();
  const vods = String(opt("--vods", "")).split(",").map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n > 0);
  if (!reason || !vods.length || !STATE_PATH) throw new Error("--vods <번호,…> · --reason · --state 가 필요하다");
  const apply = argv.includes("--apply");
  const keys = vods.map((v) => `vod:${v}`);
  const rows = await sql<{ source_key: string; channel_id: string; status: string | null }[]>`
    SELECT source_key, channel_id, raw->'scan'->>'status' AS status FROM event_lead
     WHERE source = 'vod_title' AND source_key = ANY(${keys})`;
  const byKey = new Map(rows.map((r) => [r.source_key, r]));
  const target = keys.filter((k) => byKey.get(k)?.status === "done");
  const skipped = keys.filter((k) => !target.includes(k)).map((k) => `${k}(${byKey.get(k)?.status ?? "단서 없음"})`);
  console.log(`다시 열 VOD ${target.length}개${skipped.length ? ` · 건너뜀 ${skipped.length}: ${skipped.join(", ")}` : ""}`);
  if (!apply) { console.log("미리보기다 — 쓰려면 --apply"); return 0; }
  const state = loadState();
  await reopenDone(target, reason, () => ({
    next_action: "이 VOD 를 다시 판독한다. 이전 '끝' 결론은 위 사유로 신뢰하지 않는다 — 사실·근거는 참고만 한다. "
      + "ck:merge --find-match --vod 로 DB 의 기존 경기를 먼저 보고 이 VOD 시점을 연결한다(결과창 원본을 직접 읽어 대조). "
      + "빈 챔피언·KDA 를 채우고, 미해결 후보에 결론을 낸다. 전 범위 확인 조건은 평소와 같다.",
  }), state);
  saveState(state);
  console.log(`다시 열었다: ${target.length}개 → pending 에 올림(${STATE_PATH})`);
  return 0;
}

/**
 * done 인 조사를 running 으로 되돌리고 인계(resume)에 지시를 남긴 뒤 pending 에 올린다 — reopen 명령과 판독 요청이 같이 쓴다.
 * 이력은 scan.reopened 에 쌓는다. 경기·검수 기록은 건드리지 않는다. done 이 아닌 것은 건드리지 않는다(조건부 UPDATE).
 */
async function reopenDone(keys: string[], reason: string, resumeOf: (key: string) => Record<string, unknown>, state: State): Promise<void> {
  const at = new Date().toISOString();
  await sql.begin(async (tx) => {
    for (const key of keys) {
      const done = await tx<{ channel_id: string }[]>`UPDATE event_lead SET raw = jsonb_set(jsonb_set(jsonb_set(raw,
          '{scan,status}', '"running"'),
          '{scan,resume}', ${tx.json({ reopened_at: at, reason, ...resumeOf(key) } as never)}::jsonb),
          '{scan,reopened}', COALESCE(raw->'scan'->'reopened', '[]'::jsonb) || ${tx.json([{ at, reason, prev_status: "done" }])}::jsonb)
        WHERE source = 'vod_title' AND source_key = ${key} AND raw->'scan'->>'status' = 'done' RETURNING channel_id`;
      if (done[0]) state.pending[key] ??= { channel_id: done[0].channel_id, since: TODAY };
      rmGuard(Number(key.slice(4)));
    }
  });
}

async function access(): Promise<number> {
  const status = opt("--status", "");
  if (!VOD || !["temporary", "unavailable", "retry"].includes(status)) throw new Error("--vod 와 --status temporary|unavailable|retry 가 필요하다");
  await recordVodAccess(VOD, status as "temporary" | "unavailable" | "retry", opt("--reason", ""));
  if (status === "unavailable") await settleVodRequests(VOD, "unavailable", opt("--reason", ""));
  console.log(`vod:${VOD}: 접근 상태 ${status} 기록`);
  return 0;
}

/** FC 진척 지문 — 미조사 경기 수. */
async function fingerprint(key: string): Promise<{ fp: string; finished: boolean }> {
  if (key.startsWith("fc:")) {
    const n = (await listFcoContextQueue({ from: kstDate(FC_DAYS - 1), streamer: key.slice(3), status: "uninvestigated" })).length;
    return { fp: String(n), finished: n === 0 };
  }
  throw new Error(`--key 는 fc:<slug> (롤은 begin/finish): ${key}`);
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
  else if (COMMAND === "begin") code = await begin();
  else if (COMMAND === "finish") code = await finish();
  else if (COMMAND === "access") code = await access();
  else if (COMMAND === "reopen") code = await reopen();
  else if (COMMAND === "snapshot" || COMMAND === "settle") {
    if (!KEY || !STATE_PATH) throw new Error(`${COMMAND} 에는 --key 와 --state 가 필요하다`);
    code = COMMAND === "snapshot" ? await snapshot() : await settle();
  } else throw new Error(`알 수 없는 명령: ${COMMAND} (plan|fc|begin|finish|access|reopen|snapshot|settle)`);
} catch (e) {
  // 진척 도장을 못 쓰는 것도 쓰기 실패다 — 표시를 남겨 다음 세션을 막는다.
  noteWriteBlocked(e, `ck:queue ${COMMAND}`);
  throw e;
} finally {
  await closeDb();
}
process.exit(code);
