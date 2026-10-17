import Link from "next/link";
import {
  MODERATION_HOLD_DAYS, PERMANENT_SANCTION_HOLD_DAYS, PURGE_AFTER_DAYS, REJOIN_COOLDOWN_DAYS, SNAPSHOT_KEEP_DAYS,
} from "@soop-lol/core/lib/metrics/community";

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
      <li>쓴 글·첨부파일·댓글·추천·신고, 글쓰기 제한 기록, 비공개 건의·문의 내용과 답변</li>
    </ul>
    <p>이메일·실명·전화번호·프로필 사진은 받지 않습니다.</p>
    <p>회원이 아니어도, 자동 수집·과도한 요청이 의심되는 접속은 접속 기록(IP 주소, 브라우저 정보, 요청한 주소와 시각)을 남깁니다. 확인 단계를 통과한 브라우저에는 무작위 값의 확인 쿠키를 둡니다(7일).</p>
    <h2>2. 쓰는 곳</h2>
    <p>회원 확인, 게시물 작성과 관리, 문의 응대와 부정 이용 방지에만 씁니다. 접속 기록은 자동 수집 차단과 약관 위반 대응(법적 조치 포함)에만 씁니다.</p>
    <h2>3. 보관 기간</h2>
    <ul>
      <li>탈퇴하면 닉네임과 로그인 유지 정보, 비공개 건의·문의 내용과 답변을 바로 지웁니다. 건의·문의는 회원 유지 중에는 답변 확인을 위해 보관합니다.</li>
      <li>로그인 제공자 식별값은 재가입 제한 기간이 끝나면 지웁니다 — 탈퇴 뒤 {REJOIN_COOLDOWN_DAYS}일, 글쓰기 제한 중이었다면 제한이 끝날 때까지, 영구 제한은 제한 뒤 {PERMANENT_SANCTION_HOLD_DAYS}일.</li>
      <li>삭제한 글·댓글은 {PURGE_AFTER_DAYS}일 뒤 파기합니다. 신고를 처리하는 중이면 처리가 끝나고 {MODERATION_HOLD_DAYS}일 뒤에 파기합니다.</li>
      <li>신고된 글·댓글의 신고 당시 내용은 신고를 처리하고 {SNAPSHOT_KEEP_DAYS}일 뒤 지웁니다.</li>
      <li>게시하지 않은 첨부파일은 24시간 뒤, 편집으로 제거한 첨부파일은 30일 뒤 정기 정리합니다. 삭제한 글의 첨부파일은 본문과 함께 파기하며 신고 증거는 신고 보관 기간 동안 보존합니다.</li>
      <li>접속 기록은 1년 뒤 지웁니다. 약관 위반으로 분쟁이 진행 중이면 끝날 때까지 보관합니다. [확인 필요: 보관 기간]</li>
    </ul>
    <h2>4. 처리 위탁</h2>
    <p>데이터베이스 호스팅 — Supabase(서울 리전). [확인 필요: 위탁 고지 문구]</p>
    <p>첨부파일 저장 — Cloudflare R2. 첨부한 이미지·영상 원본과 파일명을 저장합니다.</p>
    <h2>5. 문의</h2>
    <p><Link href="/support">건의·문의</Link>에서 접수하고 답변을 확인할 수 있습니다.</p>
  </LegalPage>;
}
