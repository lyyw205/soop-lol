/**
 * Postgres 연결. 웹(Next 서버)과 워커가 같은 모듈을 쓴다.
 *
 * ORM 을 두지 않는 이유: 이 서비스의 질의는 대부분 집계다
 * (상대전적 self-join, 티어 시계열, 챔피언 롤업). ORM 으로 표현하면
 * 생성되는 SQL 을 못 읽게 되고, 느려졌을 때 손댈 곳이 사라진다.
 */

import postgres from "postgres";

type Sql = ReturnType<typeof postgres>;

// next dev 의 핫리로드는 모듈을 다시 평가한다. 전역에 물려두지 않으면
// 저장할 때마다 커넥션 풀이 하나씩 새로 생겨 금방 max_connections 를 넘긴다.
const globalRef = globalThis as unknown as { __soopLolSql?: Sql };

export function db(): Sql {
  if (globalRef.__soopLolSql) return globalRef.__soopLolSql;

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL 이 없다. Supabase → Project Settings → Database → Connection string 을 .env.local 에 넣을 것.",
    );
  }

  const sql = postgres(url, {
    // ★ Supabase 트랜잭션 풀러(:6543)는 프리페어드 스테이트먼트를 지원하지 않는다.
    //   켜두면 "prepared statement already exists" 로 간헐적으로 터진다.
    //   세션 풀러(:5432)에서도 끄는 쪽이 안전해서 항상 false 로 둔다.
    prepare: false,
    // ★ **한 요청이 동시에 던지는 질의 수보다 커야 한다.** 5 였다가 실제로 물렸다:
    //   프로필의 상대전적 탭은 Promise.all 로 질의 12개를 한 번에 낸다. max=5 면
    //   11개는 끝나고 **남은 하나가 영영 안 끝난다** — 에러도 안 나고 응답이 그냥
    //   멈춘다(요청은 클라이언트가 끊을 때까지 매달려 있다). 실측:
    //     max=5 → 11/12 완료 후 무한 대기 · max=12 → 12/12 · max=25 → 12/12
    //   연결이 회수되긴 한다(5개로 11개를 처리했다). 그런데도 한 개가 큐에서
    //   빠져나오지 못한다. 그래서 "느려서" 가 아니라 **막혀서** 안 되는 문제다.
    //   → 화면 하나의 최대 동시 질의 수를 세어 그보다 넉넉하게 잡는다.
    //   ⚠ 근본 해결은 화면이 12개를 한꺼번에 던지지 않는 것이다. 풀만 키우면
    //     동시 요청이 늘 때 같은 방식으로 다시 막힌다.
    max: Number(process.env.DATABASE_POOL_MAX ?? 20),
    idle_timeout: 20,
    connect_timeout: 10,
    // NOTICE 를 서버 로그로 흘리지 않는다 (마이그레이션 때 시끄럽다)
    onnotice: () => {},
  });

  globalRef.__soopLolSql = sql;
  return sql;
}

/** 워커 종료 시 깨끗하게 닫는다. 웹에서는 부르지 않는다. */
export async function closeDb(): Promise<void> {
  if (globalRef.__soopLolSql) {
    await globalRef.__soopLolSql.end({ timeout: 5 });
    globalRef.__soopLolSql = undefined;
  }
}
