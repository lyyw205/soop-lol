/**
 * **경기 분류** — "어떤 맥락에서 붙었나". 화면 필터의 기준이 되는 단 하나의 축이다.
 *
 * ★ 왜 `source` 하나로 안 되나
 *   `match.source` 는 **어떻게 알게 됐나**(공개 큐 조회 / 토너먼트 코드 / 수기)를 말하지,
 *   **무슨 판이었나**를 말하지 않는다. 실제 분포를 보면 바로 드러난다:
 *
 *     manual  q=0  event.kind='tournament'  776건   ← 멸망전 같은 공식 대회
 *     manual  q=0  event.kind='scrim'         5건   ← 내전(CK)
 *
 *   둘 다 `source='manual'` 이라 source 로는 절대 못 가른다. 세 값을 같이 봐야 한다.
 *
 * ★ 토너먼트 코드인데 대회가 안 붙어 있으면 내전으로 본다
 *   토너먼트 코드는 애초에 **내전을 API 로 잡으려고** 쓰는 물건이다
 *   (CLAUDE.md 제약 1 — 커스텀 게임은 그 경로로만 사후 조회된다).
 *   그래서 "코드로 만들어졌는데 우리가 아직 이름을 못 붙인 판" 은 내전이 맞다.
 *
 * ★ 이 규칙은 SQL 에도 같은 모양으로 있다 (`lol_match_category`, 마이그레이션 0016).
 *   질의에서 걸러야 빠르고, 화면에서 이름을 붙이려면 TS 가 필요해서 양쪽에 둔다.
 *   **둘이 어긋나면 필터가 조용히 거짓말을 한다** — `verify:db` 가 전 조합을 대조한다.
 *   `lp_absolute` 를 양쪽에 두고 검사로 묶어 둔 것과 같은 방식이다(§11-6).
 */

export const MATCH_CATEGORIES = [
  { key: "all", label: "전체" },
  { key: "public_queue", label: "공개 큐" },
  { key: "solo", label: "솔로랭크" },
  { key: "flex", label: "자유랭크" },
  { key: "aram", label: "칼바람" },
  { key: "normal", label: "일반" },
  { key: "clash", label: "클래시" },
  { key: "scrim", label: "내전 (CK)" },
  { key: "tournament", label: "대회" },
  { key: "other", label: "기타" },
] as const;

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
  490: "normal",   // 빠른 대전
  700: "clash",
};

export interface MatchCategoryInput {
  source: string;
  queue_id: number | null;
  /** 이 경기가 붙어 있는 `event.kind`. 대회에 안 붙었으면 null. */
  event_kind?: string | null;
}

export function matchCategory({ source, queue_id, event_kind }: MatchCategoryInput): MatchCategory {
  // 대회가 붙어 있으면 그게 가장 확실한 근거다 — 사람이 판단해 넣은 값이다.
  if (event_kind === "scrim") return "scrim";
  if (event_kind === "tournament" || event_kind === "showmatch") return "tournament";

  if (source === "public_queue") return (queue_id != null && QUEUE[queue_id]) || "other";
  // 코드로 만든 커스텀인데 대회가 안 붙었다 → 아직 이름을 못 붙인 내전
  if (source === "tournament_code") return "scrim";
  // 수기인데 대회조차 없다. 무슨 판이었는지 근거가 없으므로 지어내지 않는다.
  return "other";
}
