/** claude -p --output-format json의 최종 결과를 기록한다. 계정 청구액이 아니다. */
export function sessionSummary(value: unknown): string {
  const result = value as {result?: unknown; is_error?: boolean} | null;
  const text = typeof result?.result === 'string'
    ? result.result.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim()
    : '';
  return `${result?.is_error === true ? '실패' : '조사'} 요약: ${text ? text.slice(0, 1600) + (text.length > 1600 ? ' …(원본 참조)' : '') : '응답 요약 없음'}`;
}

export function sessionUsage(value: unknown) {
  const result = value as any;
  if (!result || result.type !== 'result' || !result.usage || typeof result.usage !== 'object')
    throw new Error('Claude 최종 usage 결과가 없다');
  const count = (key: string) => {
    const n = result.usage[key] ?? 0;
    if (!Number.isFinite(n) || n < 0) throw new Error(`잘못된 usage.${key}`);
    return n;
  };
  return {
    session_id: result.session_id ?? null, turns: result.num_turns ?? null,
    duration_ms: result.duration_ms ?? null,
    input_tokens: count('input_tokens'), cache_creation_input_tokens: count('cache_creation_input_tokens'),
    cache_read_input_tokens: count('cache_read_input_tokens'), output_tokens: count('output_tokens'),
    models: Object.keys(result.modelUsage ?? {}),
    api_equivalent_usd: result.total_cost_usd ?? null,
    is_error: result.is_error === true,
  };
}
