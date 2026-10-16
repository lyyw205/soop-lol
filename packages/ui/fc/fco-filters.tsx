"use client";

import { useRouter } from "next/navigation";
import { FCO_MODE_LABEL, FORMATS_BY_GAME, formatChipLabel } from "@soop-lol/core/lib/contract/client";

/**
 * FC 기록 필터 — 진행 방식이 기본 축이고 경기 모드는 보조다(docs/CLASSIFICATION-REDESIGN-PLAN.md §3.3·§5.3).
 * ★ 진행 방식 선택지 = `전체` + FORMATS_BY_GAME.fconline 순서(대회·CK·컨셉·친선·분류 전). "전체" = 칩들의 합이다 — 미분류도 칩이 있다.
 * ★ 경기 모드 이름은 넥슨 뜻 그대로다(40 = "클래식 1on1"). 진행 방식의 "친선"과 다른 말이다.
 */
export const FCO_FORMAT_CHOICES: { value: string; label: string }[] = [
  { value: "all", label: "전체" },
  ...FORMATS_BY_GAME.fconline.map((f) => ({ value: f, label: formatChipLabel(f) })),
];

export const fcoModeLabel = (mode: string) => (mode === "all" ? "모든 모드" : FCO_MODE_LABEL[mode] ?? `모드 ${mode}`);

/** 경기 모드 보조 선택. 주소를 바꾸려면 choice 마다 href, 화면 상태만 바꾸려면 onChange. */
export function FcoModeSelect({ value, choices, onChange }: {
  value: string; choices: { value: string; href?: string }[]; onChange?: (mode: string) => void;
}) {
  const router = useRouter();
  return <select aria-label="경기 모드" value={value} onChange={(e) => {
    const next = e.currentTarget.value;
    if (onChange) onChange(next);
    else { const href = choices.find((c) => c.value === next)?.href; if (href) router.push(href, { scroll: false }); }
  }}>
    {choices.map((c) => <option key={c.value} value={c.value}>{fcoModeLabel(c.value)}</option>)}
  </select>;
}
