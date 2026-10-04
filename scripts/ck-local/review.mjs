/** 쓰기 전에 모든 라벨을 검증한다. --seen은 원본을 실제로 열었다는 명시적 기록이다. */
export function reviewLabels(state, { verdicts = '', labels = '', cand = null, is = null, seen = '' }, frameExists) {
  const kinds = new Set(['result', 'graph', 'banpick', 'lobby', 'client', 'ingame', 'end', 'other', 'fc_match', 'fc_result', 'fc_menu']);
  const time = s => {
    if (!/^\d+(?::[0-5]\d){0,2}$/.test(s)) throw new Error(`잘못된 시각: ${s}`);
    const n = s.split(':').map(Number).reduce((a, b) => a * 60 + b, 0);
    if (!Number.isSafeInteger(n) || n > state.total_sec) throw new Error(`영상 밖 시각: ${s}`);
    return n;
  };
  const opened = new Set(seen.split(',').map(x => x.trim()).filter(Boolean).map(time));
  const rows = new Map();
  const add = (at, label) => {
    if (!kinds.has(label)) throw new Error(`알 수 없는 라벨: ${label}`);
    if (!opened.has(at) || !frameExists(at)) throw new Error(`${at}: 실제로 연 원본을 --seen에 적어야 한다 (파일도 있어야 함)`);
    if (rows.has(at) && rows.get(at).label !== label) throw new Error(`${at}: 한 제출에 서로 다른 라벨`);
    rows.set(at, { vod: state.vod_id, at, label, source: `ck-local:${state.run_id}`,
      evidence_frame: `out/ck/${state.vod_id}/g${String(at).padStart(7, '0')}.jpg` });
  };
  const marks = verdicts.split(',').map(x => x.trim()).filter(Boolean);
  if (cand != null) marks.push(`${cand}:${is}`);
  for (const token of marks) {
    const m = /^(\d+):(\w+)$/.exec(token);
    const c = m && state.candidates?.find(c => c.n === Number(m[1]));
    if (!c) throw new Error(`이 실행에 없는 후보: ${token}`);
    add(c.peak, m[2]);
  }
  for (const token of labels.split(',').map(x => x.trim()).filter(Boolean)) {
    const m = /^([^=]+)=(\w+)$/.exec(token);
    if (!m) throw new Error(`잘못된 라벨: ${token}`);
    add(time(m[1]), m[2]);
  }
  return [...rows.values()];
}
