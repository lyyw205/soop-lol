"use client";

/**
 * 기간 필터 한 줄 — **시작일 · 종료일 · 적용 · 초기화.** 기간 프리셋은 달력 안에 있다.
 *
 * ★ 왜 값을 직접 안 바꾸고 `onApply` 로 넘기나
 *   같은 UI 를 쓰는 두 화면이 기간을 **다른 곳에 들고 있다** — 개인 기록은 주소
 *   (`?period=&from=&to=`), 상대전적은 컴포넌트 상태다. 어느 쪽인지는 이 칸이 알 바가
 *   아니므로 "이 범위로 정했다" 만 알린다. 두 화면이 생김새를 공유하는 유일한 방법이다.
 *
 * ★ 적용은 사용자가 누른다
 *   달력에서 프리셋을 고르면 두 칸이 채워지기만 한다. 값을 보고 확인하는 흐름이
 *   달력 안에서는 더 맞다.
 */

import { useState } from "react";
import { RECORD_PERIODS, resolveRecordPeriod, type RecordPeriod } from "@soop-lol/core/lib/contract/client";
import { DateField } from "./date-field.tsx";

/** `all` 은 빼 둔다 — 해제는 초기화 단추가 맡는다. 프리셋에 '전체' 를 또 두면 말이 겹친다. */
const PRESETS = RECORD_PERIODS.filter((p) => p.key !== "all");

export function RecordDateRange({ period, onApply, label = "기간", disabled = false }: {
  /** 지금 걸려 있는 기간. 칸의 초기값과 초기화 단추의 활성 여부를 여기서 읽는다. */
  period: RecordPeriod;
  /** 범위를 정했을 때. `null` 이면 기간 해제다. */
  onApply: (range: { from: string; to: string } | null) => void;
  label?: string;
  disabled?: boolean;
}) {
  const [from, setFrom] = useState(period.from ?? "");
  const [to, setTo] = useState(period.to ?? "");
  const [error, setError] = useState("");

  /** 프리셋을 고르면 **오늘 기준 그 기간 앞까지**로 두 칸을 채운다. */
  function fillPreset(key: string) {
    const next = resolveRecordPeriod({ period: key });
    setFrom(next.from ?? "");
    setTo(next.to ?? "");
    setError("");
  }

  return (
    <fieldset className="record-period-filters" data-inline disabled={disabled} aria-busy={disabled}>
      <legend className="sr-only">{label}</legend>
      <div className="record-filter-toolbar" role="group" aria-label={label}>
        <form className="record-date-range" onSubmit={(event) => {
          event.preventDefault();
          // 두 칸이 다 비었으면 "기간 없음" 이다 — 형식 오류로 막지 않는다.
          if (!from && !to) { setError(""); onApply(null); return; }
          const next = resolveRecordPeriod({ period: "custom", from, to });
          if (next.error) { setError(next.error); return; }
          setError("");
          onApply({ from, to });
        }}>
          {/* 종료일 칸은 시작일보다 이른 날을 못 고르게 막는다 — 고른 뒤에 '종료일은 시작일보다
              빠를 수 없습니다' 를 보여 주는 것보다 애초에 못 누르는 편이 낫다. */}
          <DateField label="시작일" value={from} max={to || undefined}
            onChange={(v) => { setFrom(v); setError(""); }} presets={PRESETS} onPreset={fillPreset} />
          <span className="record-date-separator" aria-hidden="true">–</span>
          <DateField label="종료일" value={to} min={from || undefined}
            onChange={(v) => { setTo(v); setError(""); }} presets={PRESETS} onPreset={fillPreset} />
          <button type="submit" aria-label="기간 적용">적용</button>
          {/* 초기화 — 두 칸을 비우고 기간을 푼다. 걸린 게 없으면 누를 것도 없다. */}
          <button type="button" className="record-date-reset" aria-label="기간 초기화" title="기간 초기화"
            disabled={!from && !to && period.key === "all"}
            onClick={() => { setFrom(""); setTo(""); setError(""); onApply(null); }}>
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor"
              strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <path d="M13 8a5 5 0 1 1-1.6-3.7M13 2v3h-3" />
            </svg>
          </button>
        </form>
      </div>
      {(error || period.error) && <p className="record-filter-error" role="alert">{error || period.error}</p>}
    </fieldset>
  );
}
