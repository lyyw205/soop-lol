import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, command, hash, mergedRanges, readJSON, writeJSON } from './common.mjs';
import { vodDetail, hlsSegments, segmentsSpan } from '../lib/soop-vod.mjs';
import { measureParts } from '../lib/vod-timeline.mjs';
import { splitAudioRanges } from '../lib/ck-audio.ts';

export function boundedAudio(requested, parts, limit = 300) {
  if (!(limit > 0 && limit <= 300)) throw new Error('음성 다운로드 조각은 300초 이하여야 합니다.');
  const bounded = requested.flatMap(([at, span]) => {
    if (![at, span].every(Number.isFinite) || at < 0 || span <= 0) throw new Error('음성 범위: 시작초:양수길이');
    const result = [];
    for (let t = at; t < at + span; t += limit) result.push([t, Math.min(limit, at + span - t)]);
    return result;
  });
  const result = splitAudioRanges(bounded, parts);
  if (result.outOfRange.length) throw new Error(`시간축 범위 밖: ${JSON.stringify(result.outOfRange)}`);
  return result.pieces;
}

export async function transcribeAudio(scan, directory, requested = [[0, scan.total_sec]], engine = 'sensevoice') {
  if (!['sensevoice', 'qwen'].includes(engine)) throw new Error('지원하지 않는 전사 엔진');
  const batch = join(directory, 'audio-runs', `${engine}-${hash(requested).slice(0, 12)}`);
  mkdirSync(batch, { recursive: true });
  const manifestPath = join(batch, 'samples.json'), output = join(batch, `${engine}.transcript.json`);
  if (existsSync(output) && readJSON(output).complete) return output;
  const detail = await vodDetail(String(scan.vod_id));
  if (!detail) throw new Error('VOD를 찾지 못했습니다.');
  const measured = await measureParts(detail);
  if (measured.parts.some(p => !p.axisReliable) || Math.abs(measured.total - scan.total_sec) > 2) throw new Error('프레임과 음성의 HLS 시간축을 확인할 수 없습니다.');
  const parts = measured.parts.map(p => ({ index: p.index, offset_sec: p.offset, length_sec: p.length }));
  const pieces = boundedAudio(requested, parts), clips = [], failed = [], playlists = new Map();
  const started = Date.now(); let bytes = 0;
  const save = () => writeJSON(manifestPath, { vodId: scan.vod_id, title: scan.title, vodSeconds: scan.total_sec,
    timestampBasis: 'ck:probe HLS global seconds', plannedRanges: requested,
    complete: clips.length === pieces.length && failed.length === 0, clips, failed, bytesDownloaded: bytes,
    extractionSeconds: (Date.now() - started) / 1000 });
  for (const [index, p] of pieces.entries()) {
    const id = `g${p.at}-s${p.span}`, wav = join(batch, `${id}.wav`), temp = join(batch, `${id}.src`);
    try {
      if (!existsSync(wav)) {
        if (!playlists.has(p.part.index)) playlists.set(p.part.index, await hlsSegments(detail.files[p.part.index - 1], { prefer: 'audio' }));
        const got = await segmentsSpan(playlists.get(p.part.index), p.at - p.part.offset_sec, p.span);
        if (!got) throw new Error('음성 세그먼트 없음');
        bytes += got.bytes; writeFileSync(temp, got.data);
        execFileSync(process.env.FFMPEG_PATH ?? 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', temp,
          '-ss', String(got.offset), '-t', String(p.span), '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', `${wav}.part.wav`], { timeout: 180000 });
        // ffmpeg can leave milliseconds of padding; do not create an extra ASR chunk.
        execFileSync('python3', ['-c', 'import sys,wave\np=sys.argv[1];n=round(float(sys.argv[2])*16000)\nwith wave.open(p) as w:\n assert w.getnchannels()==1 and w.getframerate()==16000 and w.getsampwidth()==2\n assert abs(w.getnframes()-n)<=3200,"Truncated audio"\n data=w.readframes(n)\nwith wave.open(p,"wb") as w:\n w.setnchannels(1);w.setsampwidth(2);w.setframerate(16000);w.writeframes(data)', `${wav}.part.wav`, String(p.span)]);
        renameSync(`${wav}.part.wav`, wav);
      }
      clips.push({ id, at: p.at, seconds: p.span, audio: wav });
    } catch (e) { failed.push({ at: p.at, span: p.span, why: e.message }); }
    finally { if (existsSync(temp)) unlinkSync(temp); if (existsSync(`${wav}.part.wav`)) unlinkSync(`${wav}.part.wav`); }
    save();
    console.error(`audio ${index + 1}/${pieces.length}`);
  }
  if (failed.length) throw new Error(`음성 확보 실패 ${failed.length}개. ${manifestPath}에 기록했습니다. 같은 명령으로 재개할 수 있습니다.`);
  await command('bash', ['scripts/asr/transcribe.sh', engine, manifestPath], join(batch, 'transcribe.log'));
  return output;
}

/** Import raw ASR only, never the assistant's prior interpretation/answer set. */
export function importTranscripts(paths, scan) {
  const evidence = [], sources = [], seen = new Set();
  for (const input of paths) {
    const path = resolve(input), document = readJSON(path), manifestPath = join(dirname(path), 'samples.json');
    if (!existsSync(manifestPath)) throw new Error(`전사의 VOD·시간축을 확인할 samples.json이 없습니다: ${path}`);
    const manifest = readJSON(manifestPath);
    if (String(manifest.vodId) !== String(scan.vod_id)) throw new Error(`다른 VOD의 전사: ${path}`);
    if (!/HLS|ck:probe/i.test(manifest.timestampBasis ?? '')) throw new Error(`HLS 전역 시간축으로 변환되지 않은 전사: ${path}`);
    if (!Number.isFinite(manifest.vodSeconds) || Math.abs(manifest.vodSeconds - scan.total_sec) > 2) throw new Error(`전사와 프레임의 VOD 길이가 다릅니다: ${path}`);
    const digest = hash(readFileSync(path));
    if (seen.has(digest)) continue;
    seen.add(digest);
    sources.push({ path, sha256: digest, engine: document.signature?.engine, complete: Boolean(document.complete) });
    if (!['sensevoice', 'qwen'].includes(document.signature?.engine)) throw new Error(`알 수 없는 전사 엔진: ${path}`);
    const chunks = Array.isArray(document.chunks) ? document.chunks : Object.values(document.chunks ?? {});
    const keys = new Set();
    for (const chunk of chunks) {
      if (typeof chunk.key !== 'string' || !chunk.key || keys.has(chunk.key)) throw new Error(`누락/중복 ASR 키: ${path}`);
      keys.add(chunk.key);
      if (![chunk.at, chunk.end].every(Number.isFinite) || chunk.at < 0 || chunk.end <= chunk.at || chunk.end > scan.total_sec + 0.05 || typeof chunk.text !== 'string') throw new Error(`잘못된 ASR 구간: ${path}`);
      evidence.push({ id: `a-${hash(`${digest}:${chunk.key}`).slice(0, 16)}`, kind: 'asr', at: chunk.at, end: chunk.end,
        text: chunk.text, engine: document.signature.engine, source: path, key: chunk.key, sha256: digest });
    }
  }
  evidence.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  return { evidence, sources, ranges: mergedRanges(evidence.map(e => [e.at, e.end])) };
}

export function planWindows(evidence, seconds = 300, overlap = 30) {
  if (!Number.isFinite(seconds) || seconds < 60 || seconds > 600) throw new Error('분석 창은 60~600초');
  const windows = [];
  for (const [start, stop] of mergedRanges(evidence.map(e => [e.at, e.end]))) {
    for (let from = start; from < stop; from += seconds) {
      const to = Math.min(stop, from + seconds);
      windows.push({ from, to, evidence: evidence.filter(e => e.end > Math.max(start, from - overlap) && e.at < Math.min(stop, to + overlap)) });
    }
  }
  return windows;
}
