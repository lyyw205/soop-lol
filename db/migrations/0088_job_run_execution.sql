-- 2026-10-16 자동화 재설계 2단계(docs/AUTOMATION-REDESIGN-PLAN.md §5.2): 실행 하나 = 행 하나, 기록의 주인은 감싸는 실행기(scripts/ops/run-job.ts).
--
-- ★ 작업 ID(ops_job — 등록부 ops/jobs/<id>.json, "무엇")와 실행 ID(run_id — "이번 한 번")는 다르다.
--   예전 행(감싸기 이전·상주 루프)은 run_id·ops_job 이 비어 있고 job 이 엔진 이름이다 — 지우거나 고치지 않는다.
-- ★ 멈춘 이유(stop_reason)는 종료 코드에서 번역하지 않는다. 실행기가 그 분기에서 직접 남기고, 못 남겼으면 unknown 이다.
--   같은 종료 코드 3 이 DB 관문·사용자 정지·시간 상한을 다 뜻하기 때문이다(scripts/ck-auto.sh).
-- ★ 같은 실행을 두 번 기록하지 않는다 — run_id 유일. DB 가 막혔을 때 파일에 남긴 기록을 나중에 옮겨도 upsert 다.
ALTER TABLE job_run
  ADD COLUMN run_id       uuid,
  ADD COLUMN ops_job      text,
  ADD COLUMN trigger      text,
  ADD COLUMN host         text,
  ADD COLUMN heartbeat_at timestamptz,
  ADD COLUMN progress     jsonb,
  ADD COLUMN stop_reason  text,
  ADD COLUMN stop_detail  text,
  ADD COLUMN exit_code    integer;

CREATE UNIQUE INDEX job_run_run_id_key ON job_run (run_id) WHERE run_id IS NOT NULL;
CREATE INDEX job_run_ops_job_recent_idx ON job_run (ops_job, started_at DESC) WHERE ops_job IS NOT NULL;

-- 사용자 정지·생략을 ok/failed 로 뭉개지 않는다. lost = 감싸기가 최종 기록 없이 죽음(생존 신호가 끊긴 running 행을 다음 실행이 닫는다).
ALTER TABLE job_run DROP CONSTRAINT job_run_state_check;
ALTER TABLE job_run ADD CONSTRAINT job_run_state_check
  CHECK (state IN ('running', 'ok', 'failed', 'stopped', 'skipped', 'lost'));
ALTER TABLE job_run ADD CONSTRAINT job_run_stop_reason_check
  CHECK (stop_reason IS NULL OR stop_reason IN ('completed', 'no_work', 'skipped', 'user_stop', 'time_cap', 'blocked_external',
    'no_progress', 'budget', 'lock_busy', 'error', 'killed', 'lost', 'unknown'));
-- 감싼 실행은 작업 ID 가 있어야 화면이 찾는다.
ALTER TABLE job_run ADD CONSTRAINT job_run_wrapped_has_job CHECK (run_id IS NULL OR ops_job IS NOT NULL);
