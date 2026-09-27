-- 대회 상세도 공개 경기의 숨김·게임 분리 규칙을 그대로 따른다.
-- 기존 match 뷰의 열/소비자는 변경하지 않고, 라운드와 공개 출처만 보강한다.
CREATE VIEW core_public.tournament_match AS
  SELECT pm.*, ms.round_label, m.source_url
    FROM core_public.match pm
    JOIN match m ON m.match_id = pm.match_id
    LEFT JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code
   WHERE pm.event_id IS NOT NULL;

COMMENT ON VIEW core_public.tournament_match IS
  '공개 LoL 대회 경기. match의 숨김 필터를 계승하며 라운드와 공개 출처를 추가한다.';
