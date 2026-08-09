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
    max: Number(process.env.DATABASE_POOL_MAX ?? 5),
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
