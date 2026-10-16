-- 사용자 제보 — docs/USER-SUBMISSION-PLAN.md (2026-10-16 확정)
--
-- 제보는 **기존 쓰기 길**(applyMatchReviewInTx)로 바로 반영되고, 운영자가 확인할 때까지 "확인 전"이다.
--   submission            제보 하나(보낸 회원·종류·대상·정규화한 제안·지문·상태)
--   submission_supporter  같은 내용이에요(+1)
--   submission_effect     제보가 바꾼 판 — 확인 전 표시가 읽는다
--   review_change         (기존) actor='member' + submission_id — 바뀐 칸의 전후 값, 되돌리기의 원본
--
-- 확인 전 판은 **집계에서 빠지고 목록에는 보인다**(결정 A). 보너스판과 같은 자리(집계 뷰의 거르기 한 곳)에서 뺀다:
--   lol_set_row   → lol_versus_set  = WHERE NOT pending   (집계 코드는 그대로)
--   lol_pair_row  → versus_pair_set = WHERE NOT pending ∪ FC
-- 신원 규칙·짝 찾기는 *_row 뷰에만 있다 — 집계 뷰는 거르기일 뿐이다.

-- ── 제보 ────────────────────────────────────────────────────────────────────────
CREATE TABLE submission (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 탈퇴하면 NULL(메모·근거와 함께 지운다). 반영된 값과 이력은 남는다 — 데이터의 이력은 회원의 글이 아니다.
  author_id     uuid REFERENCES member(id),
  -- 요청 번호 — 같은 폼을 두 번 보내도(두 번 누르기·재시도) 제보는 하나다.
  request_id    uuid NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('match_correction')),
  -- 대상(종류마다 칸 하나). 판이 지워져도 제보 기록은 남는다(SET NULL).
  match_id      text REFERENCES match(match_id) ON DELETE SET NULL,
  -- 정규화한 제안(core/lib/metrics/submission.ts). 지문은 대상 + 제안의 sha256 — 열린 제보 중에 같은 것은 하나다.
  payload       jsonb NOT NULL,
  fingerprint   text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  note          text CHECK (char_length(note) <= 1000),
  evidence_url  text CHECK (char_length(evidence_url) <= 500),
  state         text NOT NULL CHECK (state IN ('applied', 'held', 'verified', 'reverted', 'rejected', 'duplicate')),
  -- 보류 이유 — 보류로 접수된 제보는 처리 뒤에도 남긴다(왜 바로 안 바뀌었나).
  hold_reason   text CHECK (hold_reason IN ('review_completed', 'api_observed', 'account_identity', 'contested', 'not_public')),
  duplicate_of  uuid REFERENCES submission(id),
  decided_by    text,
  decided_at    timestamptz,
  decision_note text CHECK (char_length(decision_note) <= 1000),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (author_id, request_id),
  CHECK (kind <> 'match_correction' OR match_id IS NOT NULL OR state NOT IN ('applied', 'held')),
  CHECK (state <> 'held' OR hold_reason IS NOT NULL),
  CHECK ((state = 'duplicate') = (duplicate_of IS NOT NULL)),
  CHECK ((state IN ('applied', 'held')) = (decided_at IS NULL)),
  CHECK ((decided_at IS NULL) = (decided_by IS NULL))
);
-- 열린 제보 중 같은 지문은 하나 — 동시에 같은 제보 둘이 들어와도 하나만 남는다(나머지는 +1).
CREATE UNIQUE INDEX submission_open_fingerprint_uq ON submission (fingerprint) WHERE state IN ('applied', 'held');
CREATE INDEX submission_match_idx ON submission (match_id) WHERE match_id IS NOT NULL;
CREATE INDEX submission_author_idx ON submission (author_id, created_at DESC, id);
CREATE INDEX submission_queue_idx ON submission (state, created_at, id);
COMMENT ON TABLE submission IS '사용자 제보. 비공개(본인·운영자). 반영은 기존 쓰기 길(applyMatchReviewInTx, actor member)만 — core/lib/db/submission.ts.';

CREATE TABLE submission_supporter (
  submission_id uuid NOT NULL REFERENCES submission(id) ON DELETE CASCADE,
  member_id     uuid NOT NULL REFERENCES member(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (submission_id, member_id)
);
COMMENT ON TABLE submission_supporter IS '같은 내용이에요(+1). 지문이 같은 제보를 다른 회원이 보내면 새 제보 대신 여기에 한 줄.';

CREATE TABLE submission_effect (
  submission_id uuid NOT NULL REFERENCES submission(id),
  match_id      text NOT NULL REFERENCES match(match_id) ON DELETE CASCADE,
  PRIMARY KEY (submission_id, match_id)
);
CREATE INDEX submission_effect_match_idx ON submission_effect (match_id);
COMMENT ON TABLE submission_effect IS '제보가 바꾼 판. applied 제보의 흔적이 있는 판 = 확인 전(core_public 뷰가 계산한다).';

ALTER TABLE submission ENABLE ROW LEVEL SECURITY;
ALTER TABLE submission_supporter ENABLE ROW LEVEL SECURITY;
ALTER TABLE submission_effect ENABLE ROW LEVEL SECURITY;

-- ── 이력 — 누가 고쳤나 ─────────────────────────────────────────────────────────────
ALTER TABLE review_change DROP CONSTRAINT review_change_actor_check;
ALTER TABLE review_change ADD CONSTRAINT review_change_actor_check CHECK (actor IN ('admin', 'auto', 'member'));
ALTER TABLE review_change ADD COLUMN submission_id uuid REFERENCES submission(id);
ALTER TABLE review_change ADD CONSTRAINT review_change_member_submission
  CHECK ((actor = 'member') = (submission_id IS NOT NULL));
CREATE INDEX review_change_submission_idx ON review_change (submission_id, id) WHERE submission_id IS NOT NULL;
COMMENT ON COLUMN review_change.submission_id IS 'actor=member 일 때 그 제보. 되돌리기는 이 제보의 이력만 역순으로 되돌린다.';

-- ── 탈퇴 — 회원이 쓴 글(메모·근거)과 연결을 지운다 ─────────────────────────────────
CREATE FUNCTION erase_withdrawn_submission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE submission SET author_id = NULL, note = NULL, evidence_url = NULL, updated_at = now() WHERE author_id = NEW.id;
  DELETE FROM submission_supporter WHERE member_id = NEW.id;
  RETURN NEW;
END $$;
CREATE TRIGGER member_erase_submission AFTER UPDATE OF status ON member
  FOR EACH ROW WHEN (NEW.status = 'withdrawn') EXECUTE FUNCTION erase_withdrawn_submission();

-- ── 공개 뷰 층 ──────────────────────────────────────────────────────────────────────
-- 확인 전 = applied 제보의 흔적이 있는 판. **정의는 이 뷰 하나** — 목록 뷰·경기 보기·대진이 모두 이것을 EXISTS 로 본다.
-- (함수로 두지 않는다 — 함수는 부른 쪽(공개 키)의 권한으로 돌아 RLS 표를 못 읽는다. 뷰는 뷰 주인의 권한으로 읽는다.)
CREATE VIEW core_public.pending_match AS
  SELECT se.match_id FROM submission_effect se JOIN submission su ON su.id = se.submission_id WHERE su.state = 'applied';
COMMENT ON VIEW core_public.pending_match IS '확인 전 판(회원 제보가 바꾸고 운영자가 아직 안 본 판). 집계는 이 판을 빼고, 목록은 표시를 단다.';

-- 목록용 — 공개 본게임 세트 전부(확인 전 포함). 신원 규칙은 여기에만 있다(0089 의 lol_versus_set 본문을 옮겼다).
CREATE VIEW core_public.lol_set_row AS
  SELECT 'lol'::text AS game_code, m.match_id, p.participant_id AS slot, p.team_id AS side, s.id AS streamer_id, p.outcome,
         p.champion_id, core_public.resolve_position(p.team_position, p.individual_position) AS position,
         p.kills, p.deaths, p.assists, NULL::integer AS goals,
         m.series_id, m.series_game_no, ms.best_of, ms.set_order_known,
         e.id AS event_id, e.format, e.auto_bucket, m.map, m.mode_key,
         m.game_creation AS played_at, m.game_creation_precision, m.game_duration,
         ((SELECT min(f.game_creation) FROM match f
            WHERE f.series_id = m.series_id AND f.set_role = 'main' AND f.visibility = 'public') AT TIME ZONE 'Asia/Seoul')::date AS series_started_on,
         EXISTS (SELECT 1 FROM core_public.pending_match pm WHERE pm.match_id = m.match_id) AS pending
    FROM match m
    JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code
    JOIN event e ON e.id = ms.event_id
    JOIN match_participant p ON p.match_id = m.match_id
    LEFT JOIN streamer_account sa ON sa.puuid = p.puuid AND sa.active_to IS NULL
    JOIN streamer s ON s.visibility = 'public' AND s.id =
      CASE WHEN sa.puuid IS NOT NULL THEN CASE WHEN sa.visibility = 'public' THEN sa.streamer_id END ELSE p.streamer_id END
   WHERE m.game_code = 'lol' AND m.visibility = 'public' AND m.scope = 'versus' AND m.set_role = 'main'
     AND m.map IN ('rift', 'aram');
COMMENT ON VIEW core_public.lol_set_row IS
  '공개 본게임 세트(목록용) — 확인 전(pending) 포함. 집계는 lol_versus_set(= NOT pending)만 읽는다. tally 는 pending 행을 세지 않는다.';

-- 집계용 — 칸·순서는 0089 그대로(집계 코드가 바뀌지 않는다).
CREATE OR REPLACE VIEW core_public.lol_versus_set AS
  SELECT game_code, match_id, slot, side, streamer_id, outcome, champion_id, position, kills, deaths, assists, goals,
         series_id, series_game_no, best_of, set_order_known, event_id, format, auto_bucket, map, mode_key,
         played_at, game_creation_precision, game_duration, series_started_on
    FROM core_public.lol_set_row WHERE NOT pending;

-- 상대 전적 목록용 — 같은 판의 두 사람(0089 의 짝 찾기를 옮겼다 — LATERAL + OFFSET 0 이유는 0089 주석).
CREATE VIEW core_public.lol_pair_row AS
  SELECT a.game_code, a.match_id, a.streamer_id AS a_streamer_id, b.streamer_id AS b_streamer_id,
         CASE WHEN a.side = b.side THEN 'teammate' ELSE 'opponent' END AS relation,
         a.outcome AS a_outcome, b.outcome AS b_outcome, a.position AS a_position, b.position AS b_position,
         a.champion_id AS a_champion_id, b.champion_id AS b_champion_id,
         a.series_id, a.series_game_no, a.event_id, a.format, a.auto_bucket, a.map, a.mode_key,
         a.played_at, a.series_started_on, a.pending
    FROM core_public.lol_set_row a
    CROSS JOIN LATERAL (SELECT x.streamer_id, x.side, x.outcome, x.position, x.champion_id
                          FROM core_public.lol_set_row x WHERE x.match_id = a.match_id OFFSET 0) b
   WHERE b.streamer_id <> a.streamer_id;

CREATE OR REPLACE VIEW core_public.versus_pair_set AS
  SELECT game_code, match_id, a_streamer_id, b_streamer_id, relation, a_outcome, b_outcome, a_position, b_position,
         a_champion_id, b_champion_id, series_id, series_game_no, event_id, format, auto_bucket, map, mode_key,
         played_at, series_started_on
    FROM core_public.lol_pair_row WHERE NOT pending
  UNION ALL
  SELECT a.game_code, a.match_id, a.streamer_id, b.streamer_id,
         CASE WHEN a.side = b.side THEN 'teammate' ELSE 'opponent' END,
         a.outcome, b.outcome, a.position, b.position, a.champion_id, b.champion_id,
         a.series_id, a.series_game_no, a.event_id, a.format, a.auto_bucket, a.map, a.mode_key,
         a.played_at, a.series_started_on
    FROM core_public.fc_versus_set a
    CROSS JOIN LATERAL (SELECT x.streamer_id, x.side, x.outcome, x.position, x.champion_id
                          FROM core_public.fc_versus_set x WHERE x.match_id = a.match_id OFFSET 0) b
   WHERE b.streamer_id <> a.streamer_id;

-- 경기 보기 — 확인 전 칸을 끝에 더한다. 이 뷰로 직접 세는 곳(대회 점수·판 수)은 pending 을 거른다(verify:modules).
CREATE OR REPLACE VIEW core_public.match_detail AS
  SELECT m.match_id, m.series_id, m.series_game_no, m.set_role, m.set_label, ms.event_id, e.format, m.map,
         ms.best_of, ms.set_order_known, ms.round_label,
         m.queue_id, m.game_mode, m.game_creation AS played_at, m.game_creation_precision, m.game_duration,
         m.winning_team, m.blue_team_id, m.red_team_id, m.source_url, m.collected_via,
         p.participant_id, p.team_id, p.team_position, p.individual_position,
         core_public.resolve_position(p.team_position, p.individual_position) AS position,
         p.champion_id, p.champion_name, p.champ_level, p.kills, p.deaths, p.assists, p.outcome,
         s.id AS streamer_id,
         CASE WHEN p.puuid IS NULL AND p.streamer_id IS NULL THEN p.observed_name END AS observed_name,
         EXISTS (SELECT 1 FROM core_public.pending_match pm WHERE pm.match_id = m.match_id) AS pending
    FROM match m
    JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code
    JOIN event e ON e.id = ms.event_id
    JOIN match_participant p ON p.match_id = m.match_id
    LEFT JOIN streamer_account sa ON sa.puuid = p.puuid AND sa.active_to IS NULL
    LEFT JOIN streamer s ON s.visibility = 'public' AND s.id =
      CASE WHEN sa.puuid IS NOT NULL THEN CASE WHEN sa.visibility = 'public' THEN sa.streamer_id END ELSE p.streamer_id END
   WHERE m.visibility = 'public' AND m.scope = 'versus' AND m.game_code = 'lol'
     AND m.map <> 'unsupported'
     AND (s.id IS NOT NULL OR (p.puuid IS NULL AND p.streamer_id IS NULL AND p.observed_name IS NOT NULL));

-- 새 뷰의 권한은 lol_versus_set 의 것을 그대로 받는다(다른 core_public 뷰와 같게).
DO $$ DECLARE g record; v text;
BEGIN
  FOREACH v IN ARRAY ARRAY['pending_match', 'lol_set_row', 'lol_pair_row'] LOOP
    FOR g IN SELECT grantee, privilege_type, is_grantable FROM information_schema.table_privileges
              WHERE table_schema = 'core_public' AND table_name = 'lol_versus_set' LOOP
      EXECUTE format('GRANT %s ON core_public.%I TO %s%s', g.privilege_type, v,
        CASE WHEN g.grantee = 'PUBLIC' THEN 'PUBLIC' ELSE quote_ident(g.grantee) END,
        CASE WHEN g.is_grantable = 'YES' THEN ' WITH GRANT OPTION' ELSE '' END);
    END LOOP;
  END LOOP;
END $$;
