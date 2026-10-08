import { LegalPage } from "@/components/legal";

export const metadata = { title: "운영정책" };

export default function PolicyPage() {
  return <LegalPage title="운영정책">
    <h2>1. 쓰지 않는 것</h2>
    <ul>
      <li>스트리머를 포함한 특정인에 대한 욕설·비하·허위사실·사생활 노출</li>
      <li>남의 개인정보(연락처·주소·본명 등) 노출</li>
      <li>광고·도배, 법을 어기는 내용</li>
    </ul>
    <h2>2. 신고와 처리</h2>
    <ul>
      <li>신고는 운영자가 직접 확인합니다. 신고 수만으로 글이 자동으로 내려가지 않습니다.</li>
      <li>개인정보 노출·명예훼손 신고를 먼저 봅니다.</li>
      <li>처리는 유지·숨김·임시조치·삭제 중 하나이며, 필요하면 작성자의 글쓰기를 1일·7일·30일·영구로 제한합니다.</li>
      <li>권리침해를 주장하는 신고가 들어오면 확인하는 동안 글을 임시로 내릴 수 있습니다.</li>
    </ul>
    <h2>3. 당사자 요청</h2>
    <p>스트리머 본인이 자신에 관한 글을 내려 달라고 요청하면 바로 처리합니다.</p>
  </LegalPage>;
}
