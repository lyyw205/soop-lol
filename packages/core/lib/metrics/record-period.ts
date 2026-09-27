import { kstDateString } from "../time.ts";

export const RECORD_PERIODS = [
  { key: "all", label: "전체" }, { key: "6m", label: "최근 6개월" },
  { key: "3m", label: "최근 3개월" }, { key: "1m", label: "최근 1개월" },
  { key: "1w", label: "최근 1주" },
] as const;
export interface RecordPeriod { key: string; from?: string; to?: string; error?: string }

export function isRecordDate(value: string): boolean {
  if (!/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function resolveRecordPeriod(input: { period?: string; from?: string; to?: string; year?: number }, now = new Date()): RecordPeriod {
  if (input.period === "custom" || input.from || input.to) {
    const { from, to } = input;
    if (!from || !to || !isRecordDate(from) || !isRecordDate(to)) return {key:"custom",from,to,error:"시작일과 종료일을 YYYY-MM-DD 형식으로 입력해 주세요."};
    if (from > to) return {key:"custom",from,to,error:"종료일은 시작일보다 빠를 수 없습니다."};
    return {key:"custom",from,to};
  }
  if (input.period && input.period !== "all" && RECORD_PERIODS.some((p)=>p.key===input.period)) {
    const to = kstDateString(now);
    const start = new Date(`${to}T00:00:00Z`);
    if (input.period === "1w") start.setUTCDate(start.getUTCDate() - 6);
    else {
      const day = start.getUTCDate();
      start.setUTCDate(1);
      start.setUTCMonth(start.getUTCMonth() - Number(input.period.slice(0, -1)));
      const last = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
      start.setUTCDate(Math.min(day, last));
    }
    return {key:input.period,from:start.toISOString().slice(0,10),to};
  }
  if (input.period !== "all" && input.year) return {key:"year",from:`${input.year}-01-01`,to:`${input.year}-12-31`};
  return {key:"all"};
}

/**
 * 화면에 쓸 기간 문구. **한 곳에서만 만든다** — 페이지 머리글과 상대 전적 헤딩이
 * 각자 만들고 있었고, 둘 다 `key === "year"` 를 못 알아봐 연도 필터를
 * `2026-01-01 – 2026-12-31` 로 늘어놓았다.
 */
export function recordPeriodLabel(period: RecordPeriod): string {
  if (period.error) return "기간 확인 필요";
  if (period.key === "all") return "모든 기간";
  if (period.key === "year" && period.from) return `${period.from.slice(0, 4)}년`;
  const preset = RECORD_PERIODS.find((p) => p.key === period.key);
  return preset?.label ?? `${period.from} – ${period.to}`;
}

/** Inclusive calendar dates in Korea; called after grouping a complete series. */
export function withinRecordPeriod(at: Date | string, period: RecordPeriod): boolean {
  if (period.error) return false;
  const day = kstDateString(new Date(at));
  return (!period.from || day >= period.from) && (!period.to || day <= period.to);
}
