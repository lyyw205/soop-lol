#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ROOT, OUTPUT, hash, lock, ownedDirectory, readJSON, stamp, writeJSON } from './common.mjs';
import { addFrames, prepareFresh, snapshotScan } from './frames.mjs';
import { importTranscripts, transcribeAudio } from './audio.mjs';
import { LocalModel } from './model.mjs';
import { selectAudio, labelFrames, selectRechecks } from './select.mjs';
import { buildPacket, renderPacket } from './packet.mjs';

const HELP = `독립 실험 스킬 ck-context — 운영 ck-local·DB·학습 라벨을 변경하지 않습니다.

node scripts/ck-context/cli.mjs prepare --vod N [--scan 기존/scan.json] [--out out/ck-context/N/실험]
node scripts/ck-context/cli.mjs run --vod N [--transcript 기존/sensevoice.transcript.json ...]
node scripts/ck-context/cli.mjs evidence --out out/ck-context/N/실험 --id 근거ID

prepare: 기존 scan이 있으면 후보·이미지를 복사. 없으면 같은 판별기로 별도 준비.
run: 준비 → 전체/지정 음성 전사 → 관련 원문 ID 선별 → handoff.json.
     --transcript를 주면 기존 전사를 재사용하고 그 표본 범위만 분석합니다.
     같은 --out으로 재개하면 입력·모델·프롬프트가 같은 분석 결과를 재사용합니다.

--frame 초=이미지경로         추가 근거 프레임 (반복 가능)
--ranges 시작초:길이,...     새 전사 범위. 기본은 VOD 전체
--endpoint URL               기본 http://127.0.0.1:11439 (로컬 Ollama만)
--model 이름                 기본 qwen3.5:4b
--thinking true|false        로컬 추론 모드 비교. 기본 false
--window-seconds N           기본 300, 앞뒤 30초 중첩
--vision-limit N             화면 종류/가시성 추가 분류 수, 기본 0 (원본은 모두 유지)
--recheck-seconds N          요청된 중요 음성의 Qwen 재전사 한도, 기본 0 (한 차례만)

출력: report.html, handoff.json, packet.json, metrics.json 및 재개용 원본.
서버 기동·모델 준비는 .claude/skills/ck-context/references/running.md 참고.
`;

function options(args) {
  const values = { transcript: [], frame: [] };
  const keys = new Set(['vod', 'out', 'scan', 'transcript', 'frame', 'ranges', 'endpoint', 'model', 'thinking', 'window-seconds', 'vision-limit', 'recheck-seconds', 'id']);
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i].replace(/^--/, '');
    if (!args[i].startsWith('--') || !keys.has(name) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`인자 오류: ${args[i]}`);
    if (Array.isArray(values[name])) values[name].push(args[i + 1]); else values[name] = args[i + 1];
  }
  return values;
}

async function main() {
  const [action, ...args] = process.argv.slice(2);
  if (!action || ['--help', '-h', 'help'].includes(action)) { console.log(HELP); return; }
  if (!['prepare', 'run', 'evidence'].includes(action)) throw new Error(HELP);
  const opts = options(args);
  if (action === 'evidence') {
    if (!opts.out || !opts.id) throw new Error('evidence에는 --out, --id가 필요합니다.');
    const p = readJSON(join(ownedDirectory(opts.out), 'packet.json'));
    const e = p.evidence[opts.id] ?? [...(p.clips ?? []), ...(p.events ?? []), ...(p.secondary_events ?? [])].find(e => e.id === opts.id) ?? p.reviews.find(e => e.id === opts.id);
    if (!e) throw new Error('없는 근거 ID');
    console.log(JSON.stringify(e, null, 2)); return;
  }
  if (!/^\d+$/.test(opts.vod ?? '')) throw new Error('--vod 숫자가 필요합니다.');
  const directory = ownedDirectory(opts.out ?? join(OUTPUT, opts.vod, `${stamp()}-${process.pid}`));
  const release = lock(directory), started = Date.now();
  let releaseGPU, model;
  const metrics = { started_at: new Date().toISOString(), model: null, phases: {}, model_calls: [], database_written: false };
  try {
    if (existsSync(join(directory, 'packet.json')) && readJSON(join(directory, 'packet.json')).schema !== 'ck-context/v2-selection') throw new Error('이전 해석 실험 결과는 보존합니다. 선별 방식에는 새 --out을 사용하세요.');
    const scanPath = join(directory, 'scan.json');
    let scan;
    if (existsSync(scanPath)) {
      scan = readJSON(scanPath);
      if (String(scan.vod_id) !== opts.vod) throw new Error('다른 VOD의 실행 폴더');
      if (opts.scan && scan.source?.sha256 !== hash(readFileSync(resolve(opts.scan)))) throw new Error('원본 scan이 바뀌었습니다. 새 --out으로 실행하세요.');
    } else {
      const legacy = resolve(opts.scan ?? join(ROOT, 'out/ck', opts.vod, 'local/scan.json'));
      if (opts.scan && !existsSync(legacy)) throw new Error(`scan 파일 없음: ${legacy}`);
      if (existsSync(legacy)) scan = snapshotScan(legacy, directory, opts.vod);
      else { releaseGPU = lock(join(OUTPUT, '_gpu')); scan = await prepareFresh(opts.vod, directory); }
    }
    addFrames(scan, directory, opts.frame);
    metrics.phases.frames_seconds = (Date.now() - started) / 1000;
    if (action === 'prepare') { console.log(JSON.stringify({ output: directory, candidates: scan.candidates.length, mode: scan.source.mode })); return; }
    // Fail before downloading hours of audio when the local model is unavailable.
    if (opts.thinking && !['true', 'false'].includes(opts.thinking)) throw new Error('--thinking은 true|false');
    model = new LocalModel({ endpoint: opts.endpoint, model: opts.model, directory, thinking: opts.thinking === 'true' });
    await model.check(); metrics.model = { name: model.model, digest: model.digest, endpoint: model.endpoint, thinking: model.thinking };
    releaseGPU ??= lock(join(OUTPUT, '_gpu'));
    let at = Date.now();
    if (opts.ranges && opts.transcript.length) throw new Error('--ranges와 --transcript는 함께 사용하지 않습니다. 기존 전사 재사용 또는 새 음성 범위를 선택하세요.');
    const requested = opts.ranges ? opts.ranges.split(',').map(r => r.split(':').map(Number)) : [[0, scan.total_sec]];
    if (requested.some(r => r.length !== 2)) throw new Error('--ranges는 시작초:길이 형식');
    const paths = opts.transcript.length ? opts.transcript.map(p => resolve(p)) : [await transcribeAudio(scan, directory, requested)];
    let transcript = importTranscripts(paths, scan);
    writeJSON(join(directory, 'transcript-input.json'), transcript);
    metrics.phases.audio_seconds = (Date.now() - at) / 1000;
    at = Date.now();
    const windowSeconds = Number(opts['window-seconds'] ?? 300), visionLimit = Number(opts['vision-limit'] ?? 0), recheckBudget = Number(opts['recheck-seconds'] ?? 0);
    if (!Number.isInteger(visionLimit) || visionLimit < 0 || !Number.isFinite(recheckBudget) || recheckBudget < 0) throw new Error('이미지·재전사 한도는 0 이상이어야 합니다.');
    let selection = await selectAudio(model, scan, transcript, directory, { windowSeconds });
    metrics.phases.selection_seconds = (Date.now() - at) / 1000;
    const selected = selectRechecks(selection.recheck_ids, transcript.evidence, recheckBudget);
    metrics.recheck_ranges = selected;
    if (selected.length) {
      at = Date.now(); await model.unload();
      paths.push(await transcribeAudio(scan, directory, selected, 'qwen'));
      transcript = importTranscripts(paths, scan); writeJSON(join(directory, 'transcript-input.json'), transcript);
      selection = await selectAudio(model, scan, transcript, directory, { windowSeconds });
      metrics.phases.recheck_seconds = (Date.now() - at) / 1000;
    }
    at = Date.now();
    const vision = await labelFrames(model, scan, directory, visionLimit);
    metrics.phases.vision_seconds = (Date.now() - at) / 1000;
    metrics.model_calls = model.calls; metrics.elapsed_seconds = (Date.now() - started) / 1000;
    const packet = buildPacket(scan, transcript, selection, vision, metrics);
    metrics.delivery = renderPacket(packet, directory);
    writeJSON(join(directory, 'metrics.json'), metrics);
    console.log(JSON.stringify({ output: directory, report: join(directory, 'report.html'), handoff: join(directory, 'handoff.json'),
      candidates: packet.reviews.length, clips: packet.clips.length, full_vod_selected: packet.coverage.full_vod_selected,
      failed_windows: selection.failures.length, failed_images: vision.failures.length,
      elapsed_seconds: metrics.elapsed_seconds }, null, 2));
    if (selection.failures.length || vision.failures.length) process.exitCode = 2;
  } catch (e) {
    writeJSON(join(directory, 'failure.json'), { error: e.message, at: new Date().toISOString(), metrics }); throw e;
  } finally {
    if (model?.digest) { try { await model.unload(); } catch { /* Main error/checkpoints are preserved. */ } }
    releaseGPU?.(); release();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
