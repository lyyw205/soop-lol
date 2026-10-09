---
name: ck-local
description: (실험) 학습한 판별기가 썸네일 전체에 화면 종류 라벨(밴픽·게임 중·결과창 등)과 결과창 후보를 달고 원본까지 받아 두면, Claude 는 확인·판독만 하는 CK 조사. 사용자가 "ck-local 로", "로컬로 조사", "로컬 스킬로 백필" 처럼 이 스킬을 콕 집어 요청할 때만 쓴다. 그 밖의 CK 조사는 ck-research 다.
---

# CK 조사 — 판별기 라벨 실험판

**실험이다.** 써 보고 별로면 통째로 지운다([지우기](#지우기)). 기존 [ck-research](../ck-research/SKILL.md)는 그대로다.
판별기 설계·시험 기록: [docs/CK-LOCAL-DETECTOR.md](../../../docs/CK-LOCAL-DETECTOR.md).

로컬 판별기는 **라벨만 단다** — 화면 종류(밴픽·게임 중·결과창·게임 방·FC 경기)와 결과창 후보. 판단하지 않는다.
결과창인지·몇 판인지·같은 판인지·내 게임인지 남의 방송인지·대상 경기인지는 **Claude 가 원본을 보고** ck-research 규칙으로 정한다.
라벨은 틀릴 수 있다. 라벨이 없다는 것은 "없음"의 근거가 아니다.

## 흐름

**0. 준비물** — 프롬프트의 `PREP: ck-local run_id=…` 가 `out/ck/<번호>/local/scan.json` 의 `run_id` 와 같으면 그걸 쓴다.
단일 VOD 면 직접: `npm run ck:local -- --vod <번호>` (6시간 VOD 약 1분). 끝나기 전에 다른 SOOP 도구를 시작하지 않는다.
준비 실패·종료 코드 2 면 **ck-research 로 조사하고 끝.** 종료 코드 3 은 VOD 를 못 찾은 것 — ck-backfill 접근 불가 규칙으로 확인한다.

**1. 이전 기록** — 백필이 제공한 `resume.json` 또는 `ck:backfill context --vod <번호>`부터 읽는다. 부족한 후보 근거·질문은 `ck:record --lead vod:<번호>`로 조회한다. `ck:merge --find-match --vod <번호>` (예측 위치가 있으면 그 경기는 그 위치도 본다).

**2. 구간 지도 + 개요 몽타주 — 최초 조사에서는 둘 다 본다.**
동일 VOD의 재개에서는 앞 세션에 실제로 확인했다고 기록된 범위·경기를 재사용한다. 준비된 이미지 목록만으로 읽음을 가정하지 않는다.
처리한 경기까지 전부 다시 열지 않고, 미확인 범위와 남은 질문에 필요한 원본부터 본다. 다른 VOD의 새 시점은 별도로 판독한다.
칼바람 내전도 수집한다. ck-research의 수집 모드 규칙대로 `game_mode: "ARAM"`을 명시해 일반 CK 집계와 분리한다.
랜드(매 판 팀을 섞음)·보너스 판(본게임 뒤 범인찾기 등)은 ck-research의 "진행 방식" 규칙대로 낸다 — `event.kind: "land"` + 묶음 `series_id`, 보너스는 앞 시리즈에 `set_role: "bonus"`.
- 지도: `out/ck/<번호>/local/map.txt` (준비 출력에도 있다). 예:
  ```
  0:06:09~0:13:24 밴픽
  0:14:39~0:44:27 게임 중
    0:44:36~0:45:21 결과창 (후보 #3,#4)
  ```
- 개요: 최초 조사에서는 `overview-*.jpg`(2분 칸 전체, 결과창 후보 근처는 분홍 테두리)를 **전부** 연다. 재개 시에는 위에 적힌 실제 확인 기록을 따른다.
  **지도는 요약본이다** — "모름"·"롤 아님"·2분 미만 게임 구간은 빠져 있다. 지도만 보고 넘어가지 않는다.
- 둘을 맞춰 **확인할 곳 목록**을 만든다:
  ① 결과창 후보(번호 있음) ② 지도의 결과창·그래프 구간인데 후보 번호가 없는 곳
  ③ 지도의 "게임 중" 구간인데 뒤에 결과창 후보가 없는 곳 ④ **개요에서 롤로 보이는데 지도·후보에 없는 구간**
- 목록이 비고 개요에도 롤이 없으면 → 4단계. 하나라도 있으면 → 3단계.

**3. 롤이 있으면 — 이때 ck-research 의 「경기 추적」「입력 창구」「결과 화면을 찾는 기본 방법」「같은 경기의 다른 시점」을 읽는다.**
1. `candidates-*.jpg`(후보 몽타주, `#번호 시각`)를 열어 결과창으로 보이는 후보를 고른다. 같은 판을 다시 연 후보끼리 묶는다.
2. 고른 후보의 원본(`scan.json` 의 `candidates[].frame`, 이미 받아 둠)을 열어 판독한다.
   이름 열을 2배로 자른 확대본이 있으면(`candidates[].names`) 닉네임은 그걸로 읽는다. 근거 프레임은 원본이다.
   가렸으면 ck-research 「가려진 결과창의 앞쪽 보완 탐색」(`ck:probe --between`).
3. **결과창에서 먼저 읽는다.** 필요한 값이 안 보이거나 **대상 여부(CK·솔랭 등)·경기 경계·같은 경기인지가 불명확하면**
   지도의 밴픽 구간·로비·인게임 원본으로 보충한다(`ck:probe --at <초>`). 포지션은 결과창에 없다.
4. 목록의 ②③④는 띠로 본다: `npm run ck:local -- --vod <번호> --strip <시작>~<끝>` (모델 없음, 몇 초).
   결과창이 있으면 2처럼 읽고, 없으면 ck-research 결과창 탐색(원본 5분할)으로 간다.
   리플레이는 ck-research 대로 판단한다. **남의 방송 화면(남의 방송을 띄운 화면)은 방송 주인이 그 경기·같은 시리즈·같은 대회의 참가자일 때만** `source: rebroadcast` 근거로 쓴다(2026-10-09 사용자 결정) — 자기 시리즈의 상대·팀 방송으로 결과를 받는 건 괜찮다(팀은 화면에 보인 대로 적으면 도구가 사람 기준으로 맞춘다). **방송 주인과 무관한 방송**(대기 중 남의 경기 시청, 남들끼리 CK 시청)은 경기를 만들거나 시점·값을 더하지 않는다 — 후보를 `not_target` 으로 닫고 관찰에 "누구 방송(주소창의 채널)을 몇 시에 보고 있었다"만 남긴다. 자기 판은 같은 파일에서 먼저 낸다(그래야 같은 시리즈의 남의 화면이 통과한다). `ck:merge` 가 무관한 방송 제출을 거부한다.

**롤 게임 구간마다 결론을 남긴다**(ck-research: 대상 밖도 근거와 함께 닫는다). 대상 경기가 아니면(솔랭·LCK 시청 등)
무엇을 보고 그렇게 판단했는지 `not_target` 후보의 `observed`·`why` 에 적는다. 롤이 아닌 헛짚음(FC·전적 사이트 후보)은
DB 후보로 넣지 않고 5단계 `--verdicts` 로만 남긴다. `--finish` 가 결론 없는 게임 구간을 경고로 보여준다(막지는 않는다).

**대상 여부(솔랭·CK 등) 판정은 지금은 화면 근거로 한다** — LP 위젯, 결과창·전적 사이트의 큐 표기(개인/2인 랭크 등), 로비.
라이엇 공개 큐 기록과의 대조는 전용 조회 명령이 생기면 그 명령으로 한다. 그 전엔 DB 조회 스크립트를 새로 짜지 않는다.

**4. 롤이 없으면** — 파일 끝 원본(`scan.json` 의 `file_tails[].frame`)을 연다(개요는 2단계에서 이미 봤다).
지도의 **FC 경기** 구간은 롤 조사 대상이 아니다. 원본으로 FC 화면을 **실제로 열었으면** ck-research 대로 단서를 한 번 남긴다
(`npm run fco:context -- clue --vod <번호> --at <초> --observed "본 것"`) — FC 조사가 어느 VOD 를 볼지 찾는 경로는 아직 이 단서다.

**롤 유무와 상관없이** `scan.json` 의 `failed`(썸네일을 못 받은 범위)는 ck-research 훑기로 원본을 본다.

**5. 후보 판정 — 판별기가 배우는 자료다. 한 줄로:**
`npm run ck:local -- --review --vod <번호> --run <run_id> --verdicts 3:result,4:result,5:other,6:graph --seen <실제로_연_각_후보_peak_초>`
(`result` 결과창 점수판 · `graph` 결과창 다른 탭 · `ingame` · `client` · `other` 전적 사이트·FC·방송 그래픽 등). 연 후보만 적는다. `--seen`에는 실제로 연 원본의 VOD 전체 초를 쉼표로 나열한다. 파일 존재도 검사하며 전체 라벨 검증을 마친 뒤 기록한다. 몽타주만 보고 원본을 안 연 후보는 확정 라벨로 넣지 않는다.
판별기가 **놓친 결과창**이나 **지도 라벨이 틀린 곳**은 시각으로 같이 남긴다(같은 명령에 붙여도 된다):
`--label 1:23:45=result,0:57:51=lobby --seen 5025,3471` (라벨: result·graph·banpick·lobby·client·ingame·end·other — 해당 시각 원본을 직접 열어 확인한 것만)

**6. 기록 — 초안은 도구가 조립한다.**
```bash
npm run ck:local -- --finish --vod <번호> --run <run_id> --opened <연 원본 초,…> \
  [--result-frames <결과창 원본 초,…>] [--resolved <시작-끝,…>] [--status done|running] [--games out/ck/<번호>/local/games.json] [--resume <짧은_인계_JSON>] [--note "본 것·라벨이 틀린 곳"]
npm run ck:merge -- --result out/ck/<번호>/local/final.json
```
- 경기마다 저장한다. 다음 세션에는 DB 저장이 확인된 결과를 다시 제출하지 않고 이번에 새로 읽거나 정정한 결과만 넘긴다.
- 백필의 이미지 예산 안내를 받으면 지금까지의 관찰·미해결 질문을 저장하고 종료한다. 필수 탐색이 남으면 `running`과 `scan.resume`를 남기며, 이미 필수 수행을 끝냈으면 아래 `done` 조건을 따른다. 이미지 차단 뒤에는 새 탐색을 하지 않는다. JSON은 `out/ck/<번호>/` 아래에 Write/Edit로 작성하고, 저장·조회 Bash 명령은 한 번에 하나씩 실행한다.
- 개요만 확인해 `--opened` 원본이 없으면 `--finish`에 가짜 시각을 넣지 않는다. 기존 `resultType: "scan"` 입력을 `ck:merge`로 저장하고, 개요 확인 내용은 `scan.note`·다음 행동은 `scan.resume`에 남긴다. 부분 기록은 `running`이며 이미지 한도는 완료 조건이 아니다.
- 경기가 있으면 `games.json` 에 **읽은 결과만** 쓴다: `{"candidates":[ck-research 후보…], "results":[match·identify…]}` (형식은 ck-research 「입력 창구」).
- `opened` 는 원본을 연 시각만이다(이 실험의 정책). `status: done` 조건은 ck-research 그대로.
- **탐색 완료와 값 확정을 구분한다.** 전 범위 필수 탐색·가려진 결과창 보완·교차검증 처리를 마쳤으면 큐 종류·신원·승패가 미해결이어도 후보와 질문을 보존하고 `done`으로 저장한다. 완료 전 후보별 확인 구간·탐색 종료 사유·교차검증 시도와 한계를 확인한다. 아직 할 탐색이 있으면 `running`과 구체적인 다음 위치·행동을 남긴다. 예산 소진·추가로 볼 것이 없다는 메모만으로 완료하지 않는다.
- 재개 요약의 `completion_policy`를 적용한다. 이전 메모가 ‘미해결이라 사용자 판단 전까지 완료 불가’라고 해도 사실·근거와 완료 판단을 분리한다. 미해결을 억지로 `not_target`으로 바꾸거나 삭제하지 않는다.
- **남의 방송 화면(남의 방송을 띄운 화면)은 방송 주인이 그 경기·같은 시리즈·같은 대회의 참가자일 때만** `source: rebroadcast` 근거로 쓴다(2026-10-09 사용자 결정) — 자기 시리즈의 상대·팀 방송으로 결과를 받는 건 괜찮다(팀은 화면에 보인 대로 적으면 도구가 사람 기준으로 맞춘다). **방송 주인과 무관한 방송**(대기 중 남의 경기 시청, 남들끼리 CK 시청)은 경기를 만들거나 시점·값을 더하지 않는다 — 후보를 `not_target` 으로 닫고 관찰에 "누구 방송(주소창의 채널)을 몇 시에 보고 있었다"만 남긴다. 자기 판은 같은 파일에서 먼저 낸다(그래야 같은 시리즈의 남의 화면이 통과한다). `ck:merge` 가 무관한 방송 제출을 거부한다.
- 썸네일을 못 받은 범위(`failed`)를 원본으로 메웠으면 `--finish ... --resolved <시작-끝,…>` (VOD 전체 초)로 넘긴다.
  도구가 이번 `scan.failed` 에서 빼고 `scan.resolved_failed` 에도 넣는다 — 이미 DB 에 저장된 실패까지 닫으려면 둘 다 필요하다.
- 마지막에 `npm run ck:local -- --review --vod <번호> --run <run_id> --merged done|running|failed --note "…"` (실험 장부).

**하지 않는 것**: `npm test` (코드를 안 바꾼 조사다), 롤이 없는 VOD 에서 ck-research 전체 읽기, 초안 JSON 손 조립.

보고: 찾은 경기 · 후보 수와 진짜 결과창 수 · 라벨이 틀린 곳 · 연 이미지 수.

## 여러 VOD (백필)

```bash
scripts/ck-backfill.sh --streamer <이름> --from YYYY-MM-DD --to YYYY-MM-DD --session-games 5
```

준비는 백필 잠금 안에서 Claude 세션 **전에** 직렬로 돈다(중단하면 같이 멈춘다). 진척·멈추기는 [ck-backfill](../ck-backfill/SKILL.md)과 같다.

## 판별기 다시 학습

**작업 반복만으로 모델이 갱신되지는 않는다.** 다음 명령을 실행해야 학습한다. 운영 모델을 직접 덮지 않고 후보 디렉터리에 저장한다.
5단계 판정이 쌓이면(예: 새 판정 200개마다, 또는 라벨이 자주 틀릴 때) 다시 학습한다. 몇 분 걸린다.

```bash
PY=out/ck-detector/venv/bin/python
node --env-file-if-exists=apps/web/.env.local scripts/ck-local/detector/collect.mjs --vods <판정한 VOD 들>
$PY scripts/ck-local/detector/embed.py --model siglip
$PY scripts/ck-local/detector/augment.py --model siglip         # 늘려 보기 변형
$PY scripts/ck-local/detector/train.py fit --model siglip --output-dir out/ck-detector/candidates/reviewed       # 결과창 후보 판별기 — dev AP 를 이전과 비교
$PY scripts/ck-local/detector/train.py games --model siglip --output-dir out/ck-detector/candidates/reviewed     # 판 단위 — 놓친 판이 늘면 적용하지 않는다
$PY scripts/ck-local/detector/multi.py eval && $PY scripts/ck-local/detector/multi.py fit --output-dir out/ck-detector/candidates/reviewed   # 화면 종류 라벨
```

운영 판별기 파일은 `out/ck-detector/model/siglip/{clf,multi}.npz`이며 위 명령으로 바뀌지 않는다.
후보를 같은 평가 자료에서 비교하고, 놓친 경기와 오탐을 확인한 후 운영 파일을 백업하고 명시적으로 적용한다.
현재 binary 시험 분할에는 같은 채널의 다른 VOD가 학습에 들어간 이력이 있어 새 채널 일반화 검증으로 부르지 않는다.
지도용 leave-one-channel-out 평가도 배포 후보 모델 자체의 독립 평가와 다르다. 라벨 축적만으로 개선됐다고 보고하지 않는다.

## 지우기

남는 것: 공용 시간축 수정(`scripts/lib/vod-timeline.mjs`, `scanSheets`·`ck-probe` 전환, `verify-sheet-axis.mjs`) — 기존 도구의 결함 수정이라 지우지 않는다.
실행기 기본이 ck-local이므로 삭제 전 자동·수동 실행기를 ck-research로 되돌리고 준비 명령을 끈다.

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
