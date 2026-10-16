# 자동화 등록부

`ops/jobs/<id>.json` 하나가 정기·조사 작업 하나다. 이 PC 에서 도는 것, 사람이 띄우는 것(백필),
설치하지 않는 것(상주 루프·실험)까지 전부 여기 적는다. 등록부는 **이미 있는 유닛·실행기를 설명**한다 —
유닛을 만들거나 동작을 바꾸지 않는다. 배경은 [docs/AUTOMATION-REDESIGN-PLAN.md](../docs/AUTOMATION-REDESIGN-PLAN.md) §5.1.

```bash
node scripts/ops/jobs.ts list               # 묶음별 작업
scripts/systemd/install.sh --status         # 설치 작업마다 상태·마지막 실행·다음 실행
npm run verify:automation                   # 등록부 ↔ 유닛·설치기·운영 화면 대조(+ 자가시험)
npm run verify:automation -- --host         # + 이 PC 에 설치된 유닛과 대조
```

## 칸

| 칸 | 뜻 |
|---|---|
| `id` | 파일 이름과 같다 |
| `title` · `display_group` | 사람이 읽는 이름 · 화면에서 묶어 보일 이름(목록 확인·조사처럼 실행은 다르지만 한 업무인 것) |
| `group` | `collect` 수집 · `research` 조사 · `maintenance` 정리 · `ops` 운영 · `experiment` 실험 |
| `install` | 설치 묶음 — `default` · `ck-auto` · `schedule` · `community` · `t7-archive`, 설치하지 않으면 `manual`(사람이 띄움) · `none`(루프 전용·실험) |
| `install_hook` | 유닛을 잇기 전에 한 번 돌리는 준비 명령 |
| `units` | 이 작업의 유닛 파일(`scripts/systemd/…`). 설치 작업은 깨우는 유닛(`.timer`·`.path`)과 짝 서비스가 같이 있어야 한다 |
| `run` | 실제 명령 — 서비스 유닛 `ExecStart` 안에 그대로 있어야 한다(둘 중 하나만 고치면 검사가 잡는다) |
| `record` | 실행 기록 방식 — `runner`(감싸서 기록, 멈춘 이유는 실행기가 분기마다 `ops_stop` 으로 남김 · 없으면 unknown) · `exit_code`(감싸서 기록, 이유는 종료 코드 — 성공 경로가 하나뿐인 단순 작업) · `none`(감싸지 않음) |
| `office` | 운영 화면 카드 — `room`·`cadence`(화면 주기 문구)·`max_age_min`(이만큼 실행이 없으면 지연)·`max_run_min`(이만큼 돌면 지연). 없으면 카드가 없다 |
| `schedule` | 언제 도나(사람용) |
| `locks` · `resources` | 잡는 잠금 파일 · 쓰는 외부 자원(`riot` `nexon` `fc-site` `soop-board` `soop-vod` `asr` `claude` `disk` `db`) |
| `skills` | 조사 세션이 따르는 스킬 — 실행기가 실제로 그 이름을 부르는지 검사한다 |
| `stop_files` · `publication` · `critical` | 멈춤 파일 · 결과가 언제 공개되나 · 멈추면 서비스 차별점이 사라지나 |
| `job_run_names` | 감싸기 이전·상주 루프가 `job_run.job` 에 남긴 엔진 이름 — 그 기록도 이 작업의 이력으로 읽는다 |
| `docs` · `notes` · `remove` | 관련 문서 · 주의할 점 · **지우는 절차** |

멈춘 이유를 종료 코드로 번역하는 표는 두지 않는다 — 같은 코드가 여러 이유를 뜻한다(재설계 계획 §5.2-3).

## 실행 기록

기록하는 작업(`record` 가 `none` 이 아님)의 서비스는 감싸는 실행기를 거친다:
`ExecStart=%h/.local/node/bin/node %h/repos/soop-lol/scripts/ops/run-job.ts --job <id> -- <원래 명령>`.
실행 하나가 `job_run` 한 행(0088 — `run_id`·`ops_job`·생존 신호·진척·`stop_reason`)이 되고, DB 가 막히면
`out/ops/runs.jsonl` 에 남았다가 다음 실행이 옮긴다. 사람이 띄우는 백필도 같은 방식으로 감싸면 화면에 보인다:

```bash
node scripts/ops/run-job.ts --job ck-backfill -- scripts/ck-backfill.sh --streamer <이름> --from <날짜> --to <날짜>
```

실행기 셸은 `scripts/ops/ops-stop.sh` 를 source 하고, 끝나는 분기마다 `ops_stop <이유> <설명>`, 진척은 `ops_progress` 로 남긴다.
운영 화면이 읽는 목록은 생성 파일 `packages/core/lib/ops/jobs.generated.ts` — 등록부를 고치면 `node scripts/ops/jobs.ts sync`.

## 더하기

1. 유닛을 `scripts/systemd/` 에 만든다(`ExecStart` 는 `%h/repos/soop-lol/…`).
2. `ops/jobs/<id>.json` 을 쓴다 — `run` 은 `ExecStart` 의 명령 그대로(앞에 감싸는 실행기), `remove` 에 지우는 절차.
3. `node scripts/ops/jobs.ts sync` → `npm run verify:automation` → `scripts/systemd/install.sh --bundle <묶음>`(또는 `--job <id>`).

## 빼기

등록부 파일의 `remove` 를 위에서부터 따른다 — 보통 `install.sh --disable-job <id>` → 유닛·등록부 파일 삭제 →
`node scripts/ops/jobs.ts sync` → `npm run verify:automation`. 설치기를 고칠 일은 없다(목록을 등록부에서만 받는다). 남은 흔적(주인 없는 유닛,
운영 화면 목록, 이 PC 의 깨진 설치 링크)은 검사가 잡는다.
