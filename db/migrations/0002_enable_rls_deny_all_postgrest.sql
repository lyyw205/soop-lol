-- 정책을 하나도 만들지 않고 RLS 만 켠다 = PostgREST(anon/authenticated) 로는 아무것도 못 읽는다.
-- 웹과 워커는 postgres.js 로 소유자 롤에 직접 붙으므로 영향이 없다 (소유자는 RLS 를 우회한다).
--
-- 형식적인 조치가 아니다. Supabase 는 public 스키마를 REST 로 자동 노출하는데,
-- 그러면 streamer_account.visibility='hidden' 인 부계정과 evidence(제보자 메모)가
-- anon 키만으로 그대로 읽힌다 (docs/PLAN.md §11-2).

ALTER TABLE streamer            ENABLE ROW LEVEL SECURITY;
ALTER TABLE riot_account        ENABLE ROW LEVEL SECURITY;
ALTER TABLE streamer_account    ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_candidate   ENABLE ROW LEVEL SECURITY;
ALTER TABLE event               ENABLE ROW LEVEL SECURITY;
ALTER TABLE match               ENABLE ROW LEVEL SECURITY;
ALTER TABLE match_participant   ENABLE ROW LEVEL SECURITY;
ALTER TABLE streamer_encounter  ENABLE ROW LEVEL SECURITY;
ALTER TABLE champion_stat       ENABLE ROW LEVEL SECURITY;
ALTER TABLE rank_snapshot       ENABLE ROW LEVEL SECURITY;
ALTER TABLE season_record       ENABLE ROW LEVEL SECURITY;
ALTER TABLE career_event        ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingest_cursor       ENABLE ROW LEVEL SECURITY;
ALTER TABLE dead_match          ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_run             ENABLE ROW LEVEL SECURITY;
