/**
 * 결과창에서 읽은 화면 이름 → 사람(스트리머). **정확히 한 사람으로 확정될 때만** 돌려준다.
 *
 * ★ 왜 저장 단계에서 하나 (2026-10-12)
 *   이름을 사람에 붙이는 일은 조사 세션이 `ck:who` 로 대조해 `streamer_slug` 를 내는 데 달려 있었다.
 *   10/10 성훈 협곡랜드·증강칼바람 18판은 세션이 대조를 건너뛰어 10명 중 성훈 1명만 붙었다 —
 *   단단묵직(수주-)·굴 하나 먹자(엊우진)·쑤셔쑤셔(하이브리드99)처럼 이미 등록·연결된 이름인데도.
 *   결과가 세션의 성실함에 달리지 않게, 확정되는 이름은 저장할 때 붙인다(ck-merge · ck:link-known).
 *
 * 근거는 셋 — `ck:who` 의 출처 중 틀릴 위험이 낮은 것만 쓴다(표시명·별명·시드는 쓰지 않는다):
 *   · 이미 사람이 붙은 자리(같은 화면 이름) — 사람·조사가 확인한 연결이다. `ck:name` 이 남긴 연결도 여기다.
 *   · 라이엇 계정의 지금 인게임 이름과 옛 이름(0083) — 계정 주인이 있는 것.
 * 판정:
 *   · 근거들이 가리키는 사람이 **둘 이상이면** 붙이지 않는다(그 자체가 확인할 거리다).
 *   · 근거가 계정뿐이면, 같은 인게임 이름의 **주인 없는 계정**이 DB 에 있을 때 붙이지 않는다 —
 *     결과창엔 태그가 없어 남일 수 있다('상 어#3 5' 처럼 태그만 다른 계정, 2026-10-09).
 *     같은 이름으로 이미 붙은 자리가 있으면 그 연결을 믿는다.
 * 이름 비교는 `ck:who`·`ck:name` 과 같은 정규화(공백·구두점 무시, NFKC, 소문자)다. 오독(편집거리)은 보지 않는다 —
 * 잘못 읽은 이름은 세션이 `ck:who` 로 확인하거나 사람이 미확인 목록에서 붙인다.
 */
import type postgres from "postgres";

type Tx = postgres.TransactionSql | postgres.Sql;

export const normName = (s: string | null | undefined): string =>
  String(s ?? "").normalize("NFKC").replace(/[\s\-_.]+/gu, "").toLowerCase();

/** 정규화한 이름 → 확정된 사람 id. 요청한 이름만 담는다. */
export async function knownNameOwnersInTx(tx: Tx, names: Iterable<string>): Promise<Map<string, string>> {
  const want = new Set([...names].map(normName).filter(Boolean));
  const out = new Map<string, string>();
  if (want.size === 0) return out;
  const seats = new Map<string, Set<string>>();       // 이름 → 이미 붙은 사람
  const owned = new Map<string, Set<string>>();       // 이름 → 계정 주인
  const unowned = new Map<string, number>();          // 이름 → 주인 없는 계정 수
  const add = (m: Map<string, Set<string>>, k: string, v: string) => { if (!m.has(k)) m.set(k, new Set()); m.get(k)!.add(v); };

  for (const r of await tx<{ name: string; sid: string }[]>`
    SELECT DISTINCT observed_name AS name, streamer_id::text AS sid FROM match_participant
     WHERE observed_name IS NOT NULL AND streamer_id IS NOT NULL`) {
    const k = normName(r.name); if (want.has(k)) add(seats, k, r.sid);
  }
  for (const r of await tx<{ name: string; sid: string | null }[]>`
    SELECT ra.game_name AS name, sa.streamer_id::text AS sid FROM riot_account ra
      LEFT JOIN streamer_account sa ON sa.puuid = ra.puuid AND sa.active_to IS NULL
     WHERE ra.game_name IS NOT NULL
    UNION ALL
    SELECT n.game_name, sa.streamer_id::text FROM riot_account_name n
      LEFT JOIN streamer_account sa ON sa.puuid = n.puuid AND sa.active_to IS NULL
     WHERE n.game_name IS NOT NULL`) {
    const k = normName(r.name); if (!want.has(k)) continue;
    if (r.sid) add(owned, k, r.sid); else unowned.set(k, (unowned.get(k) ?? 0) + 1);
  }
  for (const k of want) {
    const people = new Set([...(seats.get(k) ?? []), ...(owned.get(k) ?? [])]);
    if (people.size !== 1) continue;
    const [sid] = people;
    if (!seats.get(k)?.has(sid) && (unowned.get(k) ?? 0) > 0) continue;
    out.set(k, sid);
  }
  return out;
}
