---
name: ck-local
description: (실험) 학습한 판별기가 썸네일 전체에 화면 종류 라벨(밴픽·게임 중·결과창 등)과 결과창 후보를 달고 원본까지 받아 두면, Claude 는 확인·판독만 하는 CK 조사. 사용자가 "ck-local 로", "로컬로 조사", "로컬 스킬로 백필" 처럼 이 스킬을 콕 집어 요청할 때만 쓴다. 그 밖의 CK 조사는 ck-research 다.
---

# CK 조사 — 판별기 라벨 실험판

**실험이다.** 써 보고 별로면 통째로 지운다([지우기](#지우기)). 기존 [ck-research](../ck-research/SKILL.md)는 그대로다.
판별기 설계·시험 기록: [docs/CK-LOCAL-DETECTOR.md](../../../docs/CK-LOCAL-DETECTOR.md).

로컬 판별기는 **라벨만 단다** — 화면 종류(밴픽·게임 중·종료 화면·결과창·게임 방)와 결과창 후보. 판단하지 않는다.
결과창인지·몇 판인지·같은 판인지·내 게임인지 남의 방송인지·대상 경기인지는 **Claude 가 원본을 보고** ck-research 규칙으로 정한다.
라벨은 틀릴 수 있다. 라벨이 없다는 것은 "없음"의 근거가 아니다.

## 흐름

**0. 준비물** — 프롬프트의 `PREP: ck-local run_id=…` 가 `out/ck/<번호>/local/scan.json` 의 `run_id` 와 같으면 그걸 쓴다.
단일 VOD 면 직접: `npm run ck:local -- --vod <번호>` (6시간 VOD 약 1분). 끝나기 전에 다른 SOOP 도구를 시작하지 않는다.
준비 실패·종료 코드 2 면 **ck-research 로 조사하고 끝.** 종료 코드 3 은 VOD 를 못 찾은 것 — ck-backfill 접근 불가 규칙으로 확인한다.

**1. 이전 기록** — `ck:record --lead vod:<번호>`, `ck:merge --find-match --vod <번호>` (예측 위치가 있으면 그 경기는 그 위치도 본다).

**2. 구간 지도 + 개요 몽타주 — 둘 다 항상 본다.**
- 지도: `out/ck/<번호>/local/map.txt` (준비 출력에도 있다). 예:
  ```
  0:06:09~0:13:24 밴픽
  0:14:39~0:44:27 게임 중
  0:44:30~0:44:33 종료 화면
  0:44:36~0:45:21 결과창 (후보 #3,#4)
  ```
- 개요: `overview-*.jpg`(2분 칸 전체, 결과창 후보 근처는 분홍 테두리)를 **전부** 연다.
  **지도는 요약본이다** — "모름"·"롤 아님"·2분 미만 게임 구간은 빠져 있다. 지도만 보고 넘어가지 않는다.
- 둘을 맞춰 **확인할 곳 목록**을 만든다:
  ① 결과창 후보(번호 있음) ② 지도의 결과창·그래프 구간인데 후보 번호가 없는 곳
  ③ 지도의 "게임 중" 구간인데 뒤에 결과창 후보가 없는 곳 ④ **개요에서 롤로 보이는데 지도·후보에 없는 구간**
- 목록이 비고 개요에도 롤이 없으면 → 4단계. 하나라도 있으면 → 3단계.

**3. 롤이 있으면 — 이때 ck-research 의 「경기 추적」「입력 창구」「결과 화면을 찾는 기본 방법」「같은 경기의 다른 시점」을 읽는다.**
1. `candidates-*.jpg`(후보 몽타주, `#번호 시각`)를 열어 결과창으로 보이는 후보를 고른다. 같은 판을 다시 연 후보끼리 묶는다.
2. 고른 후보의 원본(`scan.json` 의 `candidates[].frame`, 이미 받아 둠)을 열어 판독한다.
   가렸으면 ck-research 「가려진 결과창의 앞쪽 보완 탐색」(`ck:probe --between`).
3. **결과창에서 먼저 읽는다.** 필요한 값이 안 보이거나 **대상 여부(CK·솔랭 등)·경기 경계·같은 경기인지가 불명확하면**
   지도의 밴픽 구간·로비·인게임 원본으로 보충한다(`ck:probe --at <초>`). 포지션은 결과창에 없다.
4. 목록의 ②③④는 띠로 본다: `npm run ck:local -- --vod <번호> --strip <시작>~<끝>` (모델 없음, 몇 초).
   결과창이 있으면 2처럼 읽고, 없으면 ck-research 결과창 탐색(원본 5분할)으로 간다.
   **재송출·리플레이·남의 방송 화면도 ck-research 대로 수집 대상 여부를 판단한 뒤 처리한다** — 시청 화면이라는 이유만으로 닫지 않는다.

**롤 게임 구간마다 결론을 남긴다**(ck-research: 대상 밖도 근거와 함께 닫는다). 대상 경기가 아니면(솔랭·LCK 시청 등)
무엇을 보고 그렇게 판단했는지 `not_target` 후보의 `observed`·`why` 에 적는다. 롤이 아닌 헛짚음(FC·전적 사이트 후보)은
DB 후보로 넣지 않고 5단계 `--verdicts` 로만 남긴다. `--finish` 가 결론 없는 게임 구간을 경고로 보여준다(막지는 않는다).

**4. 롤이 없으면** — 파일 끝 원본(`scan.json` 의 `file_tails[].frame`)을 연다(개요는 2단계에서 이미 봤다).
실제로 연 FC 화면이 있으면 ck-research 대로 한 번: `npm run fco:context -- clue --vod <번호> --at <초> --observed "본 것" --channel <채널>`.

**롤 유무와 상관없이** `scan.json` 의 `failed`(썸네일을 못 받은 범위)는 ck-research 훑기로 원본을 본다.

**5. 후보 판정 — 판별기가 배우는 자료다. 한 줄로:**
`npm run ck:local -- --review --vod <번호> --run <run_id> --verdicts 3:result,4:result,5:other,6:graph`
(`result` 결과창 점수판 · `graph` 결과창 다른 탭 · `ingame` · `client` · `other` 전적 사이트·FC·방송 그래픽 등). 연 후보만 적는다.
판별기가 **놓친 결과창**이나 **지도 라벨이 틀린 곳**은 시각으로 같이 남긴다(같은 명령에 붙여도 된다):
`--label 1:23:45=result,0:57:51=lobby` (라벨: result·graph·banpick·lobby·client·ingame·end·other — 원본이나 띠로 직접 본 것만)

**6. 기록 — 초안은 도구가 조립한다.**
```bash
npm run ck:local -- --finish --vod <번호> --run <run_id> --opened <연 원본 초,…> \
  [--result-frames <결과창 원본 초,…>] [--resolved <시작-끝,…>] [--status done|running] [--games out/ck/<번호>/local/games.json] [--note "본 것·라벨이 틀린 곳"]
npm run ck:merge -- --result out/ck/<번호>/local/final.json
```
- 경기가 있으면 `games.json` 에 **읽은 결과만** 쓴다: `{"candidates":[ck-research 후보…], "results":[match·identify…]}` (형식은 ck-research 「입력 창구」).
- `opened` 는 원본을 연 시각만이다(이 실험의 정책). `status: done` 조건은 ck-research 그대로.
- 썸네일을 못 받은 범위(`failed`)를 원본으로 메웠으면 `--finish ... --resolved <시작-끝,…>` (VOD 전체 초)로 넘긴다.
  도구가 이번 `scan.failed` 에서 빼고 `scan.resolved_failed` 에도 넣는다 — 이미 DB 에 저장된 실패까지 닫으려면 둘 다 필요하다.
- 마지막에 `npm run ck:local -- --review --vod <번호> --run <run_id> --merged done|running|failed --note "…"` (실험 장부).

**하지 않는 것**: `npm test` (코드를 안 바꾼 조사다), 롤이 없는 VOD 에서 ck-research 전체 읽기, 초안 JSON 손 조립.

보고: 찾은 경기 · 후보 수와 진짜 결과창 수 · 라벨이 틀린 곳 · 연 이미지 수.

## 여러 VOD (백필)

```bash
CK_BACKFILL_SKILL=ck-local CK_BACKFILL_PREP='node scripts/ck-local/scan.mjs --vod {vod}' \
  scripts/ck-backfill.sh --streamer <이름> --from YYYY-MM-DD --to YYYY-MM-DD
```

준비는 백필 잠금 안에서 Claude 세션 **전에** 직렬로 돈다(중단하면 같이 멈춘다). 진척·멈추기는 [ck-backfill](../ck-backfill/SKILL.md)과 같다.

## 판별기 다시 학습

5단계 판정이 쌓이면(예: 새 판정 200개마다, 또는 라벨이 자주 틀릴 때) 다시 학습한다. 몇 분 걸린다.

```bash
PY=out/ck-detector/venv/bin/python
node --env-file-if-exists=apps/web/.env.local scripts/ck-local/detector/collect.mjs --vods <판정한 VOD 들>
$PY scripts/ck-local/detector/embed.py --model siglip
$PY scripts/ck-local/detector/augment.py --model siglip         # 늘려 보기 변형
$PY scripts/ck-local/detector/train.py fit --model siglip       # 결과창 후보 판별기 — dev AP 를 이전과 비교
$PY scripts/ck-local/detector/train.py games --model siglip     # 판 단위 — 놓친 판이 늘면 이전 파일로 되돌린다
$PY scripts/ck-local/detector/multi.py eval && $PY scripts/ck-local/detector/multi.py fit   # 화면 종류 라벨
```

판별기 파일은 `out/ck-detector/model/siglip/{clf,multi}.npz`. 바꾸기 전에 복사해 둔다.

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
