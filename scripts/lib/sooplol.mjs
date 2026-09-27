/**
 * sooplol.com 대회 로스터 스냅샷(`out/sooplol/teams.ndjson`) 읽기 — 단일 출처.
 *
 * 2026-08-19 운영자 승인 하에 **1회만** 받은 초기 시드 데이터다(경위는
 * `out/sooplol/README.md`). 다시 받지 않는다(CLAUDE.md 원칙 9).
 * 팀마다 포지션별 **SOOP 방송국 아이디**가 적혀 있어, 닉네임 검색보다 단단한 근거다.
 */

import { readFileSync } from "node:fs";

export const SOOPLOL_TEAMS = "out/sooplol/teams.ndjson";

/**
 * sooplol 대회 아이디 → 우리 event slug.
 *
 * ★ 2019 S3 · 2020 S1 · 2020 S2 는 저쪽이 **천상계/지상계로 쪼개** 두 대회로
 *   갖고 있는데 우리는 한 회차로 본다. 그래서 두 아이디가 한 slug 로 온다.
 * ★ 34(2024 앙코르전)는 **우리 시드에 없다.** 여기 넣지 않는다 — 없는 대회의
 *   로스터를 채울 수는 없다. 회차 자체를 추가하는 건 별개의 일이다.
 */
export const SOOPLOL_EVENT = {
  1: "meljang-2014-s1", 2: "meljang-2015-s1", 3: "meljang-2017-s1",
  4: "meljang-2018-s1", 5: "meljang-2018-s2", 6: "meljang-2018-s3",
  7: "meljang-2019-s1", 10: "meljang-2019-s2",
  38: "meljang-2019-s3", 68: "meljang-2019-s3",   // 천상계 · 지상계
  39: "meljang-2020-s1", 71: "meljang-2020-s1",   // 천상계 · 지상계
  40: "meljang-2020-s2", 74: "meljang-2020-s2",   // 천상계 · 지상계
  17: "meljang-2020-s3", 19: "meljang-2020-encore",
  20: "meljang-2021-s1", 22: "meljang-2021-s2", 23: "meljang-2021-encore",
  25: "meljang-2022-s1", 26: "meljang-2022-s2",
  28: "meljang-2023-s1", 29: "meljang-2023-s2",
  32: "meljang-2024-s1",
  35: "meljang-2025-s1", 36: "meljang-2025-s2",
  110: "meljang-2026-s1", 115: "meljang-2026-geng",
};

/** 저쪽 컬럼 순서 = 우리 포지션 순서. 이 대응은 대회 페이지의 표기 그대로다. */
export const SOOPLOL_SLOTS = [
  ["topId", "topName", "TOP"],
  ["jugId", "jugName", "JUNGLE"],
  ["midId", "midName", "MIDDLE"],
  ["adId", "adName", "BOTTOM"],
  ["supId", "supName", "UTILITY"],
];

/** 팀명 비교는 공백·대소문자만 무시한다. 그 이상 뭉개면 다른 팀이 붙는다. */
export const normTeam = (s) => String(s ?? "").replace(/\s+/gu, "").toLowerCase();

/** event slug → 팀명(정규화) → 저쪽 팀 레코드. 파일이 없으면 null. */
export function loadSooplolTeams() {
  let raw;
  try {
    raw = readFileSync(SOOPLOL_TEAMS, "utf8");
  } catch {
    return null;
  }
  const bySlug = new Map();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const t = JSON.parse(line);
    // 저쪽 아이디에 뒤 공백이 섞여 있다('codmsznls ') — 그대로 쓰면 slug·채널이 깨진다.
    // 한글 자판으로 친 채 깨진 아이디도 있다('형진잉' = gudwlsdld) — SOOP 아이디 모양이 아니면 버린다.
    for (const [idKey] of SOOPLOL_SLOTS) {
      if (typeof t[idKey] !== "string") continue;
      const id = t[idKey].trim();
      t[idKey] = /^[A-Za-z0-9_]+$/.test(id) ? id : null;
    }
    const slug = SOOPLOL_EVENT[t.tournamentId];
    if (!slug) continue;
    if (!bySlug.has(slug)) bySlug.set(slug, new Map());
    bySlug.get(slug).set(normTeam(t.teamName), t);
  }
  return bySlug;
}
