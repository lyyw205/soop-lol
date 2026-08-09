import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-20">
      <h1 className="text-3xl font-semibold text-ink-200">
        SOOP LOL <span className="text-accent-500">스트리머 전적</span>
      </h1>
      <p className="mt-4 leading-relaxed text-ink-400">
        개인 전적은 이미 여러 곳이 합니다. 여기는 <b className="text-ink-200">스트리머끼리 누가 누구를
        이겼나</b>를 봅니다 — 상대전적, 맞라인 전적, 상성.
      </p>

      <div className="mt-10 rounded-xl border border-ink-800 bg-ink-900/60 p-5 text-sm leading-relaxed text-ink-400">
        <p className="font-medium text-ink-200">아직 데이터를 모으는 중입니다.</p>
        <p className="mt-2">
          스트리머 명단과 계정 매핑을 채우고 나면 프로필과 상대전적 화면이 열립니다.
        </p>
        <Link href="/admin" className="mt-4 inline-block text-accent-500 hover:underline">
          관리자 화면 →
        </Link>
      </div>
    </main>
  );
}
