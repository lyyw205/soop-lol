/** 생성 파일 — 손으로 고치지 않는다. 원본은 ops/jobs/*.json, 생성은 `node scripts/ops/jobs.ts sync`(verify:automation 이 어긋남을 잡는다). */
import type { RegistryJob } from "./registry.ts";

export const REGISTRY: Omit<RegistryJob, "docs" | "notes" | "remove">[] = [
  {
    "id": "ck-auto-fc",
    "title": "FC 맥락 자동 조사",
    "group": "research",
    "install": "ck-auto",
    "units": [
      "scripts/systemd/ck-auto-fc.service",
      "scripts/systemd/ck-auto-fc.timer"
    ],
    "run": "scripts/ck-auto.sh --fc",
    "schedule": "매일 07:00",
    "record": "runner",
    "office": {
      "room": "research",
      "cadence": "매일",
      "max_age_min": 1800,
      "max_run_min": 365
    },
    "locks": [
      "out/ck/auto/fc.lock"
    ],
    "resources": [
      "soop-vod",
      "claude",
      "db"
    ],
    "skills": [
      "fco-match-context"
    ],
    "stop_files": [
      "out/ck/auto/FC_STOP"
    ],
    "publication": "API 경기 맥락 — 검수 화면에서 사후 수정"
  },
  {
    "id": "ck-auto-lol-poll",
    "title": "롤 자동 조사 — VOD 목록 확인",
    "display_group": "롤 자동 조사",
    "group": "research",
    "install": "ck-auto",
    "units": [
      "scripts/systemd/ck-auto.service",
      "scripts/systemd/ck-auto.timer"
    ],
    "run": "scripts/ck-auto.sh --poll",
    "schedule": "매시 정각 · Claude 호출 없음",
    "record": "runner",
    "office": {
      "room": "research",
      "cadence": "매시간",
      "max_age_min": 100,
      "max_run_min": 40
    },
    "locks": [
      "out/ck/auto/poll.lock"
    ],
    "resources": [
      "soop-vod",
      "db"
    ]
  },
  {
    "id": "ck-auto-lol-work",
    "title": "롤 자동 조사 — 조사",
    "display_group": "롤 자동 조사",
    "group": "research",
    "install": "ck-auto",
    "units": [
      "scripts/systemd/ck-auto-worker.path",
      "scripts/systemd/ck-auto-worker.service"
    ],
    "run": "scripts/ck-auto.sh --work",
    "schedule": "wake 파일이 생기면(목록 확인 뒤)",
    "record": "runner",
    "office": {
      "room": "research",
      "cadence": "새 VOD 도착 시",
      "max_run_min": 365
    },
    "locks": [
      "out/ck/auto/daily.lock",
      "out/ck/backfill/channel-<채널>.lock",
      ".local/ck-listen/prepare.lock"
    ],
    "resources": [
      "soop-vod",
      "asr",
      "claude",
      "disk",
      "db"
    ],
    "skills": [
      "ck-local",
      "ck-research"
    ],
    "stop_files": [
      "out/ck/auto/STOP"
    ],
    "publication": "즉시 공개(검수 화면에서 사후 수정)",
    "critical": true
  },
  {
    "id": "ck-backfill",
    "title": "CK 수동 백필",
    "group": "research",
    "install": "manual",
    "units": [],
    "run": "scripts/ck-backfill.sh --streamer <이름> [--game fconline] --from <날짜> --to <날짜>",
    "schedule": "사용자 요청 때만 — 오래 걸리면 systemd-run 임시 유닛(docs/CK-BACKFILL.md)",
    "record": "runner",
    "office": {
      "room": "backfill",
      "cadence": "사용자 요청",
      "max_run_min": 4320
    },
    "locks": [
      "out/ck/auto/.lock",
      "out/ck/backfill/channel-<채널>.lock",
      ".local/ck-listen/prepare.lock"
    ],
    "resources": [
      "soop-vod",
      "asr",
      "claude",
      "disk",
      "db"
    ],
    "skills": [
      "ck-backfill",
      "ck-local",
      "fco-match-context"
    ],
    "stop_files": [
      "out/ck/backfill/STOP"
    ],
    "publication": "롤 즉시 공개 · FC 화면 경기는 숨김 후 검수"
  },
  {
    "id": "ck-context",
    "title": "CK 음성 · 맥락 실험",
    "group": "experiment",
    "install": "none",
    "units": [],
    "run": "node scripts/ck-context/cli.mjs",
    "schedule": "사람이 시험할 때만",
    "record": "none",
    "locks": [],
    "resources": [
      "asr",
      "claude"
    ],
    "skills": [
      "ck-context"
    ]
  },
  {
    "id": "community-housekeep",
    "title": "커뮤니티 보존 기간 · 정리",
    "group": "maintenance",
    "install": "community",
    "units": [
      "scripts/systemd/soop-community.service",
      "scripts/systemd/soop-community.timer"
    ],
    "run": "npm run -s worker -- community-housekeep",
    "schedule": "매일 04:30",
    "record": "runner",
    "office": {
      "room": "community",
      "cadence": "매일",
      "max_age_min": 1560,
      "max_run_min": 30
    },
    "locks": [
      "out/locks/community.lock"
    ],
    "resources": [
      "db"
    ],
    "job_run_names": [
      "community_housekeep"
    ]
  },
  {
    "id": "fco-club",
    "title": "FC 구단가치 · 스쿼드",
    "group": "collect",
    "install": "default",
    "units": [
      "scripts/systemd/soop-fco-club.service",
      "scripts/systemd/soop-fco-club.timer"
    ],
    "run": "npm run -s worker -- fco-club",
    "schedule": "2시간마다 :10",
    "record": "runner",
    "office": {
      "room": "fc",
      "cadence": "2시간마다",
      "max_age_min": 180,
      "max_run_min": 40
    },
    "locks": [
      "out/locks/nexon.lock",
      "out/locks/fc-site.lock"
    ],
    "resources": [
      "nexon",
      "fc-site"
    ],
    "job_run_names": [
      "engine_f_fco_club"
    ]
  },
  {
    "id": "fco-matches",
    "title": "FC 경기 동기화",
    "group": "collect",
    "install": "default",
    "units": [
      "scripts/systemd/soop-fco.service",
      "scripts/systemd/soop-fco.timer"
    ],
    "run": "npm run -s worker -- fco",
    "schedule": "매일 10:00",
    "record": "runner",
    "office": {
      "room": "fc",
      "cadence": "매일",
      "max_age_min": 1560,
      "max_run_min": 60
    },
    "locks": [
      "out/locks/nexon.lock"
    ],
    "resources": [
      "nexon"
    ],
    "job_run_names": [
      "engine_e_fco"
    ]
  },
  {
    "id": "fco-prices",
    "title": "FC 카드 시세",
    "group": "collect",
    "install": "default",
    "units": [
      "scripts/systemd/soop-fco-prices.service",
      "scripts/systemd/soop-fco-prices.timer"
    ],
    "run": "npm run -s worker -- fco-prices",
    "schedule": "매일 12:40",
    "record": "runner",
    "office": {
      "room": "fc",
      "cadence": "매일",
      "max_age_min": 1560,
      "max_run_min": 90
    },
    "locks": [
      "out/locks/fc-site.lock"
    ],
    "resources": [
      "fc-site"
    ],
    "job_run_names": [
      "engine_g_fco_prices"
    ]
  },
  {
    "id": "fco-rating",
    "title": "FC 공식경기 티어",
    "group": "collect",
    "install": "default",
    "units": [
      "scripts/systemd/soop-fco-rating.service",
      "scripts/systemd/soop-fco-rating.timer"
    ],
    "run": "npm run -s worker -- fco-rating",
    "schedule": "2시간마다(홀수 시) :40",
    "record": "runner",
    "office": {
      "room": "fc",
      "cadence": "2시간마다",
      "max_age_min": 180,
      "max_run_min": 40
    },
    "locks": [
      "out/locks/fc-site.lock"
    ],
    "resources": [
      "fc-site"
    ],
    "job_run_names": [
      "engine_h_fco_rating"
    ]
  },
  {
    "id": "lol-rank",
    "title": "랭크 스냅샷",
    "group": "collect",
    "install": "default",
    "units": [
      "scripts/systemd/soop-rank.service",
      "scripts/systemd/soop-rank.timer"
    ],
    "run": "npm run -s worker -- rank",
    "schedule": "매일 09:00 · 놓친 회차는 켜지자마자",
    "record": "runner",
    "office": {
      "room": "lol",
      "cadence": "매일",
      "max_age_min": 1560,
      "max_run_min": 60
    },
    "locks": [
      "out/locks/riot.lock"
    ],
    "resources": [
      "riot"
    ],
    "job_run_names": [
      "engine_a_rank"
    ]
  },
  {
    "id": "ops-office",
    "title": "운영 오피스 수집기",
    "group": "ops",
    "install": "default",
    "units": [
      "scripts/systemd/soop-office.service",
      "scripts/systemd/soop-office.timer"
    ],
    "run": "node --env-file-if-exists=apps/web/.env.local scripts/ops-office.ts --notify",
    "schedule": "1분마다(앞 실행이 끝난 뒤) · AI 없음",
    "record": "none",
    "locks": [],
    "resources": [
      "db"
    ]
  },
  {
    "id": "ops-usage",
    "title": "운영 DB 사용량 기록",
    "group": "ops",
    "install": "default",
    "units": [
      "scripts/systemd/soop-ops-usage.service",
      "scripts/systemd/soop-ops-usage.timer"
    ],
    "run": "npm run -s ops:usage -- --record",
    "schedule": "매시 :20",
    "record": "exit_code",
    "locks": [],
    "resources": [
      "db"
    ]
  },
  {
    "id": "schedule-analyze",
    "title": "방송 일정 분석",
    "display_group": "편성표",
    "group": "collect",
    "install": "schedule",
    "install_hook": "scripts/schedule-notices/run.sh init",
    "units": [
      "scripts/systemd/soop-schedule-analyze.service",
      "scripts/systemd/soop-schedule-analyze.timer"
    ],
    "run": "scripts/schedule-notices/run.sh analyze",
    "schedule": "10분마다(앞 실행이 끝난 뒤) · claude -p --json-schema",
    "record": "exit_code",
    "office": {
      "room": "schedule",
      "cadence": "10분마다",
      "max_age_min": 35,
      "max_run_min": 20
    },
    "locks": [],
    "resources": [
      "claude"
    ],
    "publication": "검토 후보까지(사람이 승인)"
  },
  {
    "id": "schedule-poll",
    "title": "방송 공지 수집",
    "display_group": "편성표",
    "group": "collect",
    "install": "schedule",
    "install_hook": "scripts/schedule-notices/run.sh init",
    "units": [
      "scripts/systemd/soop-schedule-poll.service",
      "scripts/systemd/soop-schedule-poll.timer"
    ],
    "run": "scripts/schedule-notices/run.sh poll",
    "schedule": "30분마다(앞 실행이 끝난 뒤) · Claude 호출 없음",
    "record": "exit_code",
    "office": {
      "room": "schedule",
      "cadence": "30분마다",
      "max_age_min": 65,
      "max_run_min": 20
    },
    "locks": [],
    "resources": [
      "soop-board"
    ],
    "publication": "검토 후보까지(사람이 승인)"
  },
  {
    "id": "t7-archive-ck",
    "title": "끝난 VOD 폴더 보관(T7)",
    "group": "maintenance",
    "install": "t7-archive",
    "units": [
      "scripts/systemd/t7-archive-ck.service",
      "scripts/systemd/t7-archive-ck.timer"
    ],
    "run": "scripts/t7-archive-ck.sh",
    "schedule": "3시간마다(부팅 30분 뒤부터)",
    "record": "exit_code",
    "office": {
      "room": "backfill",
      "cadence": "3시간마다",
      "max_age_min": 240,
      "max_run_min": 60
    },
    "locks": [
      "/tmp/t7-archive-ck.lock"
    ],
    "resources": [
      "disk"
    ]
  },
  {
    "id": "worker-loop",
    "title": "상주 워커 루프(랭크 · 지명 수집 · 지명 백필 · 모듈 작업)",
    "group": "collect",
    "install": "none",
    "units": [],
    "run": "npm run worker -- loop",
    "schedule": "상주 — A > B > C 우선순위 단일 루프",
    "record": "none",
    "office": {
      "room": "lol",
      "cadence": "워커 루프",
      "max_run_min": 90
    },
    "locks": [],
    "resources": [
      "riot",
      "db"
    ],
    "job_run_names": [
      "engine_b_live",
      "engine_c_backfill"
    ]
  }
];
