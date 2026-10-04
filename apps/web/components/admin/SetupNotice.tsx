import Link from "next/link";
/** Distinguish connection/configuration failures without showing database credentials or traces. */
export function SetupNotice({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
  const missing = message.includes("DATABASE_URL");
  const schema = /does not exist|42P01|42703/.test(message);
  return <div className="rounded-xl border border-amber-400/30 bg-amber-400/5 p-6">
    <h2 className="text-sm font-semibold text-amber-300">관리자 데이터를 불러오지 못했습니다</h2>
    <p className="mt-2 text-sm text-ink-300">{missing ? "데이터베이스 연결 설정이 없습니다." : schema ? "필요한 데이터 구조가 아직 적용되지 않았습니다." : "데이터베이스 연결이나 조회에 실패했습니다. 잠시 후 다시 시도해 주세요."}</p>
    {(missing || schema) && <details className="mt-3 text-xs text-ink-400"><summary>설정 확인</summary><p className="mt-2">{missing ? "서버의 DATABASE_URL 설정을 확인해 주세요." : "db/migrations의 적용 상태와 서버 로그를 확인해 주세요."}</p></details>}
    <Link href="/admin" className="mt-3 inline-block text-xs text-accent-400">검수 대기로 돌아가기</Link>
  </div>;
}
