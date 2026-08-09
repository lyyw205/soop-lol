/**
 * DB 가 아직 없을 때 흰 화면 대신 보여주는 안내.
 *
 * 스택 트레이스만 던지면 "뭘 해야 하는지"를 매번 문서에서 찾아야 한다.
 * 초기 셋업은 한 번뿐이지만 그 한 번이 제일 답답하다.
 */
export function SetupNotice({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
  const missingUrl = message.includes("DATABASE_URL");
  const missingTable =
    message.includes("does not exist") || message.includes("relation") || message.includes("42P01");

  return (
    <div className="rounded-xl border border-amber-400/30 bg-amber-400/5 p-6">
      <h2 className="text-sm font-semibold text-amber-300">아직 데이터베이스가 준비되지 않았습니다</h2>

      {missingUrl && (
        <ol className="mt-4 space-y-2 text-sm leading-relaxed text-ink-200">
          <li>1. Supabase 에서 프로젝트를 만듭니다.</li>
          <li>
            2. Project Settings → Database → Connection string 에서 <b>URI</b> 를 복사합니다.
          </li>
          <li>
            3. <code className="rounded bg-ink-800 px-1.5 py-0.5 text-xs">apps/web/.env.local</code> 에{" "}
            <code className="rounded bg-ink-800 px-1.5 py-0.5 text-xs">DATABASE_URL=…</code> 로 넣습니다.
          </li>
        </ol>
      )}

      {missingTable && (
        <ol className="mt-4 space-y-2 text-sm leading-relaxed text-ink-200">
          <li>테이블이 아직 없습니다. 스키마를 먼저 적용하세요.</li>
          <li>
            Supabase SQL Editor 에{" "}
            <code className="rounded bg-ink-800 px-1.5 py-0.5 text-xs">db/schema.sql</code> 내용을 붙여
            실행하면 됩니다.
          </li>
        </ol>
      )}

      <pre className="mt-4 overflow-x-auto rounded-lg bg-ink-950 p-3 text-[11px] leading-relaxed text-ink-400">
        {message}
      </pre>
    </div>
  );
}
