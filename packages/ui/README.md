# Public record UI

`apps/web` 개인 기록과 `packages/modules/versus` 상대전적이 함께 사용하는 표시 계층이다. DB 조회나 특정 모듈 설치 여부의 판정은 이곳에 넣지 않는다.

| 공용 구성 | 책임 |
| --- | --- |
| `record-layout.tsx` | 화면 제목, 본문·우측 컬럼 배치 |
| `record-search.tsx` | 개인 기록/상대전적 검색과 대상 선택 |
| `record-filters.tsx` | 카테고리·연도 컨트롤과 링크형 어댑터 |
| `record-sidebar.tsx` | 프로필, 수상 경력, 모스트 챔피언 표시 |
| `record-profile-info.tsx` | 개인 프로필 카드와 상대전적 사이드바에서 공유하는 챔피언·수상 목록 |
| `avatar.tsx` | 프로필 이미지, 방송국 이미지 URL, 이미지 실패 대체 표시 |
| `match-details.tsx` | 세트 선택, 블루/레드 팀, 참가자·챔피언·포지션·KDA, 전적 이동 |
| `match-details-model.ts` | 공용 경기 상세 입력 형식, 포지션 순서, 세트별 팀 관계 링크, 미확인 KDA 표시 |

경기 상세는 `MatchDetailSet[]`와 기준 스트리머·조회 조건을 받는다. 참가자 타입은 코어의 `PublicRosterEntry` 계약을 그대로 쓴다. 세트를 바꿀 때는 해당 세트의 참가자만 사용하며, 이전 세트의 챔피언이나 블루/레드 진영을 재사용하지 않는다. 전적 링크의 모듈 경로는 호출자가 전달한다. 화면에 없는 정보는 새로 추론하거나 0으로 채우지 않는다.

개인 기록의 참여 경기 조회·페이지 이동, 상대전적의 두 사람 집계·전적 흐름·필터는 각 화면에 둔다. 접힌 행의 문구와 강조 대상도 화면의 관점에 따라 정하고, 펼친 경기 상세는 같은 컴포넌트로 위임한다. 개인 기록의 상대별 기간 합산 목록은 경기 한 건의 상세와 다른 데이터이므로 별도 `OpponentHistoryList`를 사용한다.

공개 화면 테마와 공용 컴포넌트 스타일은 현재 `apps/web/app/arena.css`에서 관리한다. 경기 상세 스타일은 `.match-details-*`로 구분한다. 관리 화면은 이번 공용화 범위에 포함하지 않는다.

개인 기록의 A형 통합 카드는 `PersonalRecordSummary`가 배치·전적 집계를, `PersonalProfileInfo`가 방송·계정·커리어 정보를 맡는다. `RecordLayout`의 사이드바는 선택 사항이며 개인 기록은 전체 폭을 쓴다. 카드 스타일은 `apps/web/components/personal-profile.css`에 둔다. 계정은 기존 `AccountList`와 `RankChip`, 프로필 이미지는 공용 `Avatar`를 사용한다. 방송 링크 문구는 플랫폼명 대신 스트리머의 공개 이름을 사용한다.

공용 동작을 바꿀 때 두 소비 화면과 모바일을 함께 확인한다. `match-details-model.test.ts`는 진영 변경에 따른 링크 관계, 포지션 정렬, 0과 미확인 KDA의 구분을 검증한다.
