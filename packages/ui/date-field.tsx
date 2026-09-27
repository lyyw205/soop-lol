"use client";

/**
 * 날짜 한 칸. **직접 입력과 달력 선택을 같이 쓴다** — 칸은 언제나 편집 가능한 텍스트
 * 입력이고, 포커스가 들어오면 그 아래로 달력이 열린다.
 *
 * ★ 왜 `<input type="date">` 가 아닌가
 *   브라우저마다 표시 형식이 다르고(미국식 MM/DD/YYYY 가 그대로 나온다) placeholder 를
 *   못 준다. 이 화면은 `YYYY-MM-DD` 한 형식만 받고 그 형식을 칸에 그대로 보여 줘야 한다.
 *
 * ★ 날짜 계산은 전부 **UTC 자정**으로 한다
 *   `new Date(2026, 8, 1)` 처럼 로컬 생성자를 쓰면 실행 환경의 시간대에 따라 하루가 밀린다.
 *   화면에 쓰는 '오늘' 만 KST 로 구한다(`kstDateString`) — 사이트의 모든 날짜가 한국 날짜다.
 */

import { useEffect, useRef, useState } from "react";
import { kstDateString } from "@soop-lol/core/lib/contract";

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

/** `YYYY-MM-DD` → UTC 자정 Date. 형식이나 실재하지 않는 날짜(2026-02-31)면 null. */
function parseDay(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
}

const dayString = (date: Date) => date.toISOString().slice(0, 10);

/** `YYYY-MM` 을 months 만큼 옮긴다. 12 월 넘김은 Date.UTC 가 알아서 한다. */
function shiftMonth(view: string, months: number): string {
  const [year, month] = view.split("-").map(Number);
  const moved = new Date(Date.UTC(year, month - 1 + months, 1));
  return dayString(moved).slice(0, 7);
}

export function DateField({ label, value, onChange, min, max, presets, onPreset }: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  /** 이 날짜보다 이른 날은 고를 수 없다. 종료일 칸에 시작일을 준다. */
  min?: string;
  max?: string;
  /**
   * 달력 아래에 붙는 기간 단추. **범위 양쪽을 한 번에** 정하므로 이 칸이 아니라
   * 부모가 처리한다(`onPreset`) — 시작일·종료일 두 칸을 같이 채워야 하기 때문이다.
   */
  presets?: readonly { key: string; label: string }[];
  onPreset?: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // `YYYY-MM`. 달력이 열릴 때 정한다 — 렌더 중에 오늘을 읽으면 서버·클라이언트가 어긋난다.
  const [view, setView] = useState("");
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const today = kstDateString(new Date());
  function openCalendar() {
    setView((parseDay(value) ? value : today).slice(0, 7));
    setOpen(true);
  }
  function pick(day: string) {
    onChange(day);
    setOpen(false);
  }

  const [year, month] = view ? view.split("-").map(Number) : [0, 0];
  // 1 일이 무슨 요일인지만큼 앞을 비우고, 그 달의 날짜를 채운다. Date.UTC(y, m, 0) 은 말일이다.
  const lead = view ? new Date(Date.UTC(year, month - 1, 1)).getUTCDay() : 0;
  const days = view ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 0;

  return (
    <div className="date-field" ref={wrap}>
      <label>
        <span className="sr-only">{label}</span>
        <input type="text" inputMode="numeric" placeholder="YYYY-MM-DD" title={label} maxLength={10}
          value={value} autoComplete="off" aria-haspopup="dialog" aria-expanded={open}
          onChange={(event) => onChange(event.currentTarget.value)}
          onFocus={openCalendar} onClick={openCalendar} />
      </label>
      {open && view && (
        <div className="date-picker" role="dialog" aria-label={`${label} 선택`}>
          <div className="date-picker-head">
            <button type="button" aria-label="이전 달" onClick={() => setView(shiftMonth(view, -1))}>←</button>
            <strong>{year}년 {month}월</strong>
            <button type="button" aria-label="다음 달" onClick={() => setView(shiftMonth(view, 1))}>→</button>
          </div>
          <div className="date-picker-grid">
            {WEEKDAYS.map((weekday) => <span key={weekday} className="date-picker-weekday">{weekday}</span>)}
            {Array.from({ length: lead }, (_, index) => <span key={`lead${index}`} />)}
            {Array.from({ length: days }, (_, index) => {
              const day = dayString(new Date(Date.UTC(year, month - 1, index + 1)));
              const blocked = (min != null && day < min) || (max != null && day > max);
              return (
                <button key={day} type="button" disabled={blocked}
                  aria-pressed={day === value} data-today={day === today || undefined}
                  onClick={() => pick(day)}>{index + 1}</button>
              );
            })}
          </div>
          {presets && onPreset && (
            <div className="date-picker-presets">
              {presets.map((preset) => (
                <button key={preset.key} type="button" title={`오늘 기준 ${preset.label}`}
                  onClick={() => { onPreset(preset.key); setOpen(false); }}>
                  {preset.label.replace("최근 ", "")}
                </button>
              ))}
            </div>
          )}
          <div className="date-picker-foot">
            <button type="button" onClick={() => pick(today)}>오늘</button>
            <button type="button" onClick={() => pick("")}>지우기</button>
          </div>
        </div>
      )}
    </div>
  );
}
