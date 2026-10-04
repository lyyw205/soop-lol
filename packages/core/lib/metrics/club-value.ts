/**
 * FC 구단을 자산처럼 계산한다 — 스쿼드 등록 선수(합집합), 가치 이력, 현재 스쿼드 소급 추정, 변동 분해, 등락률.
 *
 * 원본은 셋뿐이다(db/migrations/0060): ① 공식 구단가치 ② 날짜별 보유(스쿼드 6칸) ③ 카드 일별 시세.
 * 여기 있는 것은 전부 그 셋에서 언제든 다시 만드는 **계산**이고 저장하지 않는다(코딩 원칙 5).
 * 웹·워커·모듈이 이 함수 하나를 쓴다(원칙 6).
 *
 * ★ 숫자 두 종류를 섞지 않는다.
 *   현재가(스쿼드 응답의 price)  — 오늘 숫자. 넥슨 스쿼드 화면 합과 맞는다.
 *   일별 시세(③)                — 차트 선. 현재가와 다른 숫자다(케인 26TOTS 11강: 현재가 428억 · 그날 일별 411.9억).
 *   마지막 날만 현재가로 바꾸면 차트 끝이 가짜로 튄다.
 */

export interface HoldingRow {
  teamType: 0 | 1;
  slot: 1 | 2 | 3;
  /** 넥슨 자리 이름. 선발은 소문자(gk·lcb…), 교체는 대문자. */
  role: string;
  isStarter: boolean;
  spid: number;
  /** 강화. 현재가가 여러 강화에서 같으면(싼 카드의 1·2강, 강화 없는 아이콘 TM) 모른다 → null. */
  grade: number | null;
  /** 현재가. */
  price: number | null;
  name: string;
  season: string | null;
  ovr: number | null;
}

export const SQUAD_LABEL: Record<string, string> = {
  "1:1": "대표A", "1:2": "대표B", "1:3": "대표C", "0:1": "클럽A", "0:2": "클럽B", "0:3": "클럽C",
};
export const squadLabel = (teamType: number, slot: number) => SQUAD_LABEL[`${teamType}:${slot}`] ?? `${teamType}:${slot}`;

export interface HeldCard {
  spid: number;
  grade: number | null;
  price: number | null;
  name: string;
  season: string | null;
  ovr: number | null;
  /** 이 카드가 들어 있는 칸(대표A …), 6칸 순서대로. */
  squads: string[];
  /** 그중 선발로 들어 있는 칸. */
  starterIn: string[];
}

/**
 * 같은 카드인가 = 같은 spid + 같은 강화. 강화가 다르면 실제로 두 장을 가진 것이고,
 * 같은 선수의 다른 시즌 카드는 spid 가 다르다. 강화를 모르는 카드는 spid 만으로 묶는다
 * (모르는 강화 둘을 다른 카드로 셀 근거가 없다).
 */
export const cardKey = (c: { spid: number; grade: number | null }) => `${c.spid}:${c.grade ?? "?"}`;

/** 6칸의 합집합 — "스쿼드 등록 선수". 현재가 높은 순. 창고는 보이지 않으므로 보유 선수 전부가 아니다. */
export function unionHoldings(rows: HoldingRow[]): HeldCard[] {
  const order = (r: HoldingRow) => (1 - r.teamType) * 3 + r.slot;
  const cards = new Map<string, HeldCard>();
  for (const row of [...rows].sort((a, b) => order(a) - order(b))) {
    const key = cardKey(row);
    const label = squadLabel(row.teamType, row.slot);
    const card = cards.get(key) ?? {
      spid: row.spid, grade: row.grade, price: row.price, name: row.name, season: row.season, ovr: row.ovr,
      squads: [], starterIn: [],
    };
    if (!card.squads.includes(label)) card.squads.push(label);
    if (row.isStarter && !card.starterIn.includes(label)) card.starterIn.push(label);
    cards.set(key, card);
  }
  return [...cards.values()].sort((a, b) => (b.price ?? -1) - (a.price ?? -1) || a.name.localeCompare(b.name, "ko"));
}

/** 현재가 합. 현재가가 비어 있는 카드는 더하지 않고 센다. */
export function currentValue(cards: { price: number | null }[]): { value: number; unpriced: number } {
  let value = 0, unpriced = 0;
  for (const c of cards) {
    if (c.price === null) unpriced++;
    else value += c.price;
  }
  return { value, unpriced };
}

// ── 일별 시세로 평가 ─────────────────────────────────────────────────

export type Card = { spid: number; grade: number | null };
/** (카드, 날) → 그날 일별 시세. 모르면 undefined. */
export type PriceAt = (card: Card, day: string) => number | undefined;

export interface ValuePoint {
  day: string;
  value: number;
  /** 시세로 평가한 카드 수 / 평가하지 못한 카드 수(강화를 모르거나 그날 시세가 없다). */
  priced: number;
  missing: number;
}

function valueOn(cards: Card[], day: string, priceAt: PriceAt): ValuePoint {
  let value = 0, priced = 0, missing = 0;
  for (const card of cards) {
    const p = card.grade === null ? undefined : priceAt(card, day);
    if (p === undefined) missing++;
    else { value += p; priced++; }
  }
  return { day, value, priced, missing };
}

export interface DayHoldings { day: string; cards: Card[] }

/**
 * 실제 가치 이력 — 날짜마다 **그날 들고 있던** 카드를 그날 시세로. 스냅샷이 있는 날만 점이 생긴다.
 * 시세가 없는 카드가 섞인 날도 점은 남기되 missing 으로 센다 — 빈 날을 지어 메우지 않는다.
 */
export function holdingsSeries(days: DayHoldings[], priceAt: PriceAt): ValuePoint[] {
  return days.map((d) => valueOn(d.cards, d.day, priceAt));
}

/**
 * 현재 스쿼드 소급 추정 — "지금 카드를 그때부터 들고 있었다면". **실제 이력이 아니다.**
 * 시세 이력이 있는 카드가 **전부** 시세를 가진 날만 점으로 낸다. 그 전 날은 아직 나오지 않은 카드가
 * 빠져 값이 가짜로 낮아지기 때문이다. 강화를 몰라 시세를 못 붙이는 카드는 처음부터 빼고 그 수를 남긴다.
 */
export function backcastSeries(cards: Card[], days: string[], priceAt: PriceAt): ValuePoint[] {
  const tracked = cards.filter((c) => c.grade !== null && days.some((day) => priceAt(c, day) !== undefined));
  const excluded = cards.length - tracked.length;
  if (!tracked.length) return [];
  return days
    .map((day) => valueOn(tracked, day, priceAt))
    .filter((p) => p.missing === 0)
    .map((p) => ({ ...p, missing: excluded }));
}

export interface ValueChange {
  from: string;
  to: string;
  /** 두 날 다 들고 있던 카드의 시세 변화. */
  market: number;
  /** 새로 들어온 카드(to 시세) − 빠진 카드(from 시세). 선수를 사고판 효과. */
  trades: number;
  added: number;
  removed: number;
  /** 시세가 없어 계산에서 뺀 카드 수. */
  missing: number;
}

/**
 * 변동 분해. 두 스냅샷 사이 가치 변화 = 시세 효과 + 교체 효과.
 * 시세가 한쪽 날이라도 없는 카드는 어느 효과에도 넣지 않고 missing 으로 센다.
 */
export function decomposeChange(prev: DayHoldings, cur: DayHoldings, priceAt: PriceAt): ValueChange {
  const before = new Map(prev.cards.map((c) => [cardKey(c), c]));
  const after = new Map(cur.cards.map((c) => [cardKey(c), c]));
  const price = (c: Card, day: string) => c.grade === null ? undefined : priceAt(c, day);
  const out: ValueChange = { from: prev.day, to: cur.day, market: 0, trades: 0, added: 0, removed: 0, missing: 0 };
  for (const [key, card] of after) {
    const now = price(card, cur.day);
    if (before.has(key)) {
      const then = price(card, prev.day);
      if (now === undefined || then === undefined) out.missing++;
      else out.market += now - then;
    } else {
      out.added++;
      if (now === undefined) out.missing++;
      else out.trades += now;
    }
  }
  for (const [key, card] of before) {
    if (after.has(key)) continue;
    out.removed++;
    const then = price(card, prev.day);
    if (then === undefined) out.missing++;
    else out.trades -= then;
  }
  return out;
}

/**
 * 등락 — 기준일(day 에서 n일 전) 이하의 가장 최근 값과 비교한다. 그런 값이 없으면 null
 * (기록이 그만큼 쌓이지 않았다 — 0% 로 쓰지 않는다, 원칙 3).
 */
export function changeOver(series: { day: string; value: number }[], days: number): { delta: number; pct: number; since: string } | null {
  if (series.length < 2) return null;
  const last = series.at(-1)!;
  const cutoff = shiftDay(last.day, -days);
  const base = [...series].reverse().find((p) => p.day <= cutoff);
  if (!base || base.value <= 0) return null;
  return { delta: last.value - base.value, pct: (last.value - base.value) / base.value * 100, since: base.day };
}

/** "2026-10-02" ± n일. */
export function shiftDay(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/**
 * 넥슨 화면과 같은 표기 — "2,274억 5,879만" · "1만 2,600" · "1,110". 억이 있으면 만 아래는 버린다.
 * 원 단위 정확값은 화면이 title 로 준다.
 */
export function formatWon(value: number): string {
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(Math.round(value));
  const eok = Math.floor(abs / 1e8);
  const man = Math.floor((abs % 1e8) / 1e4);
  const rest = abs % 1e4;
  const n = (x: number) => x.toLocaleString("ko-KR");
  if (eok > 0) return `${sign}${n(eok)}억${man ? ` ${n(man)}만` : ""}`;
  if (man > 0) return `${sign}${n(man)}만${rest ? ` ${n(rest)}` : ""}`;
  return `${sign}${n(rest)}`;
}
