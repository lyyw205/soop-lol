SOOP 공지 → 편성표 검토 후보

역할
- 자동 스크립트가 수집/변경 감지/재시도/상태 저장을 맡는다. 별도 스킬 호출은 필요 없다.
- analysis.txt는 Claude Code가 읽는 분석 지침이다. 명령 실행이나 DB 쓰기 권한은 주지 않는다.
- LLM API 키 없이 현재 claude.ai 구독 로그인으로 claude -p를 실행한다.
- 첫 단계는 검토 후보 저장까지다. 공개 편성표 추가·수정·취소, 관리자 UI 연동은 하지 않는다.
  기존 편성표는 DB에서 읽어 중복 연결 후보를 찾는다. relatedScheduleIds도 최종 확정이 아니다.
  나중에 반영기를 붙일 때 기존 saveScheduleEntry의 전체 교체/버전 검증 계약을 지켜야 한다.

운영 명령 (저장소 루트)
  scripts/schedule-notices/run.sh init
  scripts/schedule-notices/run.sh poll
  scripts/schedule-notices/run.sh analyze
  scripts/schedule-notices/run.sh status
  scripts/schedule-notices/run.sh review
  scripts/schedule-notices/run.sh retry <channel-postId>
  scripts/schedule-notices/install.sh enable
  scripts/schedule-notices/install.sh disable
  scripts/schedule-notices/install.sh status
  journalctl --user -u soop-schedule-poll -u soop-schedule-analyze

초기 설정
out/schedule-notices/config.json: 검증한 4개 방송국의 공지 게시판으로 시작한다.
방송국 추가는 id/name/bbsNo를 함께 넣는다. 다른 사람이 작성한 팬 글은 수집하지 않는다.
init 재실행은 기존 설정을 덮어쓰지 않는다. SCHEDULE_NOTICES_DIR로 별도 상태 폴더를 지정할 수 있다.
poll: 완료 후 30분 + 최대 2분 분산. analyze: 완료 후 10분, 한 번에 최대 5건.
CLI 무작업 실행/구독 조회는 대기 글이 있을 때만 한다. PC/WSL이 꺼져 있으면 실행되지 않는다.
새 환경은 node, flock, claude 구독 로그인, apps/web/.env.local의 DATABASE_URL이 필요하다.
단위 파일의 저장소 경로는 %h/repos/soop-lol이다. 다른 위치에 설치하면 유닛 경로를 고친다.

수집과 제한
- 최근 7일 + 고정 공지의 전체 본문/제목/첨부 URL 해시를 비교한다.
  SOOP가 날짜 필터를 무시하는 실응답을 확인해, 응답 날짜를 코드에서도 검사한다. 조회수·댓글수는 무시한다.
- 게시판은 고정글 noticeData와 일반 contents를 모두 읽는다. 제목 키워드로 먼저 버리지 않는다.
- 목록이 전체 본문을 제공하지 않을 때만 글 상세를 추가 요청한다.
- 한 채널 최대 4페이지, 한 회차 최대 12요청. 못 읽은 페이지는 resumePage로 이어간다.
- 성공적으로 분석한 미래 일정의 오래된 원문도 채널당 최대 2개씩 순환 재확인한다.
- 원문이 이미지 URL을 그대로 두고 이미지 바이트만 교체하는 경우는 현재 감지하지 못한다.
- 삭제/권한 변경은 실패로 남긴다. 삭제됐다는 이유로 일정 취소를 추정하지 않는다.
- 게시판(api-channel)은 soop-http의 모든 프로세스가 flock과 시각 파일을 공유한다.
  요청 시작 최소 20초, SOOP_PACE가 더 길게 지정하면 그 간격. 429/515는 최소 1시간 물러난다.
  별도 머신/브라우저/이 관문을 통하지 않는 요청까지 통제하지는 못한다.
- 상태 변경/분석은 한 프로세스만 수행한다. 분석 중 poll은 최대 120초 잠금을 기다린 후 실패할 수 있고 다음 타이머에서 재시도한다.

분석
- 임시 독립 폴더에 이미지 복사. safe-mode/restricted + Read만 제공, MCP/skills 비활성화.
- 앱 환경변수/API 키를 자식 CLI에 전달하지 않는다. claude.ai 로그인만 허용한다.
- 글당 본문 2만 자/한 분석 묶음의 이미지 8장/이미지당 10MiB 제한. 초과하면 잘라서 분석하지 않고 오류로 남긴다.
- '오늘/내일'은 원문 시간대가 검증되지 않은 동안 절대 날짜 확정 금지.
- 본문 정정은 포스터보다 우선. 추정/모집/종목 미정은 검토 대상으로 남긴다.
- 기존 일정은 최근 7일~향후 60일, 최대 200개. DB 조회 실패/상한 초과면 분석을 중단한다.
- 최근 후보는 최대 30개를 문맥으로 전달한다. 후보끼리 자동 병합하거나 공개하지 않는다.
- JSON 형식, 글별 결과 누락/중복, revision, 달력 날짜, KST 시각, 존재하는 일정 ID를 코드에서 검증한다.
- 실패한 글은 1/2/4/8시간 후 재시도. 5회 실패하면 failed로 남겨 무한 구독 소모를 막는다.
  retry 명령으로 재개한다. 새 revision이 오면 자동으로 다시 pending이 된다.

저장 위치 (gitignore의 out/ 아래, 운영 DB 마이그레이션 없음)
config.json: 대상·주기·상한
state.json: 원문별 최신 revision·큐·실패 원인·페이지 이어읽기
posts/<revision>.json: 원문 스냅샷
assets/: 첨부 이미지 캐시
results/<revision>.json: 검증된 후보. publication=review-only
last-cli.json: 최근 CLI 원응답과 사용량. 후보 결과는 revision별로 보존한다.
오래된 스냅샷/이미지 자동 정리는 아직 없으므로 저장량을 관리한다.

검증
node --test scripts/schedule-notices/schedule-notices.test.ts
실제 김민교/스맵 공지와 포스터로 구독 CLI JSON 반환/정정 해석을 검증했다.
참고: https://code.claude.com/docs/en/headless
