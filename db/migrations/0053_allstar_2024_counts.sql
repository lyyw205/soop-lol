-- 2024 올스타전은 우승 집계에 넣는다(사용자 결정 2026-10-01). 0052 가 올스타전 전부를 뺐는데,
-- 2024 올스타전은 4팀 토너먼트로 치른 정규 대회 성격이라 일반 멸망전과 같이 센다(나무위키 개인별 우승 표도 같은 기준).
-- 2014~2019 올스타전·2020 프릭스 이벤트 매치는 그대로 뺀다.
UPDATE event SET counts_toward_titles = true WHERE game_code = 'lol' AND slug = 'meljang-2024-allstar';
