/**
 * 대표 형식 도우미. 칸과 화살표를 한 번에 만들어 줄 뿐이고, 만든 결과는 그냥 데이터다 —
 * 화살표를 고쳐도(커스텀 대회) 계산·화면은 똑같이 동작한다. docs/TOURNAMENT-FORMAT-PLAN.md §2
 *
 * 칸 id 는 `${prefix}${번호}` 다. 번호는 진행 순서대로 매긴다(주최측 번호와 다르면 저장할 때 바꾼다).
 * 시드는 비워 둔다(1라운드 자리를 무엇이 채울지는 대회마다 다르다). 1라운드 칸의 seedA/seedB 를 채워 쓴다.
 */
import type { BracketRoute, BracketSlot, Side } from "./bracket.ts";

export interface Bracket { slots: BracketSlot[]; routes: BracketRoute[] }

interface Options {
  /** 칸 id 앞붙이. 기본 's' */
  prefix?: string;
  stageNo?: number;
  bestOf?: number | null;
}

const log2 = (n: number) => {
  const k = Math.log2(n);
  if (!Number.isInteger(k) || n < 2) throw new Error(`참가 수 ${n}: 2의 거듭제곱이어야 한다(부전승 자리는 시드를 비우지 말고 결정으로 처리)`);
  return k;
};

function builder(opts: Options) {
  const prefix = opts.prefix ?? "s";
  const slots: BracketSlot[] = [];
  const routes: BracketRoute[] = [];
  const add = (label: string, lane: string | null) => {
    const no = slots.length + 1;
    const slot: BracketSlot = {
      id: `${prefix}${no}`, stageNo: opts.stageNo ?? 1, no, label, lane, kind: "match",
      bestOf: opts.bestOf ?? null, picks: null, seedA: null, seedB: null,
    };
    slots.push(slot);
    return slot.id;
  };
  const to = (from: string, outcome: "winner" | "loser", slot: string, side: Side) =>
    routes.push({ fromSlot: from, outcome, to: { kind: "slot", slot, side } });
  const place = (from: string, outcome: "winner" | "loser", min: number, max: number) =>
    routes.push({ fromSlot: from, outcome, to: { kind: "placement", min, max } });
  return { slots, routes, add, to, place };
}

const roundName = (remaining: number) => (remaining === 2 ? "결승" : remaining === 4 ? "4강" : `${remaining}강`);

/** 단순 토너먼트. 같은 라운드에서 진 사람은 공동 순위(4강 탈락 = 3–4위). thirdPlace 면 3위 결정전을 둔다. */
export function singleElimination(n: number, opts: Options & { thirdPlace?: boolean } = {}): Bracket {
  const k = log2(n);
  const b = builder(opts);
  let previous: string[] = [];
  const semis: string[] = [];
  for (let r = 1; r <= k; r++) {
    const remaining = n / 2 ** (r - 1);
    const round = Array.from({ length: n / 2 ** r }, (_, i) => b.add(`${roundName(remaining)}${remaining > 2 ? ` ${i + 1}경기` : ""}`, null));
    previous.forEach((id, i) => b.to(id, "winner", round[Math.floor(i / 2)], i % 2 === 0 ? "a" : "b"));
    if (remaining === 4) semis.push(...round);
    // 이 라운드 패자의 순위: 남은 인원의 아래 절반
    if (remaining > 4 || (remaining === 4 && !opts.thirdPlace)) for (const id of round) b.place(id, "loser", remaining / 2 + 1, remaining);
    previous = round;
  }
  const final = previous[0];
  b.place(final, "winner", 1, 1);
  b.place(final, "loser", 2, 2);
  if (opts.thirdPlace && semis.length === 2) {
    const third = b.add("3위 결정전", null);
    semis.forEach((id, i) => b.to(id, "loser", third, i === 0 ? "a" : "b"));
    b.place(third, "winner", 3, 3);
    b.place(third, "loser", 4, 4);
  }
  return { slots: b.slots, routes: b.routes };
}

/**
 * 더블 엘리미네이션. 승자조에서 한 번 지면 패자조로, 패자조에서 지면 탈락.
 * 패자조는 「승자조 r라운드 패자가 내려오는 판(drop)」과 「패자조끼리 줄이는 판」이 번갈아 온다.
 * 결승은 단판 시리즈 하나(리셋 없음 — 결승 리셋은 조건부 진행이 필요해 지원하지 않는다. 문서 §5).
 * 패자조 탈락 순위는 탈락 순서대로 범위를 준다(8강: 7–8위, 5–6위, 4위, 3위).
 */
export function doubleElimination(n: number, opts: Options = {}): Bracket {
  const k = log2(n);
  if (k < 2) throw new Error("더블 엘리미네이션은 4명 이상");
  const b = builder(opts);
  let remaining = n;
  const eliminate = (ids: string[]) => {
    for (const id of ids) b.place(id, "loser", remaining - ids.length + 1, remaining);
    remaining -= ids.length;
  };
  let wbPrev: string[] = [];
  let lbPrev: string[] = [];
  let lbRound = 0;
  const lbName = (last: boolean) => (last ? "패자조 결승" : `패자조 ${++lbRound}라운드`);
  for (let r = 1; r <= k; r++) {
    const wb = Array.from({ length: n / 2 ** r }, (_, i) =>
      b.add(r === k ? "승자조 결승" : `승자조 ${r}라운드 · ${i + 1}`, "승자조"));
    wbPrev.forEach((id, i) => b.to(id, "winner", wb[Math.floor(i / 2)], i % 2 === 0 ? "a" : "b"));
    if (r === 1) {
      // 승자조 1라운드 패자끼리
      const lb = Array.from({ length: n / 4 }, () => b.add(lbName(false), "패자조"));
      wb.forEach((id, i) => b.to(id, "loser", lb[Math.floor(i / 2)], i % 2 === 0 ? "a" : "b"));
      eliminate(lb);
      lbPrev = lb;
    } else {
      // 승자조 r라운드 패자가 내려와 패자조 생존자와 붙는다
      const drop = wb.map((wid, i) => {
        const id = b.add(lbName(r === k), "패자조");
        b.to(wid, "loser", id, "a");
        b.to(lbPrev[i], "winner", id, "b");
        return id;
      });
      eliminate(drop);
      lbPrev = drop;
      if (r < k) {
        const merge = Array.from({ length: drop.length / 2 }, () => b.add(lbName(false), "패자조"));
        drop.forEach((id, i) => b.to(id, "winner", merge[Math.floor(i / 2)], i % 2 === 0 ? "a" : "b"));
        eliminate(merge);
        lbPrev = merge;
      }
    }
    wbPrev = wb;
  }
  const final = b.add("결승", null);
  b.to(wbPrev[0], "winner", final, "a");
  b.to(lbPrev[0], "winner", final, "b");
  b.place(final, "winner", 1, 1);
  b.place(final, "loser", 2, 2);
  return { slots: b.slots, routes: b.routes };
}
