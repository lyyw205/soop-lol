-- classifySource(응답 기반 내전 판정)가 생기기 **전에** 적재된 매치를 재분류한다.
--
-- 왜: 예전 saveMatch 는 기본값 'public_queue' 로 저장했다. 그래서 queue 3130
-- (토너먼트 코드 내전)이 공개 큐로 들어간 행이 있을 수 있다 — §11-7(공개 큐와
-- 내전을 절대 섞지 않는다) 위반 상태다.
--
-- 더 나쁜 건 **왕복**이었다: saveMatch 가 같은 매치를 다시 만나면 encounter 는
-- 새 판정('tournament_code')으로 다시 쓰는데 match 는 ON CONFLICT DO NOTHING 이라
-- 옛 값으로 남고, rederiveEncounters 는 DB 의 옛 값을 읽어 도로 덮는다 —
-- 같은 경기의 source 가 실행 경로에 따라 오갔다(감사 후 적대 리뷰에서 발견).
--
-- 판정 입력(queueId·tournamentCode)은 Riot 응답의 불변 필드라, 과거 행만 바로잡으면
-- 이후로는 어긋날 길이 없다. 그래서 코드 수정이 아니라 데이터 교정 한 번이 맞다.

UPDATE match
   SET source = 'tournament_code'
 WHERE source = 'public_queue'
   AND (queue_id = 3130 OR tournament_code IS NOT NULL);

-- 파생 테이블도 같은 기준으로. (지우고 다시 만들어도 되지만 — §11-5 — 이 편이 싸다)
UPDATE streamer_encounter e
   SET source = 'tournament_code'
  FROM match m
 WHERE m.match_id = e.match_id
   AND m.source = 'tournament_code'
   AND e.source = 'public_queue';
