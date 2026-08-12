/**
 * 상대전적 모듈 — 서버.
 *
 * 계약 안에서만 움직인다:
 *   · 코어는 `@soop-lol/core/lib/contract` 로만 읽는다
 *   · 쓰기는 mod_versus 스키마에만
 *   · 다른 모듈을 모른다
 *
 * ★ 조우를 다시 만들지 않는다
 *   `streamer_encounter` 는 코어가 수집·파생하는 **사실**이다. 이 모듈이 하는 건
 *   그 사실을 읽어 "맞대결이 몇 대 몇인가" 를 **해석**하는 것뿐이다.
 *   같은 것을 두 군데서 만들면 반드시 어긋난다.
 */

import {
  listPublicPairs, moduleDb, type PublicPair,
} from "@soop-lol/core/lib/contract";

const SCHEMA = "mod_versus";

/** 많이 붙은 쌍을 다시 접는다. 멱등이다. */
export async function recompute(limit = 200): Promise<number> {
  const sql = moduleDb(SCHEMA);
  const pairs = await listPublicPairs(limit);
  await sql.begin(async (tx) => {
    await tx`DELETE FROM mod_versus.pair`;
    for (const p of pairs) {
      await tx`
        INSERT INTO mod_versus.pair (a_slug, a_name, b_slug, b_name, sets, vs_sets, lane_sets, last_met)
        VALUES (${p.a_slug}, ${p.a_name}, ${p.b_slug}, ${p.b_name},
                ${p.sets}, ${p.vs_sets}, ${p.lane_sets}, ${p.last_met})
      `;
    }
  });
  return pairs.length;
}

/**
 * 첫 화면에 쓸 쌍 목록.
 * ★ 롤업이 아직 비어 있으면 **계약에서 직접 읽는다.** 모듈을 새로 꽂은 직후에
 *   빈 화면을 보여 주면 "고장 났나" 로 읽힌다 — 잡이 한 번 돌 때까지의 공백을 메운다.
 */
export async function topPairs(limit = 20): Promise<PublicPair[]> {
  const sql = moduleDb(SCHEMA);
  const rows = await sql<PublicPair[]>`
    SELECT a_slug, a_name, b_slug, b_name, sets, vs_sets, lane_sets, last_met
      FROM mod_versus.pair ORDER BY vs_sets DESC, sets DESC LIMIT ${limit}
  `;
  return rows.length > 0 ? rows : listPublicPairs(limit);
}
