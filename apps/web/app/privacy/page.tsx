import { PERMANENT_SANCTION_HOLD_DAYS, REJOIN_COOLDOWN_DAYS } from "@soop-lol/core/lib/metrics/community";

import { LegalPage } from "@/components/legal";

export const metadata = { title: "개인정보처리방침" };

/** ★ 항목·기간은 실제 저장과 같아야 한다(docs/COMMUNITY-PLAN.md §9). 저장 규칙을 바꾸면 여기도 바꾼다. */
export default function PrivacyPage() {
  return <LegalPage title="개인정보처리방침">
    <h2>1. 받는 것</h2>
    <ul>
      <li>로그인 제공자가 주는 고유 식별값(카카오 회원번호, 구글 계정 식별값)</li>
      <li>직접 정한 닉네임, 약관 동의 시각</li>
      <li>로그인 유지 정보(무작위 값의 해시와 만료 시각)</li>
      <li>쓴 글·댓글·추천·신고, 글쓰기 제한 기록</li>
    </ul>
    <p>이메일·실명·전화번호·프로필 사진은 받지 않습니다.</p>
    <h2>2. 쓰는 곳</h2>
    <p>회원 확인, 게시물 작성과 관리, 부정 이용 방지에만 씁니다.</p>
    <h2>3. 보관 기간</h2>
    <ul>
      <li>탈퇴하면 닉네임과 로그인 유지 정보를 바로 지웁니다.</li>
      <li>로그인 제공자 식별값은 재가입 제한 기간이 끝나면 지웁니다 — 탈퇴 뒤 {REJOIN_COOLDOWN_DAYS}일, 글쓰기 제한 중이었다면 제한이 끝날 때까지, 영구 제한은 제한 뒤 {PERMANENT_SANCTION_HOLD_DAYS}일.</li>
      <li>삭제한 글·댓글은 30일 뒤 파기합니다. 신고를 처리하는 중이면 처리가 끝나고 30일 뒤에 파기합니다.</li>
      <li>신고된 글·댓글의 신고 당시 내용은 신고를 처리하고 30일 뒤 지웁니다.</li>
    </ul>
    <h2>4. 처리 위탁</h2>
    <p>데이터베이스 호스팅 — Supabase(서울 리전). [확인 필요: 위탁 고지 문구]</p>
    <h2>5. 문의</h2>
    <p>[확인 필요: 연락처]</p>
  </LegalPage>;
}
