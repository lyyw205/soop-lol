-- 대회 로스터의 **표시용 이름** — 스트리머로 연결되지 않은 자리의 출처 표기 이름.
--
-- ★ 왜 (2026-10-02): 멸망전 예선 팀 로스터의 상당수가 「미수집」으로 보였다. 나무위키 참가팀 표에는 이름이
--   있었지만, 시드 생성(build-meljang)은 SOOP 방송국 아이디로 이어지는 사람만 event_team_member 에 넣고
--   나머지 이름은 버렸다. 사람이 아니라 이름이라도 "누가 나왔는지"는 화면에 보여야 한다.
--
-- ★ 이건 스트리머가 아니다. 상대전적·조우·통계·프로필 어디에도 쓰지 않는다 — 같은 사람인지 모르는 이름을
--   사람으로 다루면 없는 전적이 생긴다(코딩 원칙 1·2). 화면은 「미연결」로 표시하고 프로필 링크를 걸지 않는다.
-- ★ 연결된 멤버가 있는 자리에는 두지 않는다(채우는 스크립트가 지킨다). 나중에 그 자리에 스트리머가 연결되면
--   화면은 멤버를 우선하고, 이 행은 정리 대상이다.
CREATE TABLE event_team_listed_name (
  event_team_id uuid NOT NULL,
  event_id      uuid NOT NULL,
  position      text NOT NULL CHECK (position IN ('TOP','JUNGLE','MIDDLE','BOTTOM','UTILITY')),
  name          text NOT NULL CHECK (btrim(name) <> ''),
  -- 근거(출처 문서 주소). 이름만 옮긴 수기 기록이라 출처가 없으면 남기지 않는다.
  source_url    text NOT NULL CHECK (source_url ~ '^https?://'),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_team_id, position),
  FOREIGN KEY (event_team_id, event_id) REFERENCES event_team (id, event_id) ON DELETE CASCADE
);

COMMENT ON TABLE event_team_listed_name IS
  '스트리머로 연결되지 않은 로스터 자리의 출처 표기 이름(표시 전용). 상대전적·통계에 쓰지 않는다.';

ALTER TABLE event_team_listed_name ENABLE ROW LEVEL SECURITY;

CREATE VIEW core_public.event_team_listed_name AS
  SELECT event_id, event_team_id, position, name, source_url FROM event_team_listed_name;
