import Link from "next/link";
export default function AdminNotFound() {
  return <section className="admin-empty"><h2>대상을 찾을 수 없습니다.</h2><p>주소가 잘못되었거나 대상이 삭제·이동되었습니다.</p>
    <Link href="/admin">검수 대기로 돌아가기</Link></section>;
}
