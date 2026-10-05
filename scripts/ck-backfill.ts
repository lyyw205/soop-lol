/**
 * 수동 백필 CLI. scripts/ck-backfill.sh 가 잠금을 잡고 plan → (next → 조사 → after) 반복으로 부른다.
 *
 * ★ 진척은 VOD 조사 도장(event_lead.raw)만 믿는다. 커서가 없다 — 같은 기간을 다시 요청하면
 *   목록을 다시 받아 완료 도장이 없는 VOD 만 남는다. 그래서 멈춘 곳부터 이어지고 빈틈도 저절로 메워진다.
 */
import { parseArgs } from 'node:util';
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { closeDb } from '@soop-lol/core/lib/db/client';
import { kstDateString } from '@soop-lol/core/lib/time';
import { resolveBackfillTarget, getBackfillRequest, saveBackfillRequest, vodRaws, ensureVodLeads,
  channelLeadsBetween, recordVodAccess, savedPovCounts, backfillContext, type BackfillGame, type BackfillTarget, type BackfillVod } from '@soop-lol/core/lib/db/ck-backfill';
import { vodWork as vodWorkFor, madeProgress, progressKind, vodDate, titleExclusion as lolTitleExclusion, type ScanRaw, type VodWork } from '@soop-lol/core/lib/metrics/ck-vod-status';
import { advanceGuard, guardBlocked, parseGuard, MAX_NO_OUTCOME_SESSIONS, type BackfillGuard } from './lib/ck-backfill-guard.ts';
import { listRange } from './lib/ck-backfill.ts';
import { listBroadcasts } from './lib/soop-vod.mjs';

const HELP = `ck:backfill status --streamer <이름> [--game lol|fconline]
실행: scripts/ck-backfill.sh --streamer <이름> [--from YYYY-MM-DD --to YYYY-MM-DD]
멈춤: scripts/ck-backfill.sh --stop   (현재 세션을 저장한 뒤 멈춘다)
재개 요약: ck:backfill context --vod <번호> [--game lol|fconline]
접근 상태: ck:backfill access --vod <번호> --status temporary|unavailable|retry --reason <근거>`;

const {values,positionals} = parseArgs({allowPositionals:true,options:{
  streamer:{type:'string'},from:{type:'string'},to:{type:'string'},write:{type:'string'},queue:{type:'string'},
  current:{type:'string'},vod:{type:'string'},status:{type:'string'},reason:{type:'string'},help:{type:'boolean'},
  game:{type:'string'},'guard-dir':{type:'string'},'reset-stall':{type:'boolean'},
}});
const command = positionals[0] ?? 'status';
// ★ 게임마다 조사 도장이 다르다(롤 scan · FC fco_scan) — 롤이 끝난 VOD 도 FC 로는 따로 끝내야 한다. 접근 불가(raw.access)는 공용이다.
const GAME = (values.game ?? 'lol') as BackfillGame;
if (GAME !== 'lol' && GAME !== 'fconline') throw new Error(`--game 은 lol 또는 fconline: ${values.game}`);
const vodWork = (raw: ScanRaw | undefined, sec: number | null) => vodWorkFor(raw, sec, GAME === 'fconline' ? 'fco_scan' : 'scan');
// LCK Watch Party 제외는 롤 조사 비용 정책이다. FC 백필에는 적용하지 않는다.
const titleExclusion = (title: string) => GAME === 'lol' ? lolTitleExclusion(title) : null;

interface PlannedVod extends BackfillVod { reason: VodWork['reason']; unavailable: boolean; excluded: string | null; unresolved?: number }
interface Plan {
  target: BackfillTarget; from: string; to: string; generated_at: string;
  vods: PlannedVod[]; queue: number[];
  missing: { vod: number; title: string; reason: VodWork['reason'] }[];
}
interface Current { vod: PlannedVod; before: VodWork; attempt_id: string }

const lastPlanPath = (channel: string) => join('out/ck/backfill', GAME === 'lol' ? `last-${channel}.json` : `last-${GAME}-${channel}.json`);
const shiftDay = (day: string, d: number) => kstDateString(new Date(new Date(`${day}T00:00:00+09:00`).getTime() + d*86400000));
const readJson = <T,>(p: string): T => JSON.parse(readFileSync(p,'utf8')) as T;
function writeJson(p: string, v: unknown) { mkdirSync(dirname(p),{recursive:true}); writeFileSync(p, JSON.stringify(v,null,2)+'\n'); }
function locked() {
  if (process.env.CK_BACKFILL_LOCKED !== '1') throw new Error('변경 명령은 scripts/ck-backfill.sh(또는 같은 flock) 안에서 실행해야 한다');
}
function guardPath(vod: number) {
  if (!values['guard-dir']) return null;
  locked();
  return join(values['guard-dir'], `${GAME}-${vod}.json`);
}
function readGuard(file: string | null): BackfillGuard | null {
  return file && existsSync(file) ? parseGuard(readJson(file)) : null;
}
function writeGuard(file: string, guard: BackfillGuard) {
  const temp = `${file}.${process.pid}.tmp`;
  writeJson(temp, guard); renameSync(temp, file);
}

async function evaluate(vods: BackfillVod[]): Promise<PlannedVod[]> {
  const raws = await vodRaws(vods.map(v=>v.title_no));
  return vods.map(v => { const w = vodWork(raws.get(v.title_no), v.duration_sec);
    return { ...v, reason: w.reason, unavailable: w.unavailable, excluded: titleExclusion(v.title), unresolved: w.unresolved }; });
}
/** 조사해야 할 VOD — 완료·접근 불가·제목 제외가 아닌 것. */
const pendingVod = (v: PlannedVod) => v.reason !== null && !v.excluded;
function summary(vods: PlannedVod[]) {
  const count = (f: (v: PlannedVod)=>boolean) => vods.filter(f).length;
  return { total: vods.length, complete: count(v=>v.reason===null && !v.unavailable), unavailable: count(v=>v.unavailable),
    excluded: count(v=>!!v.excluded && v.reason!==null), remaining: count(pendingVod), running: count(v=>pendingVod(v) && v.reason==='running'),
    review_pending: vods.reduce((n, v) => n + (v.unresolved ?? 0), 0) };
}

async function plan() {
  locked();
  if (!values.streamer || !values.write) throw new Error('--streamer 와 --write 가 필요하다');
  if (values.vod && (!/^[1-9][0-9]*$/.test(values.vod) || !Number.isSafeInteger(Number(values.vod)))) throw new Error('--vod 는 양의 정수');
  const target = await resolveBackfillTarget(values.streamer);
  let from = values.from, to = values.to;
  if (!!from !== !!to) throw new Error('--from 과 --to 는 함께 준다. 둘 다 없으면 마지막 요청 기간을 쓴다');
  if (from && to) {
    if (to > kstDateString(new Date())) throw new Error(`--to 가 오늘(KST) 이후다: ${to}`);
    await saveBackfillRequest(target, from, to, GAME);
  } else {
    const last = await getBackfillRequest(target.channel_id, GAME);
    if (!last) throw new Error('이 채널은 요청한 기간이 없다. --from, --to 로 처음 요청할 것');
    ({ from_date: from, to_date: to } = last);
  }
  // 앞뒤 하루를 넓혀 받는다. 조사 대상은 요청 기간만이고, 넓힌 목록은 "목록에서 사라진 VOD" 대조에만 쓴다.
  const wide = await listRange(target.channel_id, shiftDay(from!, -1), shiftDay(to!, 1), listBroadcasts);
  const inRange = wide.filter(v => { const d = kstDateString(vodDate(v.ended_at)); return d >= from! && d <= to! && (!values.vod || v.title_no===Number(values.vod)); });
  if (values.vod && !inRange.length) throw new Error(`요청 채널·기간에 VOD ${values.vod}가 없다`);
  await ensureVodLeads(target, inRange);
  const vods = await evaluate(inRange);
  const listed = new Set(wide.map(v=>`vod:${v.title_no}`));
  const missing = (await channelLeadsBetween(target.channel_id, from!, to!))
    .filter(l => !listed.has(l.source_key))
    .map(l => ({ vod: Number(l.source_key.slice(4)), title: l.title, reason: vodWork(l.raw, null).reason }))
    .filter(l => l.reason !== null && !titleExclusion(l.title) && (!values.vod || l.vod===Number(values.vod)));
  const result: Plan = { target, from: from!, to: to!, generated_at: new Date().toISOString(),
    vods, queue: vods.filter(pendingVod).map(v=>v.title_no), missing };
  writeJson(values.write, result);
  writeJson(lastPlanPath(target.channel_id), result);
  console.log(JSON.stringify({ streamer: target.display_name, game: GAME, from, to, ...summary(vods), missing }, null, 2));
}

/** 큐에서 아직 완료가 아닌 첫 VOD. 시작 직전에 DB 도장을 다시 읽는다 — 그사이 다른 조사가 끝냈을 수 있다. */
async function next() {
  if (!values.queue || !values.current) throw new Error('--queue 와 --current 가 필요하다');
  const p = readJson<Plan>(values.queue);
  const byNo = new Map(p.vods.map(v=>[v.title_no, v]));
  const raws = await vodRaws(p.queue);
  const saved = GAME === 'lol' ? await savedPovCounts(p.queue) : new Map<number, number>();
  for (const no of p.queue) {
    const vod = byNo.get(no)!;
    if (titleExclusion(vod.title)) continue;
    const before = vodWork(raws.get(no), vod.duration_sec);
    if (GAME === 'lol') before.saved_matches = saved.get(no) ?? 0;
    if (before.reason === null) continue;
    const file = guardPath(no);
    if (file && values['reset-stall']) {
      rmSync(file, {force:true}); console.log(`VOD ${no}: 사용자가 반복 제한을 초기화했다`);
    }
    if (guardBlocked(readGuard(file), before)) {
      console.log(`VOD ${no}: 결과 진척 없이 ${MAX_NO_OUTCOME_SESSIONS}회 연속 조사해 재개 보류. 미완료 유지. 원인 확인 후 --reset-stall로 재개`);
      process.exitCode = 4; return;
    }
    writeJson(values.current, { vod: { ...vod, reason: before.reason, unavailable: before.unavailable, excluded: null }, before, attempt_id: randomUUID() } satisfies Current);
    writeJson(join(dirname(values.current), 'resume.json'), await backfillContext(no, GAME));
    console.log(`다음 VOD ${no} [${before.reason}] ${vod.title} (${((vod.duration_sec??0)/3600).toFixed(1)}h)`);
    return;
  }
  console.log('요청 기간에 남은 VOD 가 없다.');
  process.exitCode = 3;
}

/** 방금 세션이 실제로 남은 일을 줄였나. 줄지 않았으면 4 로 끝내 셸이 멈추게 한다. */
async function after() {
  if (!values.current) throw new Error('--current 가 필요하다');
  const c = readJson<Current>(values.current);
  const raw = (await vodRaws([c.vod.title_no])).get(c.vod.title_no);
  const w = vodWork(raw, c.vod.duration_sec);
  if (GAME === 'lol') w.saved_matches = (await savedPovCounts([c.vod.title_no])).get(c.vod.title_no) ?? 0;
  const progress = madeProgress(c.before, w);
  const file = guardPath(c.vod.title_no);
  const guard = file ? advanceGuard(readGuard(file), c.attempt_id, c.before, w) : null;
  if (file && guard) writeGuard(file, guard);
  const blocked = guardBlocked(guard, w);
  const state = w.unavailable ? '접근 불가' : w.reason === null ? '완료' : `미완료 [${w.reason}]`;
  console.log(`VOD ${c.vod.title_no}: ${state} · 못 본 ${w.uncovered ?? '?'}초 · 실패 ${w.failed}초 · 미해결 후보 ${w.unresolved} · 저장 시점 ${w.saved_matches ?? '-'} · 연 원본 ${w.opened}`
    + (progress ? '' : ' · ⚠ 진척 없음 — 여기서 멈춘다'));
  if (!progress) process.exitCode = 4;
  if (blocked) { console.log(`결과 진척 없이 ${MAX_NO_OUTCOME_SESSIONS}회 연속 조사 — 미완료로 멈춘다. 원인 확인 후 --reset-stall로 재개`); process.exitCode = 4; }
  writeJson(join(dirname(values.current), 'after.json'), { vod: c.vod.title_no, progress,
    progress_kind: progressKind(c.before, w), guard, blocked, before: c.before, after: w });
}

async function status() {
  if (!values.streamer) throw new Error('--streamer 가 필요하다');
  const target = await resolveBackfillTarget(values.streamer);
  const request = await getBackfillRequest(target.channel_id, GAME);
  const path = lastPlanPath(target.channel_id);
  if (!request || !existsSync(path)) { console.log(JSON.stringify({ target, request, last_plan: null }, null, 2)); return; }
  const p = readJson<Plan>(path);
  const vods = await evaluate(p.vods);
  console.log(JSON.stringify({ target, request, last_plan: { from: p.from, to: p.to, generated_at: p.generated_at, ...summary(vods),
    pending: vods.filter(pendingVod).map(v=>({ vod: v.title_no, reason: v.reason, ended_at: v.ended_at, title: v.title })),
    review_pending_vods: vods.filter(v => v.unresolved).map(v => ({ vod: v.title_no, unresolved: v.unresolved, scan_complete: v.reason === null })),
    missing: p.missing } }, null, 2));
}

async function access() {
  locked();
  const vod = Number(values.vod), s = values.status;
  if (!Number.isSafeInteger(vod) || vod <= 0 || !['temporary','unavailable','retry'].includes(s ?? '')) throw new Error('VOD 번호·접근 상태를 확인할 것');
  await recordVodAccess(vod, s as 'temporary'|'unavailable'|'retry', values.reason ?? '');
}

try {
  if (values.help) console.log(HELP);
  else if (command === 'target') {
    if (!values.streamer || !values.write) throw new Error('--streamer 와 --write 필요');
    writeJson(values.write, await resolveBackfillTarget(values.streamer));
  }
  else if (command === 'plan') await plan();
  else if (command === 'next') await next();
  else if (command === 'after') await after();
  else if (command === 'status') await status();
  else if (command === 'access') await access();
  else if (command === 'context') {
    const vod = Number(values.vod);
    if (!Number.isSafeInteger(vod) || vod <= 0) throw new Error('--vod 양의 정수 필요');
    console.log(JSON.stringify(await backfillContext(vod, GAME), null, 2));
  }
  else throw new Error(`알 수 없는 명령: ${command}\n${HELP}`);
} catch (e) { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; }
finally { await closeDb(); }
