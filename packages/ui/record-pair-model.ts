import type { Counts } from "@soop-lol/core/lib/contract/client";

/**
 * 기록 부품(RecordPair)의 문구 규칙 — 승·무·패·미상을 **숨기지 않고** 한 줄로.
 *
 * ★ 승 + 무 + 패 + 미상 = 판 수. 미상이 있으면 언제나 보인다 — 숨기면 합이 안 맞아 "몇 판 어디 갔나" 가 된다.
 *   무는 0 이면 생략한다(대부분의 롤 판엔 무가 없다). 0 이 아닌 무·미상은 늘 적는다.
 */
export interface RecordPart { key: keyof Counts; n: number; label: string }

export function recordParts(c: Counts): RecordPart[] {
  return [
    { key: "win" as const, n: c.win, label: "승" },
    ...(c.draw ? [{ key: "draw" as const, n: c.draw, label: "무" }] : []),
    { key: "loss" as const, n: c.loss, label: "패" },
    ...(c.unknown ? [{ key: "unknown" as const, n: c.unknown, label: "미상" }] : []),
  ];
}

/** `12승 1무 10패 · 미상 2` */
export function recordText(c: Counts): string {
  const parts = recordParts(c);
  const known = parts.filter((p) => p.key !== "unknown").map((p) => `${p.n}${p.label}`).join(" ");
  const unknown = parts.find((p) => p.key === "unknown");
  return unknown ? `${known} · 미상 ${unknown.n}` : known;
}
