/**
 * "확인 전" 표시 — 회원 제보가 바꾸고 운영자가 아직 확인하지 않은 판(0093). 세트·시리즈 줄이 같은 하나를 쓴다.
 * 점수에서 빼는 일은 여기서 하지 않는다 — core 의 tally·counted 가 이미 뺐다(표시만 하는 공용 UI).
 */
export function PendingBadge() {
  return <span className="pending-badge" title="회원 제보로 바뀐 값입니다. 운영자가 확인하기 전이라 전적 합계에는 아직 들어가지 않습니다.">확인 전</span>;
}
