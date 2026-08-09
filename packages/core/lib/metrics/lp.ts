/**
 * 티어 ↔ 정렬 가능한 단일 정수(`lp_absolute`) 변환.
 *
 * ★ 같은 표가 `db/schema.sql` 의 `lol_lp_absolute()` 에도 있다.
 *   두 군데에 있는 계산식은 **반드시** 어긋난다 — 그래서 경고 주석 대신
 *   `lp.test.ts` 가 schema.sql 을 직접 읽어 이 상수표와 대조한다.
 *   한쪽만 고치면 테스트가 깨진다.
 *
 * DB 쪽이 필요한 이유: 인덱스·정렬·리더보드가 SQL 에서 돌아야 한다.
 * TS 쪽이 필요한 이유: 차트 y축 눈금은 정수를 다시 티어 라벨로 돌려야 한다(역변환).
 */

export const TIER_BASE = {
  IRON: 0,
  BRONZE: 400,
  SILVER: 800,
  GOLD: 1200,
  PLATINUM: 1600,
  EMERALD: 2000,
  DIAMOND: 2400,
} as const;

/** MASTER 이상은 디비전이 없고 LP 사다리가 연속이다. 구간을 나누지 않는다. */
export const APEX_BASE = 2800;
export const APEX_TIERS = ["MASTER", "GRANDMASTER", "CHALLENGER"] as const;

export const DIVISION_OFFSET = { IV: 0, III: 100, II: 200, I: 300 } as const;

export type Tier = keyof typeof TIER_BASE | (typeof APEX_TIERS)[number];
export type Division = keyof typeof DIVISION_OFFSET;

export interface RankLike {
  tier?: string | null;
  division?: string | null;
  leaguePoints?: number | null;
}

export function isApexTier(tier: string | null | undefined): boolean {
  return APEX_TIERS.includes(String(tier ?? "").toUpperCase() as (typeof APEX_TIERS)[number]);
}

/** SQL `lol_lp_absolute()` 의 TS 쌍. 언랭이면 null. */
export function lpAbsolute(rank: RankLike): number | null {
  const tier = String(rank.tier ?? "").toUpperCase();
  const lp = rank.leaguePoints ?? 0;
  if (isApexTier(tier)) return APEX_BASE + lp;
  const base = TIER_BASE[tier as keyof typeof TIER_BASE];
  if (base === undefined) return null;
  const division = String(rank.division ?? "IV").toUpperCase() as Division;
  return base + (DIVISION_OFFSET[division] ?? 0) + lp;
}

/**
 * 역변환 — 차트 y축 눈금용.
 * MASTER 이상은 하나의 구간이므로 티어를 세분할 수 없다. 'MASTER+' 로 돌려준다.
 */
export function lpAbsoluteToRank(value: number): { tier: string; division: Division | null; lp: number } {
  if (value >= APEX_BASE) return { tier: "MASTER+", division: null, lp: value - APEX_BASE };
  const entries = Object.entries(TIER_BASE) as [keyof typeof TIER_BASE, number][];
  // 큰 것부터 훑어 첫 번째로 들어맞는 구간.
  for (let i = entries.length - 1; i >= 0; i--) {
    const [tier, base] = entries[i];
    if (value >= base) {
      const within = value - base;
      const divIdx = Math.min(3, Math.floor(within / 100));
      const division = (["IV", "III", "II", "I"] as const)[divIdx];
      return { tier, division, lp: within - divIdx * 100 };
    }
  }
  return { tier: "IRON", division: "IV", lp: Math.max(0, value) };
}

const TIER_SHORT: Record<string, string> = {
  IRON: "I", BRONZE: "B", SILVER: "S", GOLD: "G",
  PLATINUM: "P", EMERALD: "E", DIAMOND: "D",
  MASTER: "M", GRANDMASTER: "GM", CHALLENGER: "C", "MASTER+": "M+",
};

const DIVISION_NUMBER: Record<string, string> = { IV: "4", III: "3", II: "2", I: "1" };

/** "D1 42LP" / "Master 213LP" / "언랭" */
export function formatRank(rank: RankLike): string {
  const tier = String(rank.tier ?? "").toUpperCase();
  if (!tier) return "언랭";
  const lp = rank.leaguePoints ?? 0;
  if (isApexTier(tier) || tier === "MASTER+") return `${TIER_SHORT[tier] ?? tier} ${lp}LP`;
  const short = TIER_SHORT[tier];
  if (!short) return "언랭";
  const div = DIVISION_NUMBER[String(rank.division ?? "").toUpperCase()] ?? "";
  return `${short}${div} ${lp}LP`;
}

/** 차트 눈금용 — 티어 경계값들. 주어진 범위 안에 들어오는 것만. */
export function tierGridLines(min: number, max: number): { value: number; label: string }[] {
  const lines: { value: number; label: string }[] = [];
  for (const [tier, base] of Object.entries(TIER_BASE)) {
    if (base >= min && base <= max) lines.push({ value: base, label: TIER_SHORT[tier] ?? tier });
  }
  if (APEX_BASE >= min && APEX_BASE <= max) lines.push({ value: APEX_BASE, label: "M" });
  return lines;
}
