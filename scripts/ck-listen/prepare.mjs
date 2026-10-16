import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, writeFileSync, rmSync, statSync, statfsSync } from "node:fs";
import { join } from "node:path";
import { vodDetail, hlsSegments, segmentsSpan } from "../lib/soop-vod.mjs";
import { splitAudioRanges } from "../lib/ck-audio.ts";
import { config, context, coverage, GAP_TOLERANCE, hash, missingRanges, save, status, subtract } from "./core.mjs";

const run = promisify(execFile);
function worker(ctx, log, children) {
  const fd = openSync(log, "a");
  const proc = spawn("bash", [join(ctx.root, "scripts/asr/env.sh"), "env", "HF_HUB_OFFLINE=1", "TRANSFORMERS_OFFLINE=1",
    join(ctx.root, ".local/asr/sensevoice/bin/python"), join(ctx.root, "scripts/ck-listen/worker.py"), ctx.model.path], { stdio: ["pipe", "pipe", fd] });
  closeSync(fd); children.add(proc);
  let pending, dead;
  const fail = (error) => { dead = error; pending?.reject(error); pending = null; };
  proc.on("error", fail);
  proc.stdin.on("error", fail);
  proc.on("exit", (code, signal) => { children.delete(proc); fail(new Error(`ASR 종료 (${signal ?? code}). 로그: ${log}`)); });
  const lines = createInterface({ input: proc.stdout });
  lines.on("line", (line) => {
    let result;
    try { result = JSON.parse(line); } catch { fail(new Error(`ASR 응답 형식 오류. 로그: ${log}`)); return; }
    const request = pending; pending = null;
    if (!request) { fail(new Error("예상하지 않은 ASR 응답")); return; }
    result.error ? request.reject(new Error(`ASR 실패. 로그: ${log}`)) : request.resolve(result);
  });
  const receive = () => new Promise((resolve, reject) => {
    if (dead) return reject(dead);
    const timer = setTimeout(() => { proc.kill("SIGKILL"); fail(new Error(`ASR 응답 시간 초과. 로그: ${log}`)); }, 300_000);
    pending = { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } };
  });
  const ready = receive();
  return { ready, dead: () => Boolean(dead), async transcribe(request) { const response = receive(); proc.stdin.write(`${JSON.stringify(request)}\n`); return response; }, stop() { proc.stdin.end(); proc.kill("SIGTERM"); } };
}

// A piece whose decoded audio is shorter than requested by less than this is padded with silence
// (the VOD tail's audio ends a fraction of a second before the HLS timeline). Larger gaps stay failures.
export const SHORT_AUDIO_TOLERANCE = 1;
// Consecutive piece failures before giving up (network down, systemic HLS problem).
const MAX_CONSECUTIVE_FAILURES = 3;
// A block-like response from the video CDN (403/429/503) stops the prepare at once and leaves a marker.
// For an hour no prepare downloads; after that the interval is forced back to the default 700 ms until a
// person deletes the marker — the faster prepare interval must not keep hammering after a block.
export const BLOCK_STATUS = /HLS (?:세그먼트|재생목록) HTTP (403|429|503)\b/;
export const BLOCK_COOLDOWN_SECONDS = 3600;
// 음성 준비의 영상 조각 간격 기본값. 준비 시간의 대부분이 이 간격이다(2시간 VOD 인식 32초 · 받기 약 15분).
// 시험 단계(500 → 300)와 FC 백필 수십 VOD 를 300 으로 받는 동안 차단·누락 0 이라 롤 자동 조사도 같은 값을 쓴다(2026-10-14).
// 바꿀 때는 CK_LISTEN_HLS_INTERVAL_MS, 차단 의심이면 위 표시가 700 으로 되돌린다.
export const LISTEN_HLS_INTERVAL_MS = 300;
const blockMarker = (root) => join(root, ".local/ck-listen/hls-block.json");
const lockWaitDefault = () => {
  const v = Number(process.env.CK_LISTEN_LOCK_WAIT_SECONDS ?? 3600);
  return Number.isFinite(v) && v >= 0 ? v : 3600;
};

/** Seconds of PCM16 mono 16 kHz audio in a WAV — reads the data chunk (ffmpeg may add a LIST chunk). */
export function wavSeconds(path) {
  const b = readFileSync(path);
  for (let at = 12; at + 8 <= b.length; at += 8 + b.readUInt32LE(at + 4) + (b.readUInt32LE(at + 4) % 2)) {
    if (b.toString("ascii", at, at + 4) === "data") return Math.min(b.readUInt32LE(at + 4), b.length - at - 8) / 32000;
  }
  throw new Error("WAV data 청크 없음");
}

// flock is held by this process (fd stays open) and released even on SIGKILL.
// All new ASR prepares share one lock, so multiple VOD workers never load ASR together.
// A busy lock is waited for (default 60 min, CK_LISTEN_LOCK_WAIT_SECONDS) instead of failing at once —
// failing fast left most parallel auto sessions without audio (2026-10-13: 8 of 10).
export async function prepare(root, vod, requested, { ifEnabled = false, source = { vodDetail, hlsSegments, segmentsSpan }, lockWaitSeconds = lockWaitDefault() } = {}) {
  if (ifEnabled && !config(root, vod).active) return { vod, active: false, skipped: "disabled" };
  const ctx = context(root, vod);
  requested ??= [[0, ctx.probe.total_sec]];
  const missing = missingRanges(requested, coverage(ctx));
  if (!missing.length) return { ...status(ctx), reused: true, requested_missing: [] };
  const control = join(root, ".local/ck-listen"); mkdirSync(control, { recursive: true });
  // 음성 준비만의 영상 서버 간격 — 이 프로세스 안에서만 바꾼다(사진 뽑기 등 다른 받기는 기본 700 그대로). 차단 표시가 있으면 아래에서 700 으로 되돌린다.
  process.env.SOOP_HLS_INTERVAL_MS = process.env.CK_LISTEN_HLS_INTERVAL_MS || String(LISTEN_HLS_INTERVAL_MS);
  const block = existsSync(blockMarker(root)) ? JSON.parse(readFileSync(blockMarker(root), "utf8")) : null;
  if (block) {
    const left = BLOCK_COOLDOWN_SECONDS - (Date.now() - Date.parse(block.at)) / 1000;
    if (left > 0) throw new Error(`SOOP 영상 서버 차단 의심(HTTP ${block.status}) 뒤 대기 중 — ${Math.ceil(left / 60)}분 남음. 표시: ${blockMarker(root)}`);
    process.env.SOOP_HLS_INTERVAL_MS = "700"; // 대기 뒤에도 사람이 표시를 지울 때까지는 기본 간격으로만 받는다
  }
  return prepareLocked(ctx, requested, { ifEnabled, source, lockWaitSeconds });
}

async function prepareLocked(ctx, requested, { ifEnabled, source, lockWaitSeconds }) {
  const lockFd = openSync(join(ctx.root, ".local/ck-listen/prepare.lock"), "a");
  // Wait our turn. Signals and config-off still cancel the wait.
  let waiter, cancelled = false;
  const cancelWait = () => { cancelled = true; waiter?.kill("SIGTERM"); };
  const offWatch = setInterval(() => { if (ifEnabled && !config(ctx.root, ctx.vod).active) cancelWait(); }, 1000);
  process.once("SIGINT", cancelWait); process.once("SIGTERM", cancelWait);
  const notice = setTimeout(() => process.stderr.write(`LISTEN 다른 음성 준비가 끝나기를 기다린다 (최대 ${Math.round(lockWaitSeconds / 60)}분)\n`), 1000);
  const waitStart = Date.now();
  const acquired = await new Promise((resolve) => {
    waiter = spawn("flock", ["-w", String(lockWaitSeconds), "3"], { stdio: ["ignore", "ignore", "ignore", lockFd] });
    waiter.once("error", () => resolve(false)); waiter.once("exit", (code) => resolve(code === 0));
  });
  const lockWait = (Date.now() - waitStart) / 1000;
  clearTimeout(notice); clearInterval(offWatch);
  process.removeListener("SIGINT", cancelWait); process.removeListener("SIGTERM", cancelWait);
  if (!acquired) {
    closeSync(lockFd);
    throw new Error(cancelled ? "음성 준비 중단 (차례 대기 중)" : `다른 음성 준비가 실행 중이다 (GPU 잠금 — ${Math.round(lockWait)}초 기다림)`);
  }
  const work = join(ctx.root, ".local/asr/runs", `listen-${ctx.vod}`);
  mkdirSync(work, { recursive: true }); mkdirSync(ctx.dir, { recursive: true });
  const src = join(work, "piece.src"), wav = join(work, "piece.wav"), padWav = join(work, "piece.pad.wav");
  const children = new Set();
  const controller = new AbortController();
  const cancellable = async (operation) => {
    let abort;
    const cancelled = new Promise((_, reject) => {
      abort = () => reject(new Error("음성 준비 중단"));
      controller.signal.addEventListener("abort", abort, { once: true });
      if (controller.signal.aborted) abort();
    });
    try { return await Promise.race([operation, cancelled]); }
    finally { controller.signal.removeEventListener("abort", abort); }
  };
  let asr, stopped = false;
  const cleanup = () => { for (const child of children) child.kill("SIGKILL"); for (const path of [src, wav, padWav]) rmSync(path, { force: true }); };
  const stop = () => { stopped = true; controller.abort(); cleanup(); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  // Config off also interrupts a running opt-in job; explicit off-mode CLI tests use signals.
  const watch = setInterval(() => { if (ifEnabled && !config(ctx.root, ctx.vod).active) stop(); }, 1000);
  const session = { started_at: new Date().toISOString(), requested, lock_wait_seconds: Math.round(lockWait), hls_interval_ms: Number(process.env.SOOP_HLS_INTERVAL_MS || 700), downloaded_bytes: 0, peak_temporary_bytes: 0, new_chunks: 0, failed_pieces: 0, padded_seconds: 0 };
  const start = Date.now();
  try {
    // Reload after locking; another process may have finished while we were entering.
    ctx = context(ctx.root, ctx.vod);
    const missing = missingRanges(requested, coverage(ctx));
    const { pieces, outOfRange } = splitAudioRanges(missing.map(([a, b]) => [a, b - a]), ctx.parts);
    const queue = pieces.flatMap((p) => {
      const out = [];
      for (let at = p.at; at < p.at + p.span; at += 300) out.push({ ...p, at, span: Math.min(300, p.at + p.span - at) });
      return out;
    });
    ctx.data.failures = outOfRange.map((range) => ({ range, reason: "HLS 시간축 범위 밖" }));
    const detail = queue.length ? await cancellable(source.vodDetail(ctx.vod)) : null;
    const playlists = new Map();
    let consecutiveFailures = 0;
    const badParts = new Map(); // A split file that can't be opened fails once; its other pieces are skipped, later files still run.
    for (const [i, p] of queue.entries()) {
      if (stopped) throw new Error("음성 준비 중단: 완료 전사는 보존했다");
      if (badParts.has(p.part.index)) {
        ctx.data.failures.push({ range: [p.at, p.at + p.span], reason: "다운로드·시간축·오디오 추출·ASR 실패", detail: `f${p.part.index} 파일을 열지 못했다: ${badParts.get(p.part.index)}` });
        session.failed_pieces++; save(ctx.file, ctx.data); continue;
      }
      try {
        const disk = statfsSync(work);
        if (disk.bavail * disk.bsize < 256 * 1024 * 1024) throw new Error("임시 음성 처리 여유 공간 부족 (256 MiB 미만)");
        if (!playlists.has(p.part.index)) {
          const file = detail?.files?.[p.part.index - 1];
          const opened = !file ? new Error("HLS 파일 없음") : await cancellable(source.hlsSegments(file, { prefer: "audio" })).catch((error) => error);
          if (opened instanceof Error) { if (!stopped) badParts.set(p.part.index, String(opened.message).replace(/https?:\/\/\S+/g, "[URL]").slice(0, 120)); throw opened; }
          const length = opened.segs.at(-1)?.start + opened.segs.at(-1)?.dur;
          let audioLength = p.part.length_sec;
          if (!Number.isFinite(length) || Math.abs(length - p.part.length_sec) > 2) {
            // 음성 전용 트랙이 없으면 최저 화질 재생목록에서 소리를 받는데, 그 목록은 끝 조각만 짧을 수 있다
            // (208915313: 1,379조각 중 마지막만 6→4초, 나머지 시각은 1080p 와 같다). 길이 합만 보고 파일 전체를 버리면
            // VOD 음성이 통째로 빠진다 — 시간축(1080p)과 조각 시각이 맞으면 짧은 끝만 확보 실패로 남긴다.
            const ref = !Number.isFinite(length) || length > p.part.length_sec ? null
              : await cancellable(source.hlsSegments(file, { prefer: "video" })).catch(() => null);
            const refLength = ref ? ref.segs.at(-1)?.start + ref.segs.at(-1)?.dur : NaN;
            const aligned = ref && Math.abs(refLength - p.part.length_sec) <= 2
              && opened.segs.every((s, k) => ref.segs[k] && Math.abs(s.start - ref.segs[k].start) < GAP_TOLERANCE);
            if (!aligned) {
              badParts.set(p.part.index, "현재 HLS 길이가 probe 시간축과 다르다");
              throw new Error("현재 HLS 길이가 probe 시간축과 다르다");
            }
            audioLength = length;
          }
          playlists.set(p.part.index, { ...opened, audioEnd: p.part.offset_sec + audioLength });
        }
        const audioEnd = playlists.get(p.part.index).audioEnd;
        if (p.at + p.span - audioEnd >= GAP_TOLERANCE) {
          ctx.data.failures.push({ range: [Math.max(p.at, audioEnd), p.at + p.span], reason: "음성 재생목록이 영상보다 짧다",
            detail: `f${p.part.index} 음성 재생목록 끝 ${audioEnd.toFixed(2)}초 — 그 뒤는 소리 조각이 없다` });
          save(ctx.file, ctx.data);
          if (audioEnd - p.at < GAP_TOLERANCE) continue;
          p.span = audioEnd - p.at;
        }
        const fetchStart = Date.now();
        const got = await cancellable(source.segmentsSpan(playlists.get(p.part.index), p.at - p.part.offset_sec, p.span));
        const downloadSeconds = (Date.now() - fetchStart) / 1000;
        if (stopped) throw new Error("중단됨");
        if (!got) throw new Error("HLS 세그먼트 없음");
        session.downloaded_bytes += got.bytes;
        writeFileSync(src, got.data);
        const extraction = run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", src, "-ss", String(got.offset), "-t", String(p.span),
          "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav], { timeout: 180_000, signal: controller.signal });
        children.add(extraction.child);
        try { await extraction; } finally { children.delete(extraction.child); }
        // The VOD tail's audio can end a fraction of a second before the HLS timeline. Pad that silence
        // (recorded per piece) instead of failing the piece; a larger gap is real missing audio.
        const short = p.span - wavSeconds(wav);
        if (short > SHORT_AUDIO_TOLERANCE) throw new Error(`음성이 요청보다 ${short.toFixed(2)}초 짧다`);
        let padded = 0;
        if (short > 1 / 16000) { // 한 샘플이라도 모자라면 채운다 — 조각 끝 반올림 틈이 "누락"으로 남지 않게
          const padding = run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", wav, "-af", "apad", "-t", String(p.span),
            "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", padWav], { timeout: 60_000, signal: controller.signal });
          children.add(padding.child);
          try { await padding; } finally { children.delete(padding.child); }
          renameSync(padWav, wav); padded = short;
        }
        session.peak_temporary_bytes = Math.max(session.peak_temporary_bytes, statSync(src).size + statSync(wav).size);
        const audio_sha256 = hash(readFileSync(wav));
        rmSync(src, { force: true });
        if (!asr) { asr = worker(ctx, join(ctx.dir, "worker.log"), children); await asr.ready; }
        const result = await asr.transcribe({ wav, at: p.at, seconds: p.span });
        if (!Array.isArray(result.chunks) || !result.chunks.length) throw new Error("ASR 청크 없음");
        for (const c of result.chunks) {
          if (typeof c.text !== "string" || !Number.isFinite(c.at) || !Number.isFinite(c.end) || c.at < p.at || c.end > p.at + p.span + 0.01 || c.end <= c.at) throw new Error("ASR 청크 범위 오류");
        }
        if (subtract([[p.at, p.at + p.span]], result.chunks.map((c) => [c.at, c.end])).some(([a, b]) => b - a >= GAP_TOLERANCE)) throw new Error("불완전한 ASR 응답");
        const chunks = result.chunks.map((c) => ({ ...c, audio_sha256, id: hash({ at: c.at, end: c.end, text: c.text, audio: audio_sha256 }) }));
        ctx.data.chunks.push(...chunks);
        ctx.data.pieces.push({ range: [p.at, p.at + p.span], audio_sha256, source_sha256: hash(got.data), audio_only: playlists.get(p.part.index).audioOnly,
          segments: got.segments, download_seconds: Number(downloadSeconds.toFixed(2)), ...(padded ? { padded_seconds: Number(padded.toFixed(3)) } : {}) });
        session.new_chunks += chunks.length; session.padded_seconds += padded; consecutiveFailures = 0;
        // Checkpoint before deleting audio. Completed JSON never needs a retained WAV.
        save(ctx.file, ctx.data);
      } catch (error) {
        // Keep signed source URLs/response bodies out of the prompt and cache.
        ctx.data.failures.push({ range: [p.at, p.at + p.span], reason: stopped ? "중단됨" : "다운로드·시간축·오디오 추출·ASR 실패", detail: String(error.message).replace(/https?:\/\/\S+/g, "[URL]").slice(0, 250) });
        save(ctx.file, ctx.data);
        session.failed_pieces++;
        const blocked = BLOCK_STATUS.exec(String(error.message));
        if (blocked) {
          save(blockMarker(ctx.root), { at: new Date().toISOString(), status: Number(blocked[1]), vod: ctx.vod, range: [p.at, p.at + p.span],
            hls_interval_ms: session.hls_interval_ms, note: "차단 의심 — 1시간 동안 음성 준비 다운로드를 멈추고, 그 뒤엔 700ms 로만 받는다. 원인을 확인한 사람이 이 파일을 지운다." });
          throw error; // 남은 조각을 이어 받지 않는다
        }
        // One bad piece (download, short audio, odd response) is recorded and skipped — the rest of the VOD,
        // including later files of a split VOD, still gets transcribed. Stop on a dead model process or a run of failures.
        if (stopped || asr?.dead() || (!badParts.has(p.part.index) && ++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES)) throw error;
      } finally {
        session.peak_temporary_bytes = Math.max(session.peak_temporary_bytes, [src, wav, padWav].reduce((n, path) => n + (existsSync(path) ? statSync(path).size : 0), 0));
        rmSync(src, { force: true }); rmSync(wav, { force: true }); rmSync(padWav, { force: true });
      }
      if ((i + 1) % 6 === 0 || i === queue.length - 1) process.stderr.write(`LISTEN 준비 ${i + 1}/${queue.length}, 새 전사 ${session.new_chunks}청크\n`);
    }
    return { ...status(ctx), requested_missing: missingRanges(requested, coverage(ctx)), session };
  } catch (error) {
    session.error = String(error.message).replace(/https?:\/\/\S+/g, "[URL]").slice(0, 250);
    if (!ctx.data.failures.length) ctx.data.failures = missingRanges(requested, coverage(ctx)).map((range) => ({ range, reason: session.error }));
    throw error;
  } finally {
    try {
      session.wall_seconds = (Date.now() - start) / 1000;
      ctx.data.sessions.push(session); save(ctx.file, ctx.data);
    } finally {
      clearInterval(watch); asr?.stop(); cleanup(); closeSync(lockFd);
      process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
    }
  }
}
