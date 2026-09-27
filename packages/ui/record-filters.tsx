"use client";

import type { ReactNode } from "react";
import { useRouter } from "next/navigation";

type Choice = { value: string; label: string };

/**
 * @param trailing 기간 선택 뒤에 붙는 자리. 개인 기록은 여기에 기간 필터(전체/6개월/직접 입력)를
 *   넣는다 — 예전엔 탭마다 따로 있었는데, 연도 선택과 서로 덮어써서 어느 게 먹은 건지
 *   화면에서 알 수 없었다. 한 줄에 모아 두면 그 관계가 눈에 보인다.
 */
export function RecordFilters({ category, year, categories, years, onCategoryChange, onYearChange, children, trailing, categoryLabel = "경기 카테고리" }: {
  category: string; year: string; categories: Choice[]; years: Choice[];
  onCategoryChange: (value: string) => void; onYearChange: (value: string) => void;
  children: ReactNode; trailing?: ReactNode; categoryLabel?: string;
}) {
  return <div className="arena-filterbar record-filterbar">
    <div className="record-filter-context">{children}</div>
    <div className="arena-filter-selects">
      <select aria-label={categoryLabel} value={category} onChange={(e) => onCategoryChange(e.currentTarget.value)}>
        {categories.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
      </select>
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

export function LinkedRecordFilters({ category, year, categories, years, trailing, categoryLabel }: {
  category: string; year: string; categories: (Choice & { href: string })[]; years: (Choice & { href: string })[];
  trailing?: ReactNode; categoryLabel?: string;
}) {
  const router = useRouter();
  return <RecordFilters category={category} year={year} categories={categories} years={years} trailing={trailing} categoryLabel={categoryLabel}
    onCategoryChange={(value) => { const choice=categories.find((c)=>c.value===value);if(choice)router.push(choice.href,{scroll:false}); }}
    onYearChange={(value) => { const choice=years.find((c)=>c.value===value);if(choice)router.push(choice.href,{scroll:false}); }}>
    <span className="record-scope-label">개인 전적</span>
  </RecordFilters>;
}
