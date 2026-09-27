// Download only selected HLS segments through the existing paced SOOP gateway.
import { mkdir, readFile, writeFile, rename, stat, open } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { soopFetch } from '../lib/soop-http.mjs';

const vodId = process.argv[2];
if (!/^\d+$/.test(vodId ?? '') || !process.argv[3]) throw new Error('Usage: sample-vod.mjs <vodId> <start:duration,...>');
const dir = resolve('.local/asr/runs', vodId);
const probe = JSON.parse(await readFile(join(dir, 'probe.json'), 'utf8'));
const ranges = process.argv[3]
  .split(',').map(x => x.split(':').map(Number));
if (ranges.some(([s, d]) => !Number.isFinite(s) || s < 0 || !Number.isFinite(d) || d <= 0)) {
  throw new Error('Ranges must contain finite nonnegative starts and positive durations');
}
await mkdir(join(dir, 'segments'), { recursive: true });
await mkdir(join(dir, 'audio'), { recursive: true });
await mkdir(join(dir, 'frames'), { recursive: true });
let bytesDownloaded = 0;
const start = performance.now();
async function download(url, path) {
  try { if ((await stat(path)).size > 0) return; } catch {}
  let error;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await soopFetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = Buffer.from(await r.arrayBuffer());
      if (!data.length) throw new Error('Empty segment');
      await writeFile(`${path}.part`, data);
      await rename(`${path}.part`, path);
      bytesDownloaded += data.length;
      return;
    } catch (e) { error = e; }
  }
  throw error;
}
const clips = [];
for (const [at, seconds] of ranges) {
  const part = probe.parts.find(p => at >= p.offset && at + seconds <= p.offset + p.actualSeconds);
  if (!part) throw new Error(`Range ${at}:${seconds} crosses a file boundary or unavailable footage`);
  const lines = (await readFile(join(dir, `part-${part.index}.media.m3u8`), 'utf8')).split(/\r?\n/).map(x => x.trim());
  if (lines.some(x => /^#EXT-X-(KEY|BYTERANGE|DISCONTINUITY)(:|$)/.test(x))) {
    throw new Error('Encrypted, byte-range or discontinuous HLS needs a dedicated extractor');
  }
  const initUri = lines.find(x => x.startsWith('#EXT-X-MAP:'))?.match(/URI="([^"]+)"/)?.[1];
  let cursor = 0;
  const segments = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXTINF:')) continue;
    const duration = Number(lines[i].slice(8).split(',')[0]);
    segments.push({ index: segments.length, start: cursor, duration, uri: lines[i + 1] });
    cursor += duration;
  }
  const localAt = at - part.offset;
  const chosen = segments.filter(s => s.start + s.duration > localAt && s.start < localAt + seconds);
  const id = `at-${at}-s${seconds}`;
  const input = join(dir, 'segments', `${id}.mp4`);
  const paths = [];
  if (initUri) {
    const path = join(dir, 'segments', `p${part.index}-init.m4s`);
    await download(new URL(initUri, part.selected.url), path);
    paths.push(path);
  }
  console.log(`Downloading ${id}: ${chosen.length} segments from part ${part.index + 1}`);
  for (const seg of chosen) {
    const path = join(dir, 'segments', `p${part.index}-${seg.index}.m4s`);
    await download(new URL(seg.uri, part.selected.url), path);
    paths.push(path);
  }
  const handle = await open(input, 'w');
  try { for (const path of paths) await handle.writeFile(await readFile(path)); }
  finally { await handle.close(); }
  const trim = localAt - chosen[0].start;
  const audio = join(dir, 'audio', `${id}.wav`);
  const frame = join(dir, 'frames', `${id}.jpg`);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', input,
    '-ss', String(trim), '-t', String(seconds), '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000',
    '-c:a', 'pcm_s16le', audio], { timeout: 120000 });
  const duration = Number(execFileSync('python3', ['-c', [
    'import wave,sys,os',
    'path=sys.argv[1]; wanted=round(float(sys.argv[2])*16000)',
    'with wave.open(path) as w:',
    ' assert w.getnchannels()==1 and w.getframerate()==16000',
    ' params=w.getparams(); count=w.getnframes(); data=w.readframes(wanted)',
    'if count>wanted:',
    ' with wave.open(path+".trim", "wb") as w: w.setparams(params); w.writeframes(data)',
    ' os.replace(path+".trim",path)',
    'print(min(count,wanted)/16000)',
  ].join('\n'), audio, String(seconds)], { encoding: 'utf8' }));
  if (Math.abs(duration - seconds) > 0.2) throw new Error(`Truncated audio: ${duration}/${seconds}`);
  if (!part.audioOnly) {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', input,
      '-ss', String(trim + seconds / 2), '-frames:v', '1', '-q:v', '3', frame], { timeout: 120000 });
  }
  clips.push({ id, at, seconds: duration, partIndex: part.index, partLocalAt: localAt, audio, frame: part.audioOnly ? null : frame });
  const manifest = { vodId, title: probe.title, vodSeconds: probe.declaredSeconds,
    timestampBasis: 'API file-duration cumulative offsets; local HLS offsets within each file',
    complete: clips.length === ranges.length, plannedRanges: ranges, clips,
    bytesDownloaded, extractionSeconds: (performance.now() - start) / 1000 };
  await writeFile(join(dir, 'samples.json'), JSON.stringify(manifest, null, 2));
  console.log(`Saved ${id}: ${duration}s (${clips.length}/${ranges.length})`);
}
console.log(JSON.stringify({ clips: clips.length, seconds: clips.reduce((s, c) => s + c.seconds, 0),
  bytesDownloaded, wallSeconds: (performance.now() - start) / 1000 }));
