import { readFile, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { withFileLock } from './file-lock.mjs';
const defaultPath = fileURLToPath(new URL('../../out/locks/soop-board', import.meta.url));
export class SoopBoardCooldown extends Error {
  constructor(until) { super(`SOOP 게시판 대기 중: ${new Date(until).toISOString()}`); this.name = 'SoopBoardCooldown'; }
}
export async function boardGate(work, { path = defaultPath, interval = 20000, cooldown = 3600000 } = {}) {
  return withFileLock(`${path}.lock`, async () => {
    let state = {};
    try { state = JSON.parse(await readFile(`${path}.json`, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (state.until > Date.now()) throw new SoopBoardCooldown(state.until);
    await new Promise(r => setTimeout(r, Math.max(0, (state.last ?? 0) + interval - Date.now())));
    const save = async () => { await writeFile(`${path}.tmp`, JSON.stringify(state)); await rename(`${path}.tmp`, `${path}.json`); };
    state.last = Date.now(); await save();
    const response = await work();
    if ([429, 515].includes(response.status)) {
      const retry = response.headers.get('retry-after');
      const delay = /^\d+$/.test(retry ?? '') ? Number(retry) * 1000 : Math.max(0, Date.parse(retry ?? '') - Date.now()) || 0;
      state.until = Date.now() + Math.max(cooldown, delay); await save();
    }
    return response;
  });
}
