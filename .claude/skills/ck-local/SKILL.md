---
name: ck-local
description: (실험) 학습한 결과창 판별기가 썸네일 전체에서 결과창 후보를 고르고 원본까지 받아 두면, Claude 는 후보를 골라 판독만 하는 CK 조사. 사용자가 "ck-local 로", "로컬로 조사", "로컬 스킬로 백필" 처럼 이 스킬을 콕 집어 요청할 때만 쓴다. 그 밖의 CK 조사는 ck-research 다.
---

# CK 조사 — 결과창 판별기 실험판

**실험이다.** 써 보고 별로면 통째로 지운다([지우기](#지우기)). 기존 [ck-research](../ck-research/SKILL.md)는 그대로다.
판별기 설계·시험 기록: [docs/CK-LOCAL-DETECTOR.md](../../../docs/CK-LOCAL-DETECTOR.md).

**판독·경기 추적·중복 조회·기록 규칙은 ck-research 가 정본이다.** 이 스킬은 **결과창을 어디서 찾는가** 하나를 바꾼다.

| | ck-research | ck-local |
|---|---|---|
| 결과창 찾기 | 30분 격자 → 원본 5분할 반복 | 판별기가 썸네일 **모든 칸(3초)** 에서 후보를 고르고 **원본까지 받아 둔다** |
| Claude | 찾기 + 읽기 | **후보 고르기 + 읽기** |

판별기가 고른 건 "어디를 볼지"뿐이다. 결과창인지·몇 판인지·같은 판인지·대상 경기인지는 Claude 가 원본으로 정한다.

## 흐름

**0. 준비물** — 프롬프트의 `PREP: ck-local run_id=…` 가 `out/ck/<번호>/local/scan.json` 의 `run_id` 와 같으면 그걸 쓴다.
단일 VOD 면 직접: `npm run ck:local -- --vod <번호>` (6시간 VOD 약 1분). 끝나기 전에 다른 SOOP 도구를 시작하지 않는다.
준비 실패·종료 코드 2 면 **ck-research 로 조사하고 끝.** 종료 코드 3 은 VOD 를 못 찾은 것 — ck-backfill 접근 불가 규칙으로 확인한다.

**1. 이전 기록** — ck-research 1단계 그대로 (`ck:record --lead`, `ck:merge --find-match --vod <번호>`, 예측 위치).

**2. 후보 몽타주** — `candidates-*.jpg` 를 연다(칸 밑 `#번호 시각`, 후보 목록은 `scan.json` 의 `candidates`).
진짜 결과창으로 보이는 후보를 고르고, 같은 판을 다시 연 후보끼리 묶는다(시각이 가깝고 화면이 같다). 결과창이 아닌 후보는 버린다.

**3. 원본 판독** — 고른 후보의 원본(`candidates[].frame`, 이미 받아 둠)을 열어 ck-research 대로 읽는다.
판마다 필요한 칸이 안 보이거나 가렸으면 ck-research 「가려진 결과창의 앞쪽 보완 탐색」을 한다(`ck:probe --between`).
밴픽·로딩이 필요하면 띠로 위치를 찾는다: `npm run ck:local -- --vod <번호> --strip <시작>~<끝>` (모델 없음, 몇 초).

**4. 빠진 판 점검** — `overview-*.jpg`(2분 칸, 후보가 걸친 칸은 분홍)를 연다.
**롤 게임 화면이 보이는데 근처에 분홍이 없는 구간**이 있으면 그 구간 끝을 띠로 보고, 결과창이 있으면 3단계처럼 읽는다.
없으면 ck-research 결과창 탐색(5분할)으로 간다. 판별기가 못 찾았다는 것만으로 "결과 화면 미발견"으로 닫지 않는다.
`scan.json` 의 `failed`(썸네일을 못 받은 범위)는 ck-research 훑기로 원본을 본다. 롤이 없는 VOD 면 파일 끝 원본(`file_tails[].frame`)을 연다.

**5. 후보 판정 남기기 — 판별기가 배우는 자료다.** 연 후보마다 한 줄:
`npm run ck:local -- --review --vod <번호> --run <run_id> --cand <n> --is result|ingame|client|other`
(`result` 클라이언트 결과창 · `ingame` 게임 중 화면 · `client` 로비·챔피언 선택·대전 기록 · `other` 그 밖 — 전적 사이트·FC·방송 그래픽)
4단계에서 판별기가 놓친 결과창은 `--note` 에 시각을 적는다.

**6. 기록** — ck-research 기록 규칙 그대로. 초안 `out/ck/<번호>/local/scan-draft.json` 하나에 모아 `ck:merge` 로 낸다.
`ck:probe` 가 만든 바깥 `out/ck/<번호>/scan-draft.json`(또는 `.latest.json`)에서 연 원본의 frames 를 복사해 넣는다.
- `scan.version` 은 `ck-local/4` 그대로, `note` 첫 줄(run_id)을 지우지 않는다.
- `opened` 는 **원본을 연 시각만**(이 실험의 정책). 몽타주는 `--review --opened candidates-1.jpg,overview-1.jpg,…` 로 남긴다.
- 초안 `failed` 는 썸네일을 못 받은 범위다. 원본으로 본 만큼 뺀다. 이미 저장된 실패는 `scan.resolved_failed` 로 닫는다.
- 마지막에 `npm run ck:local -- --review --vod <번호> --run <run_id> --merged done|running|failed --note "…"` (실험 장부).

보고: ck-research 「끝내기」 + **후보 수 · 진짜 결과창 수 · 판별기가 놓친 판 · Claude 가 연 이미지 수.**

## 여러 VOD (백필)

```bash
CK_BACKFILL_SKILL=ck-local CK_BACKFILL_PREP='node scripts/ck-local/scan.mjs --vod {vod}' \
  scripts/ck-backfill.sh --streamer <이름> --from YYYY-MM-DD --to YYYY-MM-DD
```

준비는 백필 잠금 안에서 Claude 세션 **전에** 직렬로 돈다(중단하면 같이 멈춘다). 진척·멈추기는 [ck-backfill](../ck-backfill/SKILL.md)과 같다.

## 판별기 다시 학습

5단계 판정이 쌓이면(예: 새 판정 200개마다, 또는 헛짚음·놓침이 눈에 띌 때) 다시 학습한다. 몇 분 걸린다.

```bash
PY=out/ck-detector/venv/bin/python
node --env-file-if-exists=apps/web/.env.local scripts/ck-local/detector/collect.mjs --vods <판정한 VOD 들>   # 썸네일 목록
$PY scripts/ck-local/detector/embed.py --model siglip
$PY scripts/ck-local/detector/train.py fit --model siglip      # dev AP 를 이전과 비교
$PY scripts/ck-local/detector/train.py games --model siglip    # 판 단위 — 놓친 판이 늘면 이전 판별기로 되돌린다
```

판별기 파일은 `out/ck-detector/model/siglip/clf.npz`. 바꾸기 전에 복사해 둔다.

## 지우기

남는 것: 공용 시간축 수정(`scripts/lib/vod-timeline.mjs`, `scanSheets`·`ck-probe` 전환, `verify-sheet-axis.mjs`) — 기존 도구의 결함 수정이라 지우지 않는다.
`ck-backfill.sh` 의 `CK_BACKFILL_SKILL`·`CK_BACKFILL_PREP` 도 안 주면 꺼진 상태라 둬도 무해하다.

지우는 것:
1. `rm -rf .claude/skills/ck-local scripts/ck-local`
2. `package.json` 의 `"ck:local"` 줄
3. 대상 VOD 목록을 **먼저 장부에서** 뽑는다: `out/ck/local-ledger.jsonl` (`kind: "claude"` 줄이 조사까지 간 VOD)
4. 산출물: `rm -rf out/ck/*/local out/ck/local-ledger.jsonl out/ck-detector` (썸네일 캐시 `out/ck/*/sheets` 는 공용이라 선택)
5. DB — 기록된 경기는 원본으로 판독한 것이라 그대로 둔다. 그 VOD 들을 ck-research 로 **다시 조사하게** 하려면
   (사용자가 원할 때만) 3의 목록으로 `event_lead.raw` 에서 `scan` 을 빼면 미조사로 돌아가 백필이 다시 집는다:
   ```sql
   -- update event_lead set raw = raw - 'scan' where source_key = any(array['vod:…', …]);
   ```
