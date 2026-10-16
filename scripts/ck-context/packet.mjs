import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { hash, hms, mergedRanges, missingRanges, writeJSON } from './common.mjs';
import { evidenceClips } from './select.mjs';

export function buildPacket(scan, transcript, selection, vision, metrics) {
  const evidence = Object.fromEntries(transcript.evidence.map(e => [e.id, e]));
  const clips = evidenceClips(selection, transcript.evidence), frames = new Map();
  function frame(at, path) {
    if (!path || !existsSync(path)) return null;
    const id = `f-${hash(`${at}:${hash(readFileSync(path))}`).slice(0, 16)}`;
    const label = vision.labels.find(v => v.frame === path);
    if (!frames.has(id)) frames.set(id, { id, kind: 'frame', at, path, sha256: hash(readFileSync(path)),
      selection_hint: label ? { scene: label.scene, readability: label.readability } : null });
    return id;
  }
  const reviews = scan.candidates.map(c => {
    const alternatives = [...new Set([frame(c.peak, c.frame), frame(c.from, c.first_frame),
      ...(scan.extra_frames ?? []).filter(f => f.at >= c.from - 15 && f.at <= c.to + 15).map(f => frame(f.at, f.frame))].filter(Boolean))];
    const clear = alternatives.find(id => frames.get(id).selection_hint?.scene === 'result' && frames.get(id).selection_hint?.readability === 'clear');
    return { id: `candidate-${c.n}`, candidate: { n: c.n, from: c.from, to: c.to, peak: c.peak, peak_score: c.peak_score },
      primary_frame: clear ?? alternatives[0] ?? null, frame_ids: alternatives, name_crop: c.names ?? null,
      nearby_clip_ids: clips.filter(e => e.at <= c.to + 60 && e.end >= c.from - 1800).map(e => e.id),
      draft_hint: (scan.map ?? []).filter(s => ['banpick', 'lobby'].includes(s.label) && s.to <= c.from && s.to >= c.from - 3600).at(-1) ?? null,
      disposition: 'unreviewed' };
  });
  for (const f of scan.extra_frames ?? []) frame(f.at, f.frame);
  for (const f of scan.file_tails ?? []) frame(f.at, f.frame);
  for (const [id, value] of frames) evidence[id] = value;
  return { schema: 'ck-context/v2-selection', vod: { id: scan.vod_id, title: scan.title, seconds: scan.total_sec, time_basis: 'HLS global seconds' },
    provenance: { preparation: scan.source, model: metrics.model, generated_at: new Date().toISOString(), database_written: false },
    coverage: { transcript_ranges: transcript.ranges, transcript_missing: missingRanges(scan.total_sec, transcript.ranges),
      selection_ranges: selection.processed_ranges, selection_missing: selection.unprocessed_ranges,
      selection_failures: selection.failures, frame_failures: scan.frame_failures ?? [], thumbnail_failures: scan.failed ?? [],
      vision_failures: vision.failures, vision_unlabelled_count: vision.unlabelled.length,
      full_vod_selected: selection.unprocessed_ranges.length === 0 && selection.failures.length === 0 },
    selection, clips, reviews, evidence, overview_pages: scan.overview_pages ?? [], candidate_pages: scan.candidate_pages ?? [], metrics,
    contract: { model_role: 'select_evidence_only', candidates_removed: 0, opened_by_claude: [],
      nearby_is_not_applicability: true, asr_is_not_verified_speech: true, omitted_is_not_irrelevant: true } };
}

export function validatePacket(packet) {
  if (packet.schema !== 'ck-context/v2-selection') throw new Error('새 선별 형식의 packet이 필요합니다.');
  const clipIds = new Set(packet.clips.map(c => c.id));
  for (const c of packet.clips) {
    if (Object.keys(c).some(k => !['id', 'at', 'end', 'selected_ids', 'source_ids'].includes(k))) throw new Error('선별 자료에 해석 필드가 있습니다.');
    for (const id of c.source_ids) if (packet.evidence[id]?.kind !== 'asr') throw new Error(`원문 근거 누락: ${id}`);
    for (const id of c.selected_ids) if (!c.source_ids.includes(id)) throw new Error('선택한 원문이 전달 자료에서 누락됨');
  }
  for (const r of packet.reviews) {
    for (const id of r.frame_ids) if (packet.evidence[id]?.kind !== 'frame') throw new Error(`프레임 참조 누락: ${id}`);
    for (const id of r.nearby_clip_ids) if (!clipIds.has(id)) throw new Error(`구간 참조 누락: ${id}`);
    if (r.primary_frame && !r.frame_ids.includes(r.primary_frame)) throw new Error('대표 프레임이 대안 목록에 없습니다.');
  }
  for (const e of Object.values(packet.evidence)) if (e.kind === 'frame' && (!existsSync(e.path) || hash(readFileSync(e.path)) !== e.sha256)) throw new Error(`프레임 변경/누락: ${e.id}`);
  return packet;
}

export function renderPacket(packet, directory) {
  validatePacket(packet); writeJSON(join(directory, 'packet.json'), packet);
  const used = new Set(packet.clips.flatMap(c => c.source_ids));
  const sources = Object.fromEntries(Object.entries(packet.evidence).filter(([id, e]) => e.kind === 'frame' || used.has(id)).map(([id, e]) => [id,
    e.kind === 'frame' ? { at: e.at, path: e.path } : { at: e.at, end: e.end, engine: e.engine, text: e.text }]));
  const brief = { schema: packet.schema, vod: packet.vod, coverage: packet.coverage,
    instructions: ['로컬 모델은 원문 ID만 골랐다. 전사는 오인식이 있을 수 있는 ASR 원문이다.',
      '클립에는 선택 구간과 앞뒤 30초 문맥이 있다. 화자·게임 종류·역할·합의·적용 경기는 원문과 화면으로 직접 판단한다.',
      'nearby_clip_ids는 직전 30분 시간 근접 연결이다. 초반 합의는 더 오래 적용될 수 있으므로 전체 클립 목록도 확인한다.',
      '선별되지 않은 대화에도 중요 정보가 있을 수 있다. 선별 실패를 사건 없음으로 해석하지 않는다.'],
    clips: packet.clips, reviews: packet.reviews, overview_pages: packet.overview_pages, candidate_pages: packet.candidate_pages,
    sources, full_packet: join(directory, 'packet.json') };
  writeJSON(join(directory, 'handoff.json'), brief);
  const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const href = p => escape(relative(directory, p));
  const evidenceHTML = e => e.kind === 'frame'
    ? `<a href="${href(e.path)}"><img loading="lazy" src="${href(e.path)}" alt="${escape(e.id)} ${hms(e.at)}"></a>`
    : `<blockquote>${escape(e.text)}</blockquote><small>${hms(e.at)}–${hms(e.end)} · ${escape(e.engine)} 원문</small>`;
  const failures = Object.fromEntries(Object.entries(packet.coverage).filter(([key, value]) => key.endsWith('_failures') && value.length));
  let html = `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CK 자료 선별 · ${packet.vod.id}</title>
  <style>body{font:16px/1.6 system-ui;max-width:1120px;margin:30px auto;padding:0 20px;background:#f5f7fa;color:#1e293b}section,article{padding:20px;margin:18px 0;background:white;border:1px solid #d9e1ec;border-radius:10px}img{max-width:100%}small{color:#526174}a{color:#155bb4}blockquote{white-space:pre-wrap;margin:8px 0;padding:8px 15px;border-left:3px solid #99b5d9}.notice{background:#fff1d5;padding:14px}summary{cursor:pointer}pre{white-space:pre-wrap}</style>
  <h1>VOD ${packet.vod.id} · 확인할 원문과 화면</h1><p>${escape(packet.vod.title)}</p>
  <p class="notice">로컬 모델은 원문 위치만 고릅니다. ASR 원문에는 오인식이 있을 수 있습니다. 후보 ${packet.reviews.length}개를 보존했습니다.</p>
  <p><a href="handoff.json">Claude 입력</a> · <a href="packet.json">전체 근거·선별 기록</a> · <a href="metrics.json">시간·전달량</a></p>
  <section><h2>처리 범위</h2><p>전사 미확보: ${packet.coverage.transcript_missing.map(r => r.map(hms).join('–')).join(', ') || '없음'}</p><p>선별 미처리: ${packet.coverage.selection_missing.map(r => r.map(hms).join('–')).join(', ') || '없음'}</p><p>이미지 추가 선별 미실행/실패: ${packet.coverage.vision_unlabelled_count}개. 원본은 유지됩니다.</p>${Object.keys(failures).length ? `<details><summary>실패 기록</summary><pre>${escape(JSON.stringify(failures, null, 2))}</pre></details>` : ''}</section>
  <section><h2>시간순 원문 클립 ${packet.clips.length}개</h2>${packet.clips.map(c => `<details id="${c.id}"><summary>${hms(c.at)}–${hms(c.end)}</summary>${c.source_ids.map(id => `<p>${c.selected_ids.includes(id) ? '선택한 발언' : '앞뒤 문맥'}</p>${evidenceHTML(packet.evidence[id])}`).join('')}</details>`).join('')}</section>`;
  for (const r of packet.reviews) html += `<article><h2>후보 #${r.candidate.n} · ${hms(r.candidate.from)}–${hms(r.candidate.to)}</h2>
    <p>인접 클립은 시간 근접 연결이며, 해당 경기 적용 여부는 판단하지 않았습니다.</p>
    <ul>${r.nearby_clip_ids.map(id => { const c = packet.clips.find(c => c.id === id); return `<li><a href="#${id}">${hms(c.at)}–${hms(c.end)}</a></li>`; }).join('')}</ul>
    ${r.primary_frame ? `<details><summary>먼저 확인할 원본</summary>${evidenceHTML(packet.evidence[r.primary_frame])}</details>` : '<p>원본 누락</p>'}
    ${r.frame_ids.filter(id => id !== r.primary_frame).map(id => `<details><summary>대체 원본 ${hms(packet.evidence[id].at)}</summary>${evidenceHTML(packet.evidence[id])}</details>`).join('')}</article>`;
  html += '</html>'; writeFileSync(join(directory, 'report.html'), html);
  const raw = Object.values(packet.evidence).filter(e => e.kind === 'asr'), delivered = raw.filter(e => used.has(e.id));
  const seconds = rows => mergedRanges(rows.map(e => [e.at, e.end])).reduce((n, [a, b]) => n + b - a, 0);
  return { handoff_bytes: Buffer.byteLength(JSON.stringify(brief)), raw_transcript_chars: raw.reduce((n, e) => n + e.text.length, 0),
    delivered_transcript_chars: delivered.reduce((n, e) => n + e.text.length, 0), transcript_seconds: seconds(raw), delivered_seconds: seconds(delivered),
    delivered_source_count: delivered.length, total_source_count: raw.length, model_authored_claims: 0 };
}
