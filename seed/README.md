# 시드 명단

```bash
cp seed/streamers.example.json seed/streamers.json   # 손으로 채운다
npm run seed -- seed/streamers.json --dry-run        # 무엇이 바뀔지만 본다
npm run seed -- seed/streamers.json                  # 실제로 넣는다
```

같은 파일을 다시 돌려도 안전하다. `slug` 가 이미 있으면 갱신한다.

## 규칙

1. **손으로 만든다.** op.gg·lolsoop·덥덥미를 긁어오지 않는다 —
   ToS 위반이고 Riot Production Key 심사에서도 감점이다 (docs/PLAN.md §11-9).
2. **근거 없는 계정은 적지 않는다.** `evidence.url` 이나 `evidence.note` 가 비면
   스크립트가 거부한다. 부계정 오노출은 실제 분쟁이 된다 (§11-2).
3. `confidence` 는 정직하게 매긴다.
   - `verified` — 본인이 공개적으로 밝혔고 그 출처가 남아 있다
   - `likely` — 정황은 강하지만 본인 확인은 없다
   - `unverified` — 제보만 있다
   이 값은 화면에 그대로 노출된다. 애매한 걸 `verified` 로 올리지 않는다.

## `seed/streamers.json` 은 커밋하지 않는다

저장소가 공개라서다. 스트리머의 부계정 목록이 git 히스토리에 들어가면
나중에 삭제 요청이 와도 **되돌릴 수 없다.** 히스토리는 지워지지 않는다.

근거는 DB 의 `streamer_account.evidence` 에 남고, 그쪽은 `visibility` 로 숨기거나
행을 지울 수 있다. 그게 삭제 요청 경로를 살려두는 유일한 방법이다.

파일 자체는 로컬이나 비공개 백업에 보관한다.
