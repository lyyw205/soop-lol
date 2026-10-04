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
 * 첫 화면에 쓸 쌍 목록. **공개 원본을 그대로 읽는다.**
 *
 * ⚠⚠ 예전엔 `mod_versus.pair` 롤업을 먼저 읽었다. 그런데 그 표를 채우는 건 60분마다
 *   도는 잡뿐이고, **무엇도 무효화하지 않는다.** 그래서 경기를 공개에서 빼도 최대
 *   한 시간 동안 그 쌍이 계속 추천에 올랐다 — 카드가 사람 공개 여부와 승수를 다시
 *   조회하는 덕에 숫자는 살아 있었지만, 경기가 전부 빠진 쌍이 **`0 : 0` 카드**로 남고
 *   기본 선택(featured)도 그 쌍을 가리켰다. 숨김은 삭제 요청의 경로다 — 늦게 듣는
 *   자물쇠는 자물쇠가 아니다.
 *
 * ★ 지금 규모(스트리머 69명·조우 수백 행)에서 원본 조회는 롤업보다 싸다. 롤업은
 *   **커졌을 때를 위해 남겨 둔다**(`recompute` 는 계속 돈다) — 그때 다시 읽되,
 *   그때는 숨김에 대한 무효화를 같이 책임져야 한다. 지금 그걸 만들면 쓰지도 않는
 *   무효화 경로를 검증 없이 들고 있게 된다.
 * ★ 모듈은 코어를 계약으로만 읽는다 — `listPublicPairs` 가 `core_public` 뷰를 지나므로
 *   경기 숨김·사람 숨김이 **질의 시점에** 반영된다.
 */
export async function topPairs(limit = 20, laneOnly = false, streamerSlug?: string): Promise<PublicPair[]> {
  return listPublicPairs(limit, laneOnly, streamerSlug);
}
