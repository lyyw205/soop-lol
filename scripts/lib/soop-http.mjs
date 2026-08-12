/**
 * SOOP 으로 나가는 **유일한 관문**. 레이트리밋이 여기 한 곳에 있다.
 *
 * ★ 왜 만들었나
 *   지연이 8개 파일에 제각각 흩어져 있었고(80ms·120ms·150ms·250ms·400ms·5000ms),
 *   정작 제일 뜨거운 루프 셋은 **지연이 0** 이었다:
 *     · 시트 훑기 — 한 VOD 에 60장을 쉼 없이
 *     · 채팅 훑기 — 한 VOD 에 60창을 쉼 없이
 *     · 채널 VOD 목록 — 최대 30페이지를 쉼 없이
 *   Riot 을 RiotClient 하나로 모은 이유(§11-4)와 똑같다 — "왜 막혔지"를
 *   한 군데만 보고 답할 수 있어야 한다.
 *
 * ★ 호스트마다 성격이 다르다. 하나의 숫자로 못 묶는다
 *   `api-channel` 의 `/board` 는 실측에서 **30회쯤에 515 로 막히고 10분 넘게** 안 풀렸다.
 *   반면 `videoimg`(시트·채팅)는 한 VOD 에 수백 번을 받아도 멀쩡했다.
 *   그래서 호스트별 최소 간격을 따로 준다.
 *
 * ★ 느린 게 기본이다
 *   이 수집은 급할 이유가 하나도 없다 — 밤에 무인으로 돌고, 놓치면 다음 날 또 돈다.
 *   반대로 한 번 차단당하면 **그날 치를 통째로 잃는다.** 그래서 기본값을
 *   "여유 있게" 쪽으로 잡았다. 더 느리게 하려면 `SOOP_PACE` 를 올린다.
 *
 *     SOOP_PACE=2 npm run ck:collect    # 전 호스트 간격 2배
 *
 * ★ 동시성도 여기서 막는다
 *   호출부가 Promise.all 로 6개씩 병렬로 돌리면 간격을 아무리 줘도 소용없다.
 *   호스트별로 **직렬화**한다 — 같은 호스트로는 한 번에 하나만 나간다.
 */

/** 전역 배속. 1 이 기본, 2 면 두 배 느리게. 급하면 0.5 로 줄일 수 있지만 권하지 않는다. */
const raw = Number(process.env.SOOP_PACE);
// 0·음수·NaN 은 "간격 없음"이 돼 버려서 정확히 우리가 피하려던 상태가 된다.
const PACE = Number.isFinite(raw) && raw > 0 ? raw : 1;

/**
 * 응답 대기 상한. 세그먼트가 6MB 라 넉넉히 준다.
 * ★ PACE 와 같은 방어를 건다. `SOOP_TIMEOUT_MS=0` 은 사람이 "타임아웃 끄기"로 읽기 쉬운데
 *   실제로는 정반대다 — AbortSignal.timeout(0) 은 다음 틱에 끊어서 **모든 요청이 즉시 실패**한다.
 *   빈 문자열(→0)·음수(→RangeError)·NaN 도 같은 함정이다.
 */
const rawTimeout = Number(process.env.SOOP_TIMEOUT_MS);
const TIMEOUT_MS = Number.isFinite(rawTimeout) && rawTimeout >= 1000 ? rawTimeout : 60_000;

/**
 * 호스트별 최소 간격(ms). **실측 기반이다.**
 *
 *   api-channel — 게시판. 30회에 막혔다. 채널당 1회씩만 치는데도 넉넉히 벌린다
 *   gpapi       — FA 명단. 하루 몇 번 안 부른다
 *   sch         — 전역 검색. --discover 때만, 페이지를 여러 장 넘긴다
 *   chapi       — 채널 VOD 목록·댓글·방송국. 제일 많이 부르는 곳
 *   api.m       — VOD 상세(POST)
 *   videoimg    — 시트·채팅. 한 VOD 에 100회 이상. 가장 관대했지만 그래도 쉰다
 *   vod-archive — HLS 세그먼트. 6MB 짜리라 회수는 적어도 무겁다
 */
const MIN_INTERVAL = {
  "api-channel.sooplive.com": 6000,
  "gpapi.sooplive.com": 1000,
  "sch.sooplive.co.kr": 800,
  "chapi.sooplive.co.kr": 400,
  "chapi.sooplive.com": 400,
  "api.m.sooplive.co.kr": 400,
  "videoimg.sooplive.co.kr": 250,
  "videoimg.sooplive.com": 250,
};

/**
 * 호스트 이름이 고정이 아닌 것. HLS 세그먼트 CDN 은 응답이 알려주는 대로 가므로
 * (`vod-archive-kr-cdn-z01`, `-z02`, …) 정확한 이름을 미리 못 적는다.
 * 6MB 짜리를 받으니 회수는 적어도 무겁다 — 넉넉히 준다.
 */
const PATTERNS = [
  [/^vod-archive-.*\.sooplive\./, 700],
];

const DEFAULT_INTERVAL = 500;

/** 처음 보는 호스트는 한 번 알린다 — 조용히 기본값으로 새어 나가면 나중에 못 찾는다. */
const warned = new Set();

function intervalFor(host) {
  const exact = MIN_INTERVAL[host];
  if (exact != null) return exact;
  for (const [re, ms] of PATTERNS) if (re.test(host)) return ms;
  if (!warned.has(host)) {
    warned.add(host);
    console.warn(`[soop-http] 간격표에 없는 호스트: ${host} → 기본 ${DEFAULT_INTERVAL}ms. `
      + `자주 부르는 곳이면 MIN_INTERVAL 에 추가해라.`);
  }
  return DEFAULT_INTERVAL;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 호스트별 대기열. 같은 호스트로는 한 번에 하나만 나간다(간격 + 직렬화). */
const gates = new Map();

function gateFor(host) {
  if (!gates.has(host)) gates.set(host, { chain: Promise.resolve(), last: 0, count: 0 });
  return gates.get(host);
}

/**
 * SOOP 으로 나가는 모든 요청은 이걸 통과한다.
 * 시그니처는 fetch 와 같다 — 호출부는 `await fetch(...)` 를 `await soopFetch(...)` 로만 바꾸면 된다.
 */
export function soopFetch(url, init) {
  const host = new URL(url).host;
  const wait = intervalFor(host) * PACE;
  const gate = gateFor(host);

  // 앞 요청 뒤에 줄을 세운다. 체인이 곧 직렬화이자 간격 보장이다.
  const run = gate.chain.then(async () => {
    const since = Date.now() - gate.last;
    if (since < wait) await sleep(wait - since);
    gate.last = Date.now();
    gate.count++;
    // ★ 타임아웃은 선택이 아니다. 이 게이트는 호스트별로 **직렬**이라, 응답 없는
    //   요청 하나가 그 호스트 큐를 영구히 막는다 — 무인으로 도는 밤 작업이
    //   조용히 멈춘 채 아침을 맞는다. 끊고 다음으로 넘어가는 편이 언제나 낫다.
    const res = await fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(TIMEOUT_MS) });
    // ★ 본문을 여기서 끝까지 읽는다.
    //   fetch 는 **응답 헤더**가 오면 resolve 한다 — 6MB 세그먼트나 10MB 채팅은
    //   그 뒤로도 한참 내려온다. 헤더에서 체인을 풀면 다음 요청이 전송 중에 겹쳐
    //   나가고, 파일 머리말이 약속한 "호스트당 한 번에 하나"가 거짓이 된다.
    //   지금은 호출부가 우연히 순차적이라 안 깨질 뿐이라, 게이트가 직접 보장한다.
    //   (버퍼를 들고 새 Response 를 만들어 돌려주므로 호출부 사용법은 그대로다)
    const body = await res.arrayBuffer();
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  });
  // 실패해도 체인이 끊기면 안 된다 — 다음 요청이 영원히 안 나간다.
  gate.chain = run.then(() => undefined, () => undefined);
  return run;
}

/** 지금까지 호스트별로 몇 번 나갔는지. 스크립트가 끝에 찍어 준다. */
export function soopPace() {
  return { pace: PACE, hosts: Object.fromEntries([...gates].map(([h, g]) => [h, g.count])) };
}
