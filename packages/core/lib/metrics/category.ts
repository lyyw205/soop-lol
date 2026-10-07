/**
 * **경기 분류** — "어떤 맥락에서 붙었나". 화면 필터의 기준이 되는 단 하나의 축이다.
 *
 * ★ 왜 `source` 하나로 안 되나
 *   `match.source` 는 **어떻게 알게 됐나**(공개 큐 조회 / 토너먼트 코드 / 수기)를 말하지,
 *   **무슨 판이었나**를 말하지 않는다. 실제 분포를 보면 바로 드러난다:
 *
 *     manual  q=0  event.kind='tournament'  776건   ← 멸망전 같은 공식 대회
 *     manual  q=0  event.kind='ck'            5건   ← 내전(CK)
 *
 *   둘 다 `source='manual'` 이라 source 로는 절대 못 가른다. 세 값을 같이 봐야 한다.
 *
 * ★ CK 와 스크림은 다른 판이다 (0031)
 *   `ck` 는 승패에 보상이 걸린 스트리머 간 매치 — 이 사이트가 다루는 "내전"이 이것이다.
 *   `scrim` 은 tournament/showmatch 를 준비하며 참가팀끼리 전략을 시험하는 연습게임.
 *   0031 이전에는 'scrim' 하나가 CK 의 뜻으로 쓰였고, 그때의 행은 전부 'ck' 로 이관했다.
 *
 * ★ 토너먼트 코드인데 대회가 안 붙어 있으면 **코드 내전(code_custom)** 이다 — CK 가 아니다 (0077)
 *   코드는 Riot 에 등록한 운영자(내전 사이트·디스코드 봇·대회 도구)가 발급하고 선수가 입력한다.
 *   그 판이 CK 인지, 시청자 내전·자체 내전·아마추어 대회인지는 **API 값으로는 모른다.**
 *   예전엔 이걸 CK 로 쳐서, 공개 큐 이력으로 들어온 829경기가 90명의 CK 전적에 섞였다(2026-10-07).
 *   사람이 검수해 event(ck/scrim/tournament)를 붙여야 그 분류로 올라간다.
 *
 * ★ 이 규칙은 SQL 에도 같은 모양으로 있다 (`lol_match_category`, 마이그레이션 0016).
 *   질의에서 걸러야 빠르고, 화면에서 이름을 붙이려면 TS 가 필요해서 양쪽에 둔다.
 *   **둘이 어긋나면 필터가 조용히 거짓말을 한다** — `verify:db` 가 전 조합을 대조한다.
 *   `lp_absolute` 를 양쪽에 두고 검사로 묶어 둔 것과 같은 방식이다(§11-6).
 */

export const MATCH_CATEGORIES = [
  // ★ "전체" 가 아니라 "모든 경기" 다. 상대전적 카드처럼 **다른 필터와 나란히 서는 자리**에서
  //   홀로 '전체' 만 보면 기간인지 분류인지 알 수 없다.
  { key: "all", label: "모든 경기" },
  { key: "public_queue", label: "공개 큐" },
  { key: "solo", label: "솔로랭크" },
  { key: "flex", label: "자유랭크" },
  { key: "aram", label: "칼바람" },
  { key: "aram_custom", label: "칼바람 나락 내전" },
  { key: "normal", label: "일반" },
  { key: "clash", label: "클래시" },
  { key: "ck", label: "내전 (CK)" },
  // 맞라인을 정하고 매 판 팀을 섞는 랜드. 팀 단위 승패가 없어 판 단위로만 센다(0079).
  { key: "land", label: "랜드" },
  // 토너먼트 코드로 만든 사설 경기인데 무슨 판인지 아직 모른다. CK 와 섞지 않는다(0077).
  { key: "code_custom", label: "코드 내전" },
  { key: "scrim", label: "스크림" },
  { key: "tournament", label: "대회" },
  { key: "other", label: "기타" },
  // 아레나·우르프. 원본은 남기되 어느 공개 화면·집계에도 넣지 않는다(0078).
  { key: "excluded", label: "집계 제외 모드" },
] as const;

/** 칼바람 화면이 다루는 분류. 일반·증강 칼바람을 가르지 않는다(0078). */
export const ARAM_CATEGORIES = ["aram", "aram_custom"] as const;

/** 일반 전적 화면의 선택지. 칼바람은 별도 조회/화면에서 다루고(0071), 집계 제외 모드는 어디에도 없다(0078). */
export const RIFT_MATCH_CATEGORIES = MATCH_CATEGORIES.filter(c =>
  !(ARAM_CATEGORIES as readonly string[]).includes(c.key) && c.key !== "excluded");

/**
 * `all` 과 `public_queue` 는 **필터 전용 묶음**이다 — 어떤 경기도 그 값을 갖지 않는다.
 * 경기 한 건이 실제로 갖는 분류는 아래 `MatchCategory` 뿐이다.
 */
export type MatchCategory = Exclude<(typeof MATCH_CATEGORIES)[number]["key"], "all" | "public_queue">;
export type MatchCategoryFilter = (typeof MATCH_CATEGORIES)[number]["key"];

/**
 * 공개 큐 묶음. "최근 경기" 처럼 **내전·대회를 섞으면 안 되는 자리**(§11-7)의 기본값이다.
 * ★ `source='public_queue'` 로 거르지 않고 분류로 거른다 — 둘이 같은 뜻이 되도록
 *   묶음을 여기 한 곳에만 적어 두면, 새 큐가 생겨도 고칠 자리가 하나다.
 */
export const PUBLIC_QUEUE_CATEGORIES = ["solo", "flex", "aram", "normal", "clash"] as const;

/**
 * 필터 하나를 **실제 분류 목록**으로 편다. 질의는 이걸 `= ANY(...)` 로 쓰면 된다.
 * `all` 은 `null` 을 돌려준다 — "거르지 않는다" 는 뜻이고, 전 분류를 나열하는 것과
 * 달리 새 분류가 생겨도 조용히 빠지지 않는다.
 */
export function expandCategory(filter: MatchCategoryFilter | undefined | null): MatchCategory[] | null {
  if (!filter || filter === "all") return null;
  if (filter === "public_queue") return [...PUBLIC_QUEUE_CATEGORIES];
  return [filter];
}

export const CATEGORY_LABEL: Record<MatchCategoryFilter, string> =
  Object.fromEntries(MATCH_CATEGORIES.map((c) => [c.key, c.label])) as Record<MatchCategoryFilter, string>;

export const isMatchCategoryFilter = (v: string): v is MatchCategoryFilter =>
  MATCH_CATEGORIES.some((c) => c.key === v);

/**
 * 공개 큐의 queueId → 분류.
 * ★ 모르는 큐를 임의로 '일반' 에 넣지 않는다 — 새 큐가 생기면 `other` 로 모여
 *   눈에 띄고, 그때 표를 고치면 된다. 조용히 섞이는 편이 훨씬 나쁘다.
 */
const QUEUE: Record<number, MatchCategory> = {
  420: "solo",
  440: "flex",
  450: "aram",
  400: "normal",   // 일반 드래프트
  430: "normal",   // 일반 블라인드
  480: "normal",   // 신속 대전(Swiftplay) — 협곡 일반 게임(0079)
  490: "normal",   // 빠른 대전
  700: "clash",
};

export interface MatchCategoryInput {
  source: string;
  queue_id: number | null;
  /** 이 경기가 붙어 있는 `event.kind`. 대회에 안 붙었으면 null. */
  event_kind?: string | null;
  game_mode?: string | null;
}

/**
 * 맵·규칙으로 먼저 갈리는 공개 큐. 경기 맥락(event)보다 앞선다.
 * ★ 증강 칼바람(아수라장, 2400)은 일반 칼바람과 가르지 않는다 — 한 화면·한 집계다(0078).
 * ★ 아레나·우르프는 원본만 남기고 어떤 공개 화면·집계에도 넣지 않는다(0078).
 */
const ARAM_QUEUES = new Set([450, 2400]);
const EXCLUDED_QUEUES = new Set([1700, 1710, 1740, 1750, 900, 1900]);
const EXCLUDED_MODES = new Set(["CHERRY", "URF", "ARURF"]);

export function matchCategory({ source, queue_id, event_kind, game_mode }: MatchCategoryInput): MatchCategory {
  // 맵/규칙이 먼저다. 칼바람 CK도 소환사의 협곡 CK 집계에 섞지 않는다.
  const publicQueue = source === "public_queue";
  if (game_mode === "ARAM" || (publicQueue && queue_id != null && ARAM_QUEUES.has(queue_id))) {
    return publicQueue ? "aram" : "aram_custom";
  }
  if ((game_mode != null && EXCLUDED_MODES.has(game_mode))
      || (publicQueue && queue_id != null && EXCLUDED_QUEUES.has(queue_id))) return "excluded";
  // 대회가 붙어 있으면 그게 가장 확실한 근거다 — 사람이 판단해 넣은 값이다.
  if (event_kind === "ck") return "ck";
  if (event_kind === "land") return "land";
  if (event_kind === "scrim") return "scrim";
  if (event_kind === "tournament" || event_kind === "showmatch") return "tournament";

  if (source === "public_queue") return (queue_id != null && QUEUE[queue_id]) || "other";
  // 코드로 만든 커스텀인데 대회가 안 붙었다 → 무슨 판인지 모르는 코드 내전. CK 로 단정하지 않는다(0077).
  if (source === "tournament_code") return "code_custom";
  // 수기인데 대회조차 없다. 무슨 판이었는지 근거가 없으므로 지어내지 않는다.
  return "other";
}
