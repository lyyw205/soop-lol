import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';

export const ROOT = resolve(import.meta.dirname, '../..');
export const OUTPUT = join(ROOT, 'out/ck-context');
export const readJSON = path => JSON.parse(readFileSync(path, 'utf8'));
export const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
export const hms = sec => `${Math.floor(sec / 3600)}:${String(Math.floor(sec % 3600 / 60)).padStart(2, '0')}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

// New outputs cannot be routed into production, including through a symlink.
export function ownedDirectory(path) {
  const absolute = resolve(path);
  const inside = (base, file) => { const r = relative(base, file); return r && r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r); };
  if (!inside(OUTPUT, absolute)) throw new Error(`실험 출력은 ${OUTPUT}/ 아래에 둡니다: ${absolute}`);
  let ancestor = absolute;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const actual = resolve(realpathSync(ancestor), relative(ancestor, absolute));
  if (actual !== absolute) throw new Error(`실험 출력 경로의 심볼릭 링크는 허용하지 않습니다: ${absolute}`);
  return absolute;
}

export function writeJSON(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}

export function lock(directory) {
  ownedDirectory(directory); mkdirSync(directory, { recursive: true });
  const path = join(directory, '.running');
  let fd;
  try { fd = openSync(path, 'wx'); } catch { throw new Error(`실행 중이거나 이전 실행 잠금이 남았습니다: ${path}`); }
  writeFileSync(fd, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() })); closeSync(fd);
  return () => { if (existsSync(path)) unlinkSync(path); };
}

export async function command(executable, args, logFile, { env = process.env } = {}) {
  mkdirSync(dirname(logFile), { recursive: true });
  const fd = openSync(logFile, 'a');
  try {
    await new Promise((ok, fail) => {
      const child = spawn(executable, args, { cwd: ROOT, env, stdio: ['ignore', fd, fd] });
      child.on('error', fail);
      child.on('exit', (code, signal) => code === 0 ? ok() : fail(new Error(`${executable}: exit=${code}, signal=${signal}; ${logFile}`)));
    });
  } finally { closeSync(fd); }
}

export function mergedRanges(ranges) {
  const result = [];
  for (const [a, b] of ranges.map(r => [...r]).sort((a, b) => a[0] - b[0])) {
    if (![a, b].every(Number.isFinite) || a < 0 || b < a) throw new Error('잘못된 시간 범위');
    if (a === b) continue;
    if (result.length && a <= result.at(-1)[1] + 0.01) result.at(-1)[1] = Math.max(b, result.at(-1)[1]);
    else result.push([a, b]);
  }
  return result;
}

export function missingRanges(total, ranges) {
  let cursor = 0; const gaps = [];
  for (const [start, end] of mergedRanges(ranges)) {
    if (start > cursor) gaps.push([cursor, Math.min(start, total)]);
    cursor = Math.max(cursor, end);
  }
  if (cursor < total) gaps.push([cursor, total]);
  return gaps.filter(([a, b]) => b > a);
}
