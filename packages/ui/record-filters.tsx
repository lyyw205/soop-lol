"use client";

import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import { FORMATS_BY_GAME, MAP_TABS, formatChipLabel, type MapTab } from "@soop-lol/core/lib/contract/client";

type Choice = { value: string; label: string };

/**
 * 롤 진행 방식 선택지 — `전체` + FORMATS_BY_GAME.lol 순서(마지막은 언제나 "분류 전").
 * ★ 한 맵 탭 안에서 "전체" = 이 칩들의 합이다. 미분류도 칩이 있어 몰래 빠지는 값이 없다.
 * ★ 이름표는 format.ts(formatChipLabel) 한 곳 — 화면에 진행 방식 이름표를 따로 두지 않는다.
 */
export const LOL_FORMAT_CHOICES: Choice[] = [
  { value: "all", label: "전체" },
  ...FORMATS_BY_GAME.lol.map((f) => ({ value: f, label: formatChipLabel(f) })),
];

/**
 * @param trailing 기간 선택 뒤에 붙는 자리. 개인 기록은 여기에 기간 필터(전체/6개월/직접 입력)를
 *   넣는다 — 예전엔 탭마다 따로 있었는데, 연도 선택과 서로 덮어써서 어느 게 먹은 건지
 *   화면에서 알 수 없었다. 한 줄에 모아 두면 그 관계가 눈에 보인다.
 * @param leading 선택 앞자리(롤 맵 탭). @param hideCategory 칼바람 탭처럼 진행 방식으로 나누지 않을 때.
 */
export function RecordFilters({ category, year, categories, years, onCategoryChange, onYearChange, children, trailing, leading, hideCategory = false, categoryLabel = "경기 카테고리" }: {
  category: string; year: string; categories: Choice[]; years: Choice[];
  onCategoryChange: (value: string) => void; onYearChange: (value: string) => void;
  children: ReactNode; trailing?: ReactNode; leading?: ReactNode; hideCategory?: boolean; categoryLabel?: string;
}) {
  return <div className="arena-filterbar record-filterbar">
    <div className="record-filter-context">{children}</div>
    <div className="arena-filter-selects">
      {leading}
      {!hideCategory && (
        <select aria-label={categoryLabel} value={category} onChange={(e) => onCategoryChange(e.currentTarget.value)}>
          {categories.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
      )}
      {/* 연도 선택은 있는 화면에만 그린다 — 개인 기록은 기간 필터 하나로 합쳤다. */}
      {years.length > 0 && (
        <select aria-label="기간" value={year} onChange={(e) => onYearChange(e.currentTarget.value)}>
          {years.map((y) => <option key={y.value} value={y.value}>{y.label}</option>)}
        </select>
      )}
      {trailing && <><span className="record-filter-divider" aria-hidden="true" />{trailing}</>}
    </div>
  </div>;
}

/**
 * 롤 맵 탭(협곡/칼바람). 맵 탭끼리는 세트만 더해진다 — 맵이 섞인 시리즈는 양쪽 탭에 하나씩 잡힌다(계획 §5.3).
 * `hrefFor` 를 주면 주소를 바꾸고(개인 기록), `onChange` 를 주면 화면 상태만 바꾼다(상대전적).
 */
export function MapTabs({ value, onChange, hrefFor }: {
  value: MapTab; onChange?: (map: MapTab) => void; hrefFor?: (map: MapTab) => string;
}) {
  const router = useRouter();
  return <div className="arena-tabs" aria-label="맵">
    {MAP_TABS.map((m) => <button key={m.key} type="button" aria-pressed={value === m.key}
      onClick={() => { if (onChange) onChange(m.key); else if (hrefFor) router.push(hrefFor(m.key), { scroll: false }); }}>{m.label}</button>)}
  </div>;
}

export function LinkedRecordFilters({ category, year, categories, years, trailing, leading, hideCategory, categoryLabel }: {
  category: string; year: string; categories: (Choice & { href: string })[]; years: (Choice & { href: string })[];
  trailing?: ReactNode; leading?: ReactNode; hideCategory?: boolean; categoryLabel?: string;
}) {
  const router = useRouter();
  return <RecordFilters category={category} year={year} categories={categories} years={years} trailing={trailing} leading={leading}
    hideCategory={hideCategory} categoryLabel={categoryLabel}
    onCategoryChange={(value) => { const choice=categories.find((c)=>c.value===value);if(choice)router.push(choice.href,{scroll:false}); }}
    onYearChange={(value) => { const choice=years.find((c)=>c.value===value);if(choice)router.push(choice.href,{scroll:false}); }}>
    <span className="record-scope-label">개인 전적</span>
  </RecordFilters>;
}
