-- 0081 — 회원(소셜 로그인). docs/COMMUNITY-PLAN.md §2
--
-- ★ 이름이 member 인 이유: account 는 이미 게임 계정(streamer_account·riot_account·fco_account)이다.
--   "계정" 에 세 번째 뜻을 붙이지 않는다. user 는 Postgres 예약어다.
-- ★ 받는 것은 로그인 제공자의 고유 id(sub) 하나다. 이메일·실명·프로필을 받지 않는다(수집 범위를 줄인다).
-- ★ 닉네임은 표시용이다. 바뀌므로 조인·주소에 쓰지 않는다(Riot ID 와 같은 규칙). 작성자 키는 member.id 다.
-- ★ 탈퇴해도 회원 행은 남긴다 — 글의 작성자 키가 깨지지 않게. 로그인 연결(member_identity)은 재가입 제한 기간이
--   끝날 때까지 남는다. 그 기간은 저장하지 않고 탈퇴 시각과 제재 기록에서 그때그때 계산한다(core/lib/metrics/community.ts).
-- ★ 쓰기는 core/lib/db/member.ts 하나다. 회원 쓰기·탈퇴·제재 변경·연결 정리는 모두 이 행을 FOR UPDATE 로 먼저 잠근다.

CREATE TABLE member (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nickname     text,                 -- 표시용. 처음 로그인 직후·탈퇴 뒤에는 NULL
  nickname_key text UNIQUE,          -- 정규화 키(core/lib/metrics/nickname.ts 하나가 만든다). 중복·사칭 판정용
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'withdrawn')),
  agreed_at    timestamptz,          -- 약관·처리방침 동의(만 14세 이상 확인 포함) 시각. 닉네임을 정할 때 함께 받는다
  created_at   timestamptz NOT NULL DEFAULT now(),
  withdrawn_at timestamptz,          -- 재가입 제한 기간 계산의 기준(기간 자체는 저장하지 않는다)
  CHECK ((status = 'withdrawn') = (withdrawn_at IS NOT NULL)),
  CHECK (status = 'active' OR (nickname IS NULL AND nickname_key IS NULL)),
  CHECK ((nickname IS NULL) = (nickname_key IS NULL)),
  CHECK (nickname IS NULL OR agreed_at IS NOT NULL)
);

-- 제공자가 준 고유 id 가 불변 키다(puuid 와 같은 자리). 탈퇴해도 재가입 제한 기간이 끝날 때까지 남는다.
CREATE TABLE member_identity (
  provider      text NOT NULL CHECK (provider IN ('kakao', 'google')),
  subject       text NOT NULL CHECK (subject <> ''),
  member_id     uuid NOT NULL REFERENCES member(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX member_identity_member_idx ON member_identity (member_id);

-- 쿠키에는 무작위 토큰, 여기에는 그 sha256 만 둔다. 세션은 로그인부터 30일이고 연장하지 않는다(렌더 중 쓰기를 피한다).
CREATE TABLE member_session (
  token_hash bytea PRIMARY KEY,
  member_id  uuid NOT NULL REFERENCES member(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > created_at)
);
CREATE INDEX member_session_member_idx ON member_session (member_id);

-- PostgREST 로 새지 않게(docs/SETUP.md §2). 앱은 소유자 롤로 직결하므로 영향이 없다.
ALTER TABLE member          ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_identity ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_session  ENABLE ROW LEVEL SECURITY;
