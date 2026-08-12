/**
 * 스크립트 공용 CLI 잡동사니.
 *
 * ★ 왜 있나 — 같은 한 줄짜리 인자 룩업이 7개 스크립트에 4가지 이름(opt/flag/arg/after)
 *   으로 복붙돼 있었고, KST '어제' 계산도 4곳에 인라인돼 있었다. 이름이 다르니
 *   grep 도 안 걸리고, 하나 고치면 나머지가 낡는다.
 *
 * ★ 여기 넣을 것과 안 넣을 것
 *   넣는다: 인자 파싱, KST 날짜 — 모든 스크립트가 똑같이 해야 맞는 것.
 *   안 넣는다: SOOP API 접근(soop-vod/soop-board/soop-fa), DB 접근(core) —
 *   저마다 단일 출처가 따로 있다.
 */

import { kstDateString } from "@soop-lol/core/lib/time";

/** `--name 값` 하나를 읽는다. 없으면 dflt. */
export const makeOpt = (argv) => (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};

/** `--name a b c` 처럼 다음 `--` 전까지 전부 읽는다 (다중 값 인자용). */
export const makeAfter = (argv) => (name) => {
  const i = argv.indexOf(name);
  if (i < 0) return [];
  const out = [];
  for (let j = i + 1; j < argv.length && !argv[j].startsWith("--"); j++) out.push(argv[j]);
  return out;
};

/**
 * KST 기준 'YYYY-MM-DD'. `kstDate(1)` = 어제.
 * 계산은 core/lib/time 의 kstDateString 하나만 믿는다 — +9시간 인라인 복붙 금지.
 */
export const kstDate = (daysAgo = 0) => kstDateString(new Date(Date.now() - daysAgo * 86_400_000));
