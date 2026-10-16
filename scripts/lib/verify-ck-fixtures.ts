/**
 * 롤 내전 검사들이 같이 쓰는 행사 준비 — 판은 행사 없이 저장되지 않는다(0089).
 * ★ 행사는 분류 쓰기 단일 출처(classification.ensureEventInTx)로만 만든다. 검사가 SQL 로 직접 넣으면
 *   운영 경로가 거치는 게임 대조·진행 방식 어휘 검사를 검사 자신이 건너뛴다.
 */
import { db } from "../../packages/core/lib/db/client.ts";
import { ensureEventInTx } from "../../packages/core/lib/db/classification.ts";
import type { Format } from "../../packages/core/lib/metrics/format.ts";

/** 롤 행사를 찾거나 만든다. 형식을 정하지 않은 검사는 미분류(VOD 자동 조사가 대부분 이렇게 들어온다). */
export function lolEvent(slug = "verify-ck", format: Format = "unclassified", name = slug): Promise<string> {
  return db().begin((tx) => ensureEventInTx(tx, { game_code: "lol", slug, name, format })) as Promise<string>;
}
