// Linux/WSL advisory lock. The child owns flock until stdin closes, including parent crashes.
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
export async function withFileLock(path, work, waitSeconds = 120) {
  await mkdir(dirname(path), { recursive: true });
  const child = spawn('flock', ['-x', '-w', String(waitSeconds), path, process.execPath, '-e',
    'process.stdout.write("locked\\n");process.stdin.resume()'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = new Promise(resolve => child.once('close', resolve));
  child.stdin.on('error', () => {});
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => reject(new Error(`Lock unavailable: ${path} (${code})`)));
      child.stdout.once('data', resolve);
    });
    return await work();
  } finally { child.stdin.end(); await closed; }
}
