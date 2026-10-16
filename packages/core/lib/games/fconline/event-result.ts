import { resolveBracket, type BracketInput } from "../../tournament/bracket.ts";

type Entrant = {
  id: string; name: string;
  members: { name: string; image: string | null; channelId: string | null }[];
};

export interface FcoEventResult {
  label: "종합 스코어" | "결승 스코어";
  sides: [Entrant & { score: number; won: boolean }, Entrant & { score: number; won: boolean }];
}

/** 행사 결과는 대진의 최종 결정에서 가져온다. 마지막 경기의 골이나 참가자별 승수를 대신 쓰지 않는다. */
export function fcoEventResult(bracket: { input: BracketInput; entrants: Entrant[] } | null): FcoEventResult | null {
  if (!bracket) return null;
  const finals = bracket.input.routes.filter((r) => r.outcome === "winner" && r.to.kind === "placement"
    && r.to.min === 1 && r.to.max === 1);
  if (finals.length !== 1) return null;
  const result = resolveBracket(bracket.input);
  if (result.issues.some((issue) => issue.level === "error")) return null;
  const final = result.slots.find((s) => s.slot.id === finals[0].fromSlot);
  if (!final || final.slot.kind !== "match" || final.state !== "decided" || final.certainty === "inferred") return null;
  // 형식을 모르는 상태에서 수집된 한 판만으로 행사 전체의 종료를 추정하지 않는다.
  if (final.source === "match" && final.slot.bestOf == null) return null;
  const [a, b] = final.occupants.map((id) => bracket.entrants.find((entrant) => entrant.id === id));
  const [scoreA, scoreB] = final.score;
  if (!a || !b || scoreA == null || scoreB == null) return null;
  return {
    label: bracket.entrants.length === 2 ? "종합 스코어" : "결승 스코어",
    sides: [
      { ...a, score: scoreA, won: final.winners.includes(a.id) },
      { ...b, score: scoreB, won: final.winners.includes(b.id) },
    ],
  };
}
