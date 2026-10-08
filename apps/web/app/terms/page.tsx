import { REJOIN_COOLDOWN_DAYS } from "@soop-lol/core/lib/metrics/community";

import { LegalPage } from "@/components/legal";

export const metadata = { title: "이용약관" };

export default function TermsPage() {
  return <LegalPage title="이용약관">
    <h2>1. 목적</h2>
    <p>이 약관은 스트리머 기록실(이하 &lsquo;서비스&rsquo;)의 커뮤니티를 이용하는 조건을 정합니다. 기록 열람은 로그인 없이 할 수 있습니다.</p>
    <h2>2. 가입</h2>
    <ul>
      <li>카카오·구글 계정으로 로그인해 가입합니다. 만 14세 이상만 가입할 수 있습니다.</li>
      <li>가입할 때 닉네임을 정합니다. 등록된 스트리머 이름이나 운영진으로 오해될 수 있는 이름은 쓸 수 없습니다.</li>
    </ul>
    <h2>3. 게시물</h2>
    <ul>
      <li>게시물의 책임은 작성자에게 있습니다.</li>
      <li>운영정책을 어긴 게시물은 숨기거나 삭제할 수 있고, 작성자의 글쓰기를 제한할 수 있습니다.</li>
    </ul>
    <h2>4. 탈퇴</h2>
    <ul>
      <li>언제든 탈퇴할 수 있습니다. 쓴 글·댓글은 &lsquo;탈퇴한 회원&rsquo; 으로 남고, 탈퇴할 때 함께 지우기를 고를 수 있습니다.</li>
      <li>같은 소셜 계정으로는 탈퇴 뒤 {REJOIN_COOLDOWN_DAYS}일 동안(글쓰기 제한 중이었다면 제한이 끝날 때까지) 다시 가입할 수 없습니다.</li>
    </ul>
    <h2>5. 변경</h2>
    <p>서비스는 바뀌거나 중단될 수 있습니다. 약관을 바꾸면 시행 전에 알립니다.</p>
  </LegalPage>;
}
