import { appendFileSync, readFileSync } from 'node:fs';
import { sessionSummary, sessionUsage } from './lib/ck-session-usage.ts';

const [file, afterFile, output, model] = process.argv.slice(2);
console.log(`세션 결과 원본: ${file}`);
try {
  const result = JSON.parse(readFileSync(file, 'utf8'));
  console.log(sessionSummary(result));
  const usage = sessionUsage(result);
  const after = JSON.parse(readFileSync(afterFile, 'utf8'));
  const saved = Math.max(0, (after.after.saved_matches ?? 0) - (after.before.saved_matches ?? 0));
  const row = { at: new Date().toISOString(), vod: after.vod, requested_model: model, ...usage, saved_povs: saved,
    progress_kind: after.progress_kind, no_outcome_sessions: after.guard?.no_outcome_sessions, blocked: after.blocked };
  appendFileSync(output, JSON.stringify(row) + '\n');
  console.log(`사용량: 입력 ${usage.input_tokens} · 캐시 쓰기 ${usage.cache_creation_input_tokens} · 캐시 읽기 ${usage.cache_read_input_tokens} · 출력 ${usage.output_tokens} · 새 저장 시점 ${saved}`);
} catch (error) {
  console.error(`사용량 집계 불가(0으로 간주하지 않음): ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
