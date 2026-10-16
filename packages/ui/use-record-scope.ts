"use client";
import { useSearchParams } from "next/navigation";
import { readRecordScope, writeRecordScope, type RecordScope } from "@soop-lol/core/lib/contract/client";

/** Next의 native history 통합으로 필터 변경은 서버 조회 없이 URL에 남긴다. */
export function useRecordScope() {
  const query = useSearchParams();
  const scope = readRecordScope(query);
  const setScope = (patch: Partial<RecordScope>) => {
    const current = new URLSearchParams(window.location.search);
    const next = writeRecordScope(current, { ...readRecordScope(current), ...patch });
    window.history.replaceState(null, "", `${window.location.pathname}${next.size ? `?${next}` : ""}${window.location.hash}`);
  };
  return { scope, setScope };
}
