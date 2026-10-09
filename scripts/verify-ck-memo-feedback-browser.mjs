/** Real server action against an isolated filesystem; production DB is only read. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const root = process.cwd(), scratch = await mkdtemp(join(tmpdir(), 'memo-ui-'));
const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
const port = server.address().port; server.close(); await once(server, 'close');
const vod = '206156659', directory = join(scratch, 'ck', vod, 'local');
const dist = `.next-memo-test-${process.pid}`;
let app, browser;
try {
  await mkdir(directory, { recursive: true });
  const source = join(root, 'out/ck', vod, 'local');
  for (const file of ['memo.json', 'sheets.json']) await copyFile(join(source, file), join(directory, file));
  const manifest = JSON.parse(await readFile(join(directory, 'memo.json'), 'utf8'));
  const thumb = manifest.groups[0].thumbnail;
  await mkdir(join(scratch, thumb, '..'), { recursive: true });
  await copyFile(join(root, 'out', thumb), join(scratch, thumb));
  app = spawn(process.execPath, [join(root, 'node_modules/next/dist/bin/next'), 'dev', '--webpack', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: join(root, 'apps/web'), env: { ...process.env, CK_OUT_ROOT: scratch, NEXT_DIST_DIR: dist,
      ADMIN_USER: 'memo-test', ADMIN_PASSWORD: 'local-only', NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = ''; app.stdout.on('data', c => log += c); app.stderr.on('data', c => log += c);
  const base = `http://127.0.0.1:${port}`, headers = { authorization: 'Basic '+Buffer.from('memo-test:local-only').toString('base64') };
  const deadline = Date.now()+120000;
  while (true) {
    if (app.exitCode !== null || Date.now() > deadline) throw new Error('Test server not ready: '+log.slice(-1500));
    try { if ((await fetch(base+'/admin/ck/memo/'+vod, { headers })).ok) break; } catch {}
    await new Promise(r => setTimeout(r, 300));
  }
  browser = await chromium.launch();
  const context = await browser.newContext({ httpCredentials: { username: 'memo-test', password: 'local-only' } });
  const page = await context.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
  const response = await page.goto(base+'/admin/ck/event/ck-2026-09-03-babamba-okkyu');
  await page.locator('.ck-review-queue-item[data-kind="memo"]').first().waitFor().catch(async error => {
    console.log({status: response.status(), errors, body: (await page.locator('body').innerText()).slice(0,1200), links: await page.locator('a[href*=player]').evaluateAll(links => links.map(x => x.href))}); throw error;
  });
  await page.locator('.ck-review-queue-item[data-kind="memo"]').first().click();
  const dialog = page.locator('.ck-memo-inline');
  await dialog.getByRole('button', { name: '모르겠음', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '학습용 표시를 저장했습니다' }).waitFor();
  const records = (await readFile(join(directory, 'memo-feedback.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(records.length, 1); assert.equal(records[0].label, 'unknown');
  assert.equal(records[0].at, manifest.groups[0].representative_at);
  await page.reload();
  await page.locator('.ck-review-queue-item[data-kind="memo"]').first().click();
  assert.equal(await page.getByRole('button', { name: '모르겠음', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.deepEqual(errors, []);
  const report = { server_action_saved: true, persisted_after_reload: true, production_feedback_written: false, errors };
  await writeFile('out/ck-memo-training/feedback-browser-report.json', JSON.stringify(report, null, 2));
  console.log(report);
} finally {
  if (browser) await browser.close();
  if (app && app.exitCode === null) { const exit = once(app, 'exit'); app.kill('SIGTERM'); await exit; }
  await rm(scratch, { recursive: true, force: true });
  await rm(join(root, 'apps/web', dist), { recursive: true, force: true });
}
