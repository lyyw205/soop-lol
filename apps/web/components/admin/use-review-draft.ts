"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type SetStateAction } from "react";

/** Keep both the draft and the exact values it was based on. A refresh must not silently rebase an edit. */
export function useReviewDraft<T>(key: string, initial: T) {
  const storageKey = `admin-draft:v1:${key}`;
  const [record, setRecord] = useState({ base: initial, value: initial });
  const [ready, setReady] = useState(false);
  const latest = useRef(initial); latest.current = initial;
  const signature = JSON.stringify(initial);
  const dirty = JSON.stringify(record.value) !== JSON.stringify(record.base);
  useLayoutEffect(() => {
    try {
      const stored = sessionStorage.getItem(storageKey);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed && "base" in parsed && "value" in parsed) setRecord(parsed);
      }
    } catch { /* Storage may be unavailable; in-memory edits still work. */ }
    setReady(true);
  }, [storageKey]);
  useEffect(() => {
    setRecord(old => JSON.stringify(old.value) === JSON.stringify(old.base)
      ? { base: latest.current, value: latest.current } : old);
  }, [signature]);
  useEffect(() => {
    if (!ready) return;
    try {
      if (dirty) sessionStorage.setItem(storageKey, JSON.stringify(record));
      else sessionStorage.removeItem(storageKey);
    } catch { /* Do not block editing when storage is full. */ }
  }, [storageKey, record, ready, dirty]);
  useEffect(() => {
    if (!dirty) return;
    const onLeave = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [dirty]);
  const setValue = useCallback((next: SetStateAction<T>) => setRecord(old => ({ ...old,
    value: typeof next === "function" ? (next as (value: T) => T)(old.value) : next,
  })), []);
  const reset = useCallback((next?: T) => {
    const value = next ?? latest.current;
    try { sessionStorage.removeItem(storageKey); } catch { /* optional storage */ }
    setRecord({ base: value, value });
  }, [storageKey]);
  return { base: record.base, draft: record.value, setDraft: setValue, reset, dirty,
    stale: dirty && JSON.stringify(record.base) !== signature };
}
