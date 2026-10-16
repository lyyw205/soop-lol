/** Read-only adapter for ck-local, or isolated preparation using its unchanged detector. */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, hash, hms, readJSON, writeJSON } from './common.mjs';
import { vodDetail, hlsSegments, segmentAt } from '../lib/soop-vod.mjs';
import { cellIndexAt, cellOf, coveragePoints, decodeSheet, fetchSheets, measureParts } from '../lib/vod-timeline.mjs';
import { encode, montage } from '../ck-local/image.mjs';
import { writeNameCrop } from '../lib/result-names.mjs';

export function snapshotScan(path, directory, vod) {
  const source = readJSON(path);
  if (String(source.vod_id) !== String(vod) || !(source.total_sec > 0) || !Array.isArray(source.candidates)) throw new Error('VOD가 맞는 ck-local scan.json이 필요합니다.');
  const scan = structuredClone(source), copied = new Map();
  mkdirSync(join(directory, 'frames'), { recursive: true });
  function snapshot(file, base = ROOT) {
    if (!file) return null;
    const original = resolve(base, file);
    if (!existsSync(original)) return null;
    if (!copied.has(original)) {
      const bytes = readFileSync(original), destination = join(directory, 'frames', `${hash(bytes).slice(0, 12)}-${basename(original)}`);
      copyFileSync(original, destination); copied.set(original, destination);
    }
    return copied.get(original);
  }
  for (const c of scan.candidates) {
    c.frame = snapshot(c.frame); c.names = snapshot(c.names);
    c.first_frame = snapshot(`out/ck/${vod}/g${String(c.from).padStart(7, '0')}.jpg`);
  }
  for (const f of scan.file_tails ?? []) f.frame = snapshot(f.frame);
  for (const field of ['overview_pages', 'candidate_pages']) scan[field] = (scan[field] ?? []).map(p => snapshot(p, dirname(path))).filter(Boolean);
  scan.source = { path: resolve(path), sha256: hash(readFileSync(path)), run_id: source.run_id, mode: 'ck-local-snapshot' };
  scan.frame_failures = scan.candidates.filter(c => !c.frame).map(c => ({ at: c.peak, reason: '원본 누락; 후보는 유지' }));
  const probe = join(ROOT, 'out/ck', String(vod), 'probe.json');
  if (existsSync(probe)) writeJSON(join(directory, 'probe.json'), readJSON(probe));
  writeJSON(join(directory, 'source-scan.json'), source);
  writeJSON(join(directory, 'scan.json'), scan);
  return scan;
}

export function addFrames(scan, directory, specs) {
  scan.extra_frames ??= [];
  for (const spec of specs) {
    const separator = spec.indexOf('=');
    const at = Number(spec.slice(0, separator)), path = resolve(ROOT, spec.slice(separator + 1));
    if (separator < 1 || !Number.isFinite(at) || at < 0 || at >= scan.total_sec || !existsSync(path)) throw new Error(`--frame 시작초=이미지경로: ${spec}`);
    const destination = join(directory, 'frames', `${hash(readFileSync(path)).slice(0, 12)}-${basename(path)}`);
    mkdirSync(dirname(destination), { recursive: true }); copyFileSync(path, destination);
    if (!scan.extra_frames.some(f => f.at === at && f.frame === destination)) scan.extra_frames.push({ at, frame: destination });
  }
  writeJSON(join(directory, 'scan.json'), scan);
}

export async function prepareFresh(vod, directory) {
  const detail = await vodDetail(vod);
  if (!detail) throw new Error(`VOD를 찾지 못했습니다: ${vod}`);
  const measured = await measureParts(detail);
  const { parts, total } = measured;
  const failed = [...measured.failed];
  const meta = { vod: Number(vod), parts: [] };
  for (const p of parts) {
    const got = p.axisReliable ? await fetchSheets(p.file, p.length, { cacheDir: join(directory, 'sheets', `f${p.index}`) }) : null;
    for (const [a, b] of got?.failed ?? []) failed.push([p.offset + a, p.offset + b]);
    meta.parts.push({ index: p.index, offset: p.offset, length: p.length, reliable: Boolean(got), cells: got?.cells ?? 0,
      sheets: (got?.sheets ?? []).map(s => join(directory, 'sheets', `f${p.index}`, `c${s.column}.jpg`)) });
    p.sheetsGot = got;
  }
  writeJSON(join(directory, 'sheets.json'), meta);
  writeJSON(join(directory, 'probe.json'), { vod_id: Number(vod), title: detail.title, total_sec: total, timestampBasis: 'HLS',
    parts: parts.map(p => ({ index: p.index, offset_sec: p.offset, length_sec: p.length, axisReliable: p.axisReliable })), failed: measured.failed });
  const detector = join(ROOT, 'scripts/ck-local/detector/detect.py');
  const raw = execFileSync(join(ROOT, 'out/ck-detector/venv/bin/python'), [detector, '--meta', join(directory, 'sheets.json'), '--memo', 'off'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  const det = JSON.parse(raw);
  writeJSON(join(directory, 'detector.json'), det);
  const scan = { schema: 1, vod_id: Number(vod), title: detail.title, total_sec: total, run_id: basename(directory),
    detector: { model: det.model, threshold: det.threshold, min_len: det.min_len }, cells: det.cells, failed,
    candidates: det.candidates.map((c, i) => ({ n: i + 1, ...c })), map: det.timeline,
    file_tails: parts.filter(p => p.axisReliable && p.length > 0).map(p => ({ at: Math.round(Math.max(p.offset, p.offset + p.length - 30)) })),
    source: { mode: 'isolated-preparation', detector_sha256: hash(readFileSync(detector)),
      model_files: Object.fromEntries(['clf.npz', 'multi.npz'].map(name => {
        const path = join(ROOT, 'out/ck-detector/model/siglip', name);
        return [name, existsSync(path) ? hash(readFileSync(path)) : null];
      })) }, frame_failures: [] };
  const playlists = new Map();
  mkdirSync(join(directory, 'frames'), { recursive: true });
  for (const at of [...new Set([...scan.candidates.flatMap(c => [c.from, c.peak]), ...scan.file_tails.map(f => f.at)])]) {
    const target = join(directory, 'frames', `g${String(at).padStart(7, '0')}.jpg`);
    const temp = `${target}.src`;
    try {
      const p = parts.find(p => p.axisReliable && at >= p.offset && at < p.offset + p.length);
      if (!p) throw new Error('신뢰할 수 있는 시간축 없음');
      if (!playlists.has(p.index)) playlists.set(p.index, await hlsSegments(p.file));
      const seg = await segmentAt(playlists.get(p.index), at - p.offset);
      if (!seg) throw new Error('세그먼트 없음');
      writeFileSync(temp, seg.data);
      execFileSync(process.env.FFMPEG_PATH ?? 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(seg.offset), '-i', temp, '-frames:v', '1', '-q:v', '2', target], { timeout: 60000 });
    } catch (e) { if (existsSync(target)) unlinkSync(target); scan.frame_failures.push({ at, reason: e.message }); }
    finally { if (existsSync(temp)) unlinkSync(temp); }
  }
  const frame = at => { const p = join(directory, 'frames', `g${String(at).padStart(7, '0')}.jpg`); return existsSync(p) ? p : null; };
  for (const c of scan.candidates) {
    c.frame = frame(c.peak); c.first_frame = frame(c.from); c.names = null;
    if (c.frame) {
      try { c.names = (await writeNameCrop(c.frame)).path ?? null; }
      catch (e) { scan.frame_failures.push({ at: c.peak, kind: 'name_crop', reason: e.message }); }
    }
  }
  for (const f of scan.file_tails) f.frame = frame(f.at);
  let decoded = { key: null, image: null };
  function tile(at) {
    const p = parts.find(p => at >= p.offset && at < p.offset + p.length), got = p?.sheetsGot;
    const pos = got && cellIndexAt(got.sheets, got.cells, at - p.offset);
    if (!pos) return { width: 192, height: 108, data: Buffer.alloc(192 * 108 * 4) };
    const sheet = got.sheets[pos.sheet];
    if (decoded.key !== sheet.sha) decoded = { key: sheet.sha, image: decodeSheet(sheet.buf) };
    return cellOf(decoded.image, pos.cell);
  }
  function pages(points, name, per, cols) {
    const paths = [];
    for (let i = 0; i < points.length; i += per) {
      const path = join(directory, `${name}-${paths.length + 1}.jpg`);
      writeFileSync(path, encode(montage(points.slice(i, i + per).map(at => ({ img: tile(at), color: [70, 70, 70], label: hms(at) })), cols), 85)); paths.push(path);
    }
    return paths;
  }
  scan.overview_pages = pages(coveragePoints(parts, total, 120), 'overview', 60, 10);
  scan.candidate_pages = pages(scan.candidates.map(c => c.peak), 'candidates', 40, 8);
  writeJSON(join(directory, 'scan.json'), scan);
  return scan;
}
