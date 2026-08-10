/**
 * 대회 순위 표기를 다루는 곳.
 *
 * 표기가 회차마다 제각각이다 — `4강` · `10강` · `2차예선 탈락` · `예선 6강 or 4강 탈락`.
 * **화면엔 출처가 쓴 그대로 보여주고, 세는 건 숫자로 한다.** 표기를 통일해서 저장하면
 * 원문이 사라지고, 숫자 없이 표기만 두면 "우승 몇 번"을 셀 수 없다. 둘 다 들고 간다.
 *
 * ★ 모르는 표기는 `null` 이다. 억지로 숫자를 붙이면 요약이 조용히 틀어진다.
 */

/** 정렬·집계용 숫자. 1=우승, 2=준우승, 4=4강, 8=8강 … 99=예선 탈락. */
export function placementRank(label: string | null | undefined): number | null {
  if (!label) return null;
  const t = String(label).replace(/\s+/g, "");
  if (t === "우승") return 1;
  if (t === "준우승") return 2;
  // ★ '4강 탈락'·'8강 탈락' 은 **거기까지 갔다**는 뜻이다. 예선 탈락과 같이 세면 안 된다.
  //   2025~2026 회차 범례가 이 표기를 쓴다. 아래 `탈락` 규칙보다 반드시 먼저 본다 —
  //   순서를 바꾸면 4강까지 간 팀이 조용히 '예선 탈락' 으로 집계된다.
  const gang = /^(\d+)강(탈락)?$/.exec(t);
  if (gang) return Number(gang[1]);
  // 예선은 몇 차에서 떨어졌든 '본선에 못 왔다' 로 묶는다. 회차마다 예선 단계 수가 달라
  // 그대로 두면 요약이 잘게 쪼개져 읽히지 않는다.
  if (/탈락/.test(t)) return 99;
  // '공동3위' 도 '3위' 도 받는다. '공동3-4위' 처럼 범위로 적힌 회차는 앞 숫자를 쓴다.
  const wi = /^(?:공동?)?(\d+)(?:-\d+)?위$/.exec(t);
  if (wi) return Number(wi[1]);
  if (t === "본선" || t === "본선진출") return 50;
  return null;
}

/** 요약 카드에서 묶는 단위. rank 로 묶고, 화면엔 이 이름을 쓴다. */
export const PLACEMENT_BUCKETS = [
  { key: "champion", label: "우승", match: (r: number) => r === 1 },
  { key: "runnerup", label: "준우승", match: (r: number) => r === 2 },
  { key: "semi", label: "4강", match: (r: number) => r > 2 && r <= 4 },
  { key: "quarter", label: "8강", match: (r: number) => r > 4 && r <= 10 },
  { key: "qualifier", label: "예선 탈락", match: (r: number) => r === 99 },
] as const;

export type PlacementBucketKey = (typeof PLACEMENT_BUCKETS)[number]["key"];

export function placementBucket(rank: number | null | undefined): PlacementBucketKey | null {
  if (rank == null) return null;
  return PLACEMENT_BUCKETS.find((b) => b.match(rank))?.key ?? null;
}
