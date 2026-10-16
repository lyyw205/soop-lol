/** DB/API와 조사 세션만 대역으로 두고 실제 실행 큐·셸·flock을 검증한다. 운영 DB/Claude는 호출하지 않는다. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import type { AutoQueue } from './lib/ck-auto-queue.ts';

test('음성 준비는 Claude 전에 직렬 실행하고 음성 실패가 화면 조사를 막지 않는다', async () => {
  const f = fixture({ LISTEN_CODE: '2' }); try {
    f.plan([[77, 'listen-test']]); f.go(77);
    assert.equal(await f.start('--poll').done, 0);
    assert.equal(await f.start('--work').done, 0);
    assert.match(f.order(), /listen:prepare --vod 77 --if-enabled --plan lol\nsession:77\n/);
  } finally { await f.cleanup(); }
});

test('--print-prompt 는 실제 세션에 넘기는 지시문과 같은 문장을 낸다(경로만 run-print)', async () => {
  const f = fixture({ LISTEN_CODE: '2', PROMPT_FILE: 'prompt.txt' }); try {
    f.plan([[77, 'listen-test']]); f.go(77);
    assert.equal(await f.start('--poll').done, 0);
    assert.equal(await f.start('--work').done, 0);
    const norm = (s: string) => s.replace(/out\/ck\/auto\/run-[^/ ]+\//g, 'out/ck/auto/RUN/').replace(/77-\d+-1\.log/g, '77-TAG.log');
    const real = norm(readFileSync(join(f.dir, 'prompt.txt'), 'utf8'));
    const printed = spawnSync('bash', [join(f.dir, 'scripts/ck-auto.sh'), '--print-prompt', '77', '--who', 'listen-test, 대상 사유: unseen, 이번 회차 1번째 세션',
      '--prep-line', 'PREP: fixture', '--listen-code', '2'], { cwd: f.dir, encoding: 'utf8' });
    assert.equal(printed.status, 0, printed.stderr);
    assert.equal(norm(printed.stdout), real + '\n');
    // 출력만 하고 끝낸다 — 실행 폴더·대기열을 만들지 않는다.
    const runs = spawnSync('bash', ['-c', 'ls out/ck/auto | grep -c run-print || true'], { cwd: f.dir, encoding: 'utf8' });
    assert.equal(runs.stdout.trim(), '0');
  } finally { await f.cleanup(); }
});

test('실행기가 분기마다 멈춘 이유를 남긴다 — 같은 종료 코드 3 이라도 DB 관문과 사용자 정지가 다르다', async () => {
  const reason = (dir: string) => JSON.parse(readFileSync(join(dir, 'stop.json'), 'utf8'));
  const runDir = () => mkdtempSync(join(tmpdir(), 'ck-auto-run-'));
  const gate = runDir(), f = fixture({ OPS_CODE: '3', OPS_RUN_DIR: gate }); try {
    f.plan([[1, 'a']]); await f.start('--poll').done;
    assert.deepEqual([reason(gate).reason, reason(gate).detail], ['completed', '목록 갱신']);
    assert.equal(await f.start('--work').done, 3);
    assert.equal(reason(gate).reason, 'blocked_external'); assert.match(reason(gate).detail, /운영 DB 점검/);
  } finally { await f.cleanup(); rmSync(gate, { recursive: true, force: true }); }
  const stop = runDir(), g = fixture({ CK_AUTO_LOL_JOBS: '1', OPS_RUN_DIR: stop }); try {
    g.plan([[1, 'a'], [2, 'b']]); await g.start('--poll').done;
    const run = g.start('--work'); await until(() => g.order().includes('session:1\n'));
    writeFileSync(join(g.dir, 'out/ck/auto/STOP'), ''); g.go(1);
    assert.equal(await run.done, 3);
    assert.equal(reason(stop).reason, 'user_stop');
    // 세션 하나가 저장 경계까지 끝났으니 진척이 남는다.
    assert.deepEqual(JSON.parse(readFileSync(join(stop, 'progress.json'), 'utf8')).last_item, 'vod:1');
  } finally { await g.cleanup(); rmSync(stop, { recursive: true, force: true }); }
  const cap = runDir(), h = fixture({ CK_AUTO_MAX_MIN: '0', OPS_RUN_DIR: cap }); try {
    h.plan([[1, 'a']]); await h.start('--poll').done;
    assert.equal(await h.start('--work').done, 0);
    assert.equal(reason(cap).reason, 'time_cap');
  } finally { await h.cleanup(); rmSync(cap, { recursive: true, force: true }); }
  const done = runDir(), k = fixture({ OPS_RUN_DIR: done, PLAN_CODE: '2' }); try {
    k.plan([[1, 'a']]); k.go(1); await k.start('--poll').done;
    assert.match(reason(done).detail, /목록 일부 잘림/);
    assert.equal(await k.start('--work').done, 0);
    assert.deepEqual([reason(done).reason, reason(done).detail], ['completed', '대기 소진']);
  } finally { await k.cleanup(); rmSync(done, { recursive: true, force: true }); }
});

async function until(check: () => boolean) {
  for (let i = 0; i < 300; i++) { if (check()) return; await delay(50); }
  throw new Error('fixture timeout');
}
function fixture(env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ck-auto-shell-'));
  for (const p of ['scripts/lib', 'scripts/ck-local', 'scripts/ops', 'out/ck/auto']) mkdirSync(join(dir, p), { recursive: true });
  copyFileSync(join(import.meta.dirname, 'ops/ops-stop.sh'), join(dir, 'scripts/ops/ops-stop.sh'));
  for (const p of ['ck-auto.sh', 'ck-auto-queue.ts', 'lib/ck-auto-queue.ts']) copyFileSync(join(import.meta.dirname, p), join(dir, 'scripts', p));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module', scripts: { 'ck:queue': 'node scripts/fake-queue.mjs', 'ops:usage': 'node scripts/fake-ops.mjs' } }));
  // 운영 DB 점검 대역 — OPS_CODE=3 이면 멈춤. 호출 인자는 order 를 흐리지 않게 ops 파일에 따로 남긴다.
  writeFileSync(join(dir, 'scripts/fake-ops.mjs'), String.raw`
import * as fs from 'node:fs';
fs.appendFileSync('ops', process.argv.slice(2).join(' ')+'\n');
const code = Number(process.env.OPS_CODE ?? 0);
console.log(code ? 'DB 점검 멈춤 — fixture' : 'DB 점검 정상');
process.exit(code);
`);
  writeFileSync(join(dir, 'scripts/fake-queue.mjs'), String.raw`
import * as fs from 'node:fs';
const args = process.argv.slice(2), cmd = args[0], opt = k => args[args.indexOf(k)+1];
fs.appendFileSync('order', cmd+':'+(args.includes('--vod')?opt('--vod'):'')+'\n');
if (cmd === 'plan') { if(process.env.PLAN_CODE==='1')process.exit(1); fs.copyFileSync('plan.json', opt('--write')); process.exit(Number(process.env.PLAN_CODE??0)); }
if (cmd === 'fc') fs.writeFileSync(opt('--write'), JSON.stringify({ from:'2026-10-01', queue: [] }));
if (cmd === 'begin') process.exit(fs.existsSync('done-'+opt('--vod'))?3:Number(process.env.BEGIN_CODE??0));
if (cmd === 'finish') { const code=Number(process.env.FINISH_CODE??3); if(code===3)fs.writeFileSync('done-'+opt('--vod'),''); process.exit(code); }
`);
  writeFileSync(join(dir, 'scripts/ck-local/scan.mjs'), "console.log('PREP: fixture');");
  if (env.LISTEN_CODE !== undefined) {
    mkdirSync(join(dir, 'scripts/ck-listen'), { recursive: true });
    writeFileSync(join(dir, 'scripts/ck-listen/cli.mjs'), '');
    writeFileSync(join(dir, 'scripts/ck-listen.mjs'), "import * as fs from 'node:fs';fs.appendFileSync('order','listen:'+process.argv.slice(2).join(' ')+'\\n');process.exit(Number(process.env.LISTEN_CODE));");
  }
  writeFileSync(join(dir, 'scripts/ck-image-budget.ts'), String.raw`
import * as fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
const args=process.argv.slice(2), vod=args[args.indexOf('--vod')+1];
fs.appendFileSync('order','session:'+vod+'\n');
if(process.env.PROMPT_FILE)fs.writeFileSync(process.env.PROMPT_FILE,args[args.indexOf('-p')+1]); // 세션에 넘긴 지시문
while(!fs.existsSync('go-'+vod))await delay(30);
fs.appendFileSync('order','end:'+vod+'\n');
fs.writeFileSync(args[args.indexOf('--output')+1], '{}');
process.exit(Number(process.env.SESSION_CODE??0));
`);
  // 아카이브를 포함한 부수 작업도 fixture에서 외부 부작용 없이 끝낸다.
  for (const p of ['ck-session-usage.ts', 'ck-neighbors.ts', 'ck-archive.ts']) writeFileSync(join(dir, 'scripts', p), '');
  const children: ReturnType<typeof spawn>[] = [];
  const start = (mode: string) => {
    const child = spawn('bash', [join(dir, 'scripts/ck-auto.sh'), mode], { cwd: dir, stdio: 'ignore',
      env: { ...process.env, CK_AUTO_IDLE_SEC: '0.05', CK_AUTO_STAGGER_SEC: '0', CK_AUTO_MIN_FREE_GB: '0', ...env } });
    children.push(child);
    return { child, done: new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }) };
  };
  const plan = (items: [number, string][]) => writeFileSync(join(dir, 'plan.json'), JSON.stringify({ queue: items.map(([n, ch]) => ({
    key: `vod:${n}`, title_no: n, channel_id: ch, streamer: ch, slug: ch, title: 'fixture', ended_at: '2026-10-09 12:00:00', hours: 1, category: null, reason: 'unseen',
  })) }));
  const order = () => existsSync(join(dir, 'order')) ? readFileSync(join(dir, 'order'), 'utf8') : '';
  const queue = (): AutoQueue => JSON.parse(readFileSync(join(dir, 'out/ck/auto/queue.json'), 'utf8'));
  const go = (...vods: number[]) => { for (const vod of vods) writeFileSync(join(dir, 'go-'+vod), ''); };
  return { dir, start, plan, order, queue, go, cleanup: async () => {
    go(...Array.from({ length: 20 }, (_, i) => i));
    for(const c of children) if(c.exitCode===null) c.kill('SIGTERM');
    await delay(200); rmSync(dir, { recursive: true, force: true });
  } };
}

test('조회 중 기존 조사를 유지하고, 빈 작업자가 새 대기를 즉시 이어받으며 동시 조사는 최대 3개', async () => {
  const f = fixture(); try {
    f.plan([[1,'a'],[2,'b'],[3,'c'],[4,'a']]);
    assert.equal(await f.start('--poll').done, 0); assert.doesNotMatch(f.order(), /session:|fc:/);
    const run = f.start('--work');
    await until(() => [1,2,3].every(n => f.order().includes(`session:${n}\n`)));
    const second = f.start('--work'); // 중복 조사 풀은 잠금을 기다리며 세션을 시작하지 않는다
    f.plan([[1,'a'],[2,'b'],[3,'c'],[4,'a'],[5,'d']]);
    assert.equal(await f.start('--poll').done, 0);
    assert.equal(f.order().match(/session:/g)?.length, 3);
    f.go(2);
    await until(() => f.order().includes('session:5\n')); // a 채널 4번은 기다리고 새 채널은 바로 조사
    assert.doesNotMatch(f.order(), /session:4\n/);
    f.go(1,3,5);
    await until(() => f.order().includes('session:4\n')); f.go(4);
    assert.equal(await run.done, 0);
    assert.equal(await second.done, 0);
    for (const n of [1,2,3,4,5]) assert.equal(f.order().split('\n').filter(x => x===`session:${n}`).length, 1);
    assert.equal(Object.keys(f.queue().jobs).length, 0);
    assert.equal(await f.start('--work').done, 0); // 종료 순간 남은 wake 요청을 소비해도 재조사 없음
    assert.ok(!existsSync(join(f.dir,'out/ck/auto/wake')));
  } finally { await f.cleanup(); }
});

test('기존 완료 VOD는 새 세션 없이 제외하고 미완료는 즉시 반복하지 않는다', async () => {
  const f = fixture({ FINISH_CODE:'4' }); try {
    f.plan([[1,'a'],[2,'b']]); writeFileSync(join(f.dir, 'done-1'),''); f.go(2);
    assert.equal(await f.start('--poll').done, 0); assert.equal(await f.start('--work').done, 0);
    assert.doesNotMatch(f.order(), /session:1\n/);
    const retry = f.queue().jobs['vod:2'].not_before;
    assert.ok(retry > Date.now()+5*3600_000);
    f.plan([[2,'b']]); assert.equal(await f.start('--poll').done, 0);
    assert.equal(f.queue().jobs['vod:2'].not_before,retry);
    assert.equal(await f.start('--work').done,0);
    assert.equal(f.order().match(/session:2/g)?.length,1);
  } finally { await f.cleanup(); }
});

test('세션 실패도 진척을 확인하고 소유권을 돌려주며 깨우기 요청으로 무한 재시작하지 않는다', async () => {
  const f = fixture({ SESSION_CODE:'9', FINISH_CODE:'0' }); try {
    f.plan([[1,'a']]); f.go(1); await f.start('--poll').done;
    assert.equal(await f.start('--work').done,9);
    assert.match(f.order(),/session:1[\s\S]*finish:1/);
    assert.equal(f.queue().jobs['vod:1'].owner,undefined);
    assert.ok(!existsSync(join(f.dir,'out/ck/auto/wake')));
  } finally { await f.cleanup(); }
});

test('미리보기는 실행 큐를 만들지 않고 FC는 별도 모드에서만 조회한다', async () => {
  const f = fixture(); try {
    f.plan([[1,'a']]); assert.equal(await f.start('--dry-run').done,0);
    assert.ok(!existsSync(join(f.dir,'out/ck/auto/queue.json')));
    assert.doesNotMatch(f.order(),/session:|fc:/);
    assert.equal(await f.start('--fc').done,0); assert.match(f.order(),/fc:/);
  } finally { await f.cleanup(); }
});

test('발견 실패 시 기존 대기를 보존하고 조회 잘림은 받은 목록을 등록한다', async () => {
  const f = fixture({ PLAN_CODE:'2' }); try {
    f.plan([[1,'a']]); assert.equal(await f.start('--poll').done,0);
    assert.ok(f.queue().jobs['vod:1']);
  } finally { await f.cleanup(); }
  const g = fixture({ PLAN_CODE:'1' }); try {
    g.plan([[1,'a']]); assert.equal(await g.start('--poll').done,1);
    assert.ok(!existsSync(join(g.dir,'out/ck/auto/queue.json')));
    assert.doesNotMatch(g.order(),/session:/);
  } finally { await g.cleanup(); }
});

test('백필이 채널 잠금을 잡고 있으면 세션 없이 미루고 다른 채널은 처리한다', async () => {
  const f = fixture(); let lock: ReturnType<typeof spawn> | undefined;
  try {
    mkdirSync(join(f.dir,'out/ck/backfill'),{recursive:true});
    lock = spawn('flock',[join(f.dir,'out/ck/backfill/channel-a.lock'),'bash','-c','touch locked; read -r line'],{cwd:f.dir,stdio:['pipe','ignore','ignore']});
    await until(() => existsSync(join(f.dir,'locked')));
    f.plan([[1,'a'],[2,'b']]); f.go(2);
    await f.start('--poll').done; assert.equal(await f.start('--work').done,0);
    assert.doesNotMatch(f.order(),/session:1\n/); assert.match(f.order(),/session:2\n/);
    assert.equal(f.queue().jobs['vod:1'].owner,undefined);
    assert.ok(f.queue().jobs['vod:1'].not_before>Date.now());
  } finally { lock?.stdin?.end('\n'); await f.cleanup(); }
});

test('STOP은 현재 세션을 저장한 뒤 대기를 보존하고 다음 실행이 중단된 소유권을 복구한다', async () => {
  const f = fixture({ CK_AUTO_LOL_JOBS:'1' }); try {
    f.plan([[1,'a'],[2,'b']]); await f.start('--poll').done;
    const run=f.start('--work'); await until(() => f.order().includes('session:1\n'));
    writeFileSync(join(f.dir,'out/ck/auto/STOP'),''); f.go(1);
    assert.equal(await run.done,3); assert.match(f.order(),/finish:1\n/); assert.doesNotMatch(f.order(),/session:2\n/);
    assert.ok(f.queue().jobs['vod:2']);
    const q=f.queue(); q.jobs['vod:2'].owner='previous-crashed-worker';
    writeFileSync(join(f.dir,'out/ck/auto/queue.json'),JSON.stringify(q));
    f.go(2); assert.equal(await f.start('--work').done,0);
    assert.match(f.order(),/session:2\n/); assert.equal(Object.keys(f.queue().jobs).length,0);
  } finally { await f.cleanup(); }
});

test('운영 DB 점검이 멈춤이면 세션을 하나도 띄우지 않고 대기와 깨우기를 정리한다', async () => {
  const f = fixture({ OPS_CODE: '3' }); try {
    f.plan([[1,'a']]); f.go(1);
    assert.equal(await f.start('--poll').done, 0);
    assert.ok(existsSync(join(f.dir, 'out/ck/auto/wake')));
    assert.equal(await f.start('--work').done, 3);
    assert.doesNotMatch(f.order(), /session:|begin:/);
    assert.ok(f.queue().jobs['vod:1'], '대기는 보존한다');
    assert.ok(!existsSync(join(f.dir, 'out/ck/auto/wake')), '깨우기를 지워 path 가 곧바로 다시 띄우지 않는다');
    assert.match(readFileSync(join(f.dir, 'ops'), 'utf8'), /^--gate --clear-flag$/m);
    assert.equal(await f.start('--fc').done, 3);
    assert.doesNotMatch(f.order(), /fc:/);
  } finally { await f.cleanup(); }
});

test('쓰기 실패 표시가 생기면 다음 세션을 시작하지 않는다', async () => {
  const f = fixture({ SESSION_CODE: '0', FINISH_CODE: '0' }); try {
    f.plan([[1,'a'],[2,'b']]); await f.start('--poll').done;
    // 대역 점검은 표시를 지우지 않는다 — 회차 도중 다른 세션이 쓰기에 실패한 상황
    mkdirSync(join(f.dir, 'out/ops'), { recursive: true });
    writeFileSync(join(f.dir, 'out/ops/write-blocked.json'), '{}');
    f.go(1, 2);
    assert.equal(await f.start('--work').done, 3);
    assert.doesNotMatch(f.order(), /session:/);
  } finally { await f.cleanup(); }
});
