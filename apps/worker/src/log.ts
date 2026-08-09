/**
 * 로그. 라이브러리를 붙이지 않는다 — 워커는 한 프로세스이고, 필요한 건
 * "언제 / 어떤 엔진이 / 무엇을 몇 건" 뿐이다.
 *
 * 시각은 KST 로 찍는다. 크론이 09:00 에 돌았는지를 로그만 보고 판단할 수 있어야 한다.
 */

import { KST_OFFSET_MS } from "@soop-lol/core/lib/time";

type Fields = Record<string, unknown>;

function stamp(): string {
  return new Date(Date.now() + KST_OFFSET_MS).toISOString().slice(11, 19);
}

function fmt(fields?: Fields): string {
  if (!fields) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    parts.push(`${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
  }
  return parts.length ? "  " + parts.join(" ") : "";
}

export const log = {
  info(scope: string, msg: string, fields?: Fields) {
    console.log(`${stamp()}  ${scope.padEnd(9)} ${msg}${fmt(fields)}`);
  },
  warn(scope: string, msg: string, fields?: Fields) {
    console.warn(`${stamp()}  ${scope.padEnd(9)} ⚠ ${msg}${fmt(fields)}`);
  },
  error(scope: string, msg: string, fields?: Fields) {
    console.error(`${stamp()}  ${scope.padEnd(9)} ✖ ${msg}${fmt(fields)}`);
  },
};

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
