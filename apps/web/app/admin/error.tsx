"use client";
import Link from "next/link";
export default function AdminError({ reset }: { error: Error; reset: () => void }) {
  return <section className="admin-empty" role="alert"><h2>화면을 불러오지 못했습니다.</h2>
    <p>다시 시도하거나 검수 대기로 돌아가세요. 저장 결과가 불명확하면 최신 상태를 먼저 확인하세요.</p>
    <button type="button" onClick={reset}>다시 불러오기</button><Link href="/admin">검수 대기</Link>
  </section>;
}
