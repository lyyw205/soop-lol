import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hash, readJSON, writeJSON } from './common.mjs';

export function localEndpoint(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('로컬 Ollama HTTP 주소만 허용합니다. 예: http://127.0.0.1:11439');
  return url.origin;
}

export class LocalModel {
  constructor({ endpoint = 'http://127.0.0.1:11439', model = 'qwen3.5:4b', directory, timeout = 240000, context = 8192, thinking = false }) {
    this.endpoint = localEndpoint(endpoint); this.model = model; this.directory = directory; this.timeout = timeout; this.context = context;
    this.calls = []; this.digest = null; this.thinking = thinking;
  }
  async request(path, body) {
    const response = await fetch(`${this.endpoint}${path}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(this.timeout), redirect: 'error' });
    if (!response.ok) throw new Error(`Ollama ${response.status}: ${(await response.text()).slice(0, 400)}`);
    const value = await response.json();
    if (value.error) throw new Error(value.error);
    return value;
  }
  async check() {
    const tags = await this.request('/api/tags');
    const entry = tags.models?.find(m => m.name === this.model || m.model === this.model);
    if (!entry) throw new Error(`로컬 모델이 설치되지 않았습니다: ${this.model}. 서버·모델은 스킬의 실행 안내를 확인하세요.`);
    const info = await this.request('/api/show', { model: this.model });
    if (info.remote_host || info.remote_model || entry.remote_host || /:cloud(?:$|-)/.test(this.model)) throw new Error('클라우드 모델은 실험 대상이 아닙니다.');
    this.digest = entry.digest;
    this.capabilities = info.capabilities ?? [];
    writeJSON(join(this.directory, 'model.json'), { endpoint: this.endpoint, model: this.model, digest: this.digest, capabilities: this.capabilities, context: this.context, thinking: this.thinking });
  }
  async chat({ system, input, schema, images = [], maxTokens = 1600 }) {
    if (!this.digest) throw new Error('먼저 모델을 확인하세요.');
    const imageHashes = images.map(p => hash(readFileSync(p)));
    const generation = { temperature: 0, presence_penalty: 0, repeat_penalty: 1, num_ctx: this.context, num_predict: this.thinking ? maxTokens + 3000 : maxTokens, seed: 42, use_mmap: false };
    const key = hash({ model: this.digest, system, input, schema, imageHashes, generation, thinking: this.thinking });
    const path = join(this.directory, 'model-cache', `${key}.json`);
    if (existsSync(path)) {
      const cached = readJSON(path);
      if ((cached.metrics.input_tokens ?? 0) >= this.context - 32 || (cached.metrics.input_tokens ?? 0) + (cached.metrics.output_tokens ?? 0) >= this.context) throw new Error(`캐시 결과가 컨텍스트 한도에 도달했습니다: ${key}`);
      this.calls.push({ ...cached.metrics, cached: true }); return cached.value;
    }
    const started = Date.now();
    const result = await this.request('/api/chat', { model: this.model, stream: false, think: this.thinking, keep_alive: '5m', format: schema,
      options: generation,
      messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(input),
        ...(images.length ? { images: images.map(p => readFileSync(p).toString('base64')) } : {}) }] });
    const metrics = { key, elapsed_ms: Date.now() - started, input_tokens: result.prompt_eval_count, output_tokens: result.eval_count,
      prompt_ms: (result.prompt_eval_duration ?? 0) / 1e6, generation_ms: (result.eval_duration ?? 0) / 1e6, load_ms: (result.load_duration ?? 0) / 1e6, cached: false };
    this.calls.push(metrics);
    writeJSON(join(this.directory, 'model-raw', `${key}.json`), { ...result, metrics });
    if (result.done_reason === 'length' || !result.done) throw new Error(`모델 출력 잘림: ${key}`);
    if ((result.prompt_eval_count ?? 0) >= this.context - 32 || (result.prompt_eval_count ?? 0) + (result.eval_count ?? 0) >= this.context) {
      throw new Error(`모델 컨텍스트 한도에 도달했습니다. 분석 창을 줄이세요: ${key}`);
    }
    let value;
    try { value = JSON.parse(result.message.content); } catch { throw new Error(`모델 JSON 오류: ${key}`); }
    writeJSON(path, { value, metrics });
    return value;
  }
  async unload() { await this.request('/api/generate', { model: this.model, keep_alive: 0 }); }
}
