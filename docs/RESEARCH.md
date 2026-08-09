# 사전 리서치 — 경쟁 지형 · 데이터 소스 · 법적 제약

조사일 2026-08-08. 이 문서는 **설계를 좌우한 사실들**만 담는다.
추측과 확인된 사실을 구분해서 적었다 — `[확인]` / `[추정]` 태그.

---

## 1. 경쟁 지형 — 이미 하는 곳이 있다

| 사이트 | 대상 | 하는 것 | 우리와 겹치는가 |
|---|---|---|---|
| **lolsoop.com** | SOOP | "롤 스트리머 전적 검색", 스트리머 솔로랭크 랭킹 | 프로필·랭킹 겹침 |
| **sooplol.com** | SOOP | "롤 스트리머 & 대회 정보" (Cloudflare 뒤 React SPA) | 프로필·대회 겹침 |
| **덥덥미 (wwme.kr)** | 치지직 | 팔로워 1만+ 채널 솔랭 리더보드. 티어/대표계정/라인/승패/모스트3/연승연패/일간 순위변동. 매일 09시 갱신 | 랭킹 겹침 |
| **deeplol.gg** | 전체 | 스트리머·프로 매치 분석, "2026 SOOP 멸망전" 페이지 운영 | 대회 겹침 |

`[확인]` 덥덥미는 **"대표 계정 = 해당 시즌 판수가 가장 많은 등록 계정"** 이라는 규칙을 쓴다.
`[확인]` "등록된 계정 중"이라는 표현 → 이 사이트들도 결국 **수동/제보 기반 계정 DB**를 굴리고 있다.

### 결론: 차별점은 "관계 데이터"다

위 사이트들은 전부 **개인 전적의 나열**이다.
**스트리머 A ↔ B 사이의 상대전적 · 맞라인 · 상성 · 케미**를 다루는 곳은 조사 범위에서 없었다.

> 이게 이 프로젝트의 해자다. 프로필 페이지를 먼저 만들더라도
> **프로필 안에 "이 사람이 만난 스트리머" 훅을 반드시 심어서**
> 프로필 → 1:1 상대전적으로 넘어가게 만들어야 한다.
> 프로필만 예쁘게 만들면 lolsoop의 열화판이 된다.

---

## 2. 계정 매핑 — "SOOP 스트리머 → Riot ID" 공개 데이터셋은 없다

### 확인한 소스

- `[확인]` **OP.GG 공식 MCP 서버** — `https://mcp-api.op.gg/mcp` (Streamable HTTP, MIT, opgginc 공식).
  `lol_get_pro_player_riot_id` 툴 존재. 다만 **프로게이머** 대상이라 순수 스트리머는 커버가 얇을 것.
  `lol_get_summoner_profile`, `lol_list_summoner_matches` 등도 있음 → **대조 검증용**으로 유용.
- `[확인]` **op.gg 프로 태그는 유저 제보 기반**. 등록 폼이 따로 있다 (help.op.gg).
- `[확인]` **lolpros.gg** — 유럽 중심 프로/세미프로 계정 DB. 공식 API 없음. 서드파티 래퍼(parse.bot, PyPI `lolpros-parser`)만 존재.
- `[확인]` Riot API에는 스트리머·프로 식별 정보가 **일절 없다**. Riot ID만 있다.

### 채택 전략 — 3단 하이브리드

**1단 · 부트스트랩 (수동, 30~50명)**
대상 스트리머를 손으로 큐레이션한다. **반드시 근거를 남긴다** —
방송에서 밝힌 클립 URL, 공지, 커뮤니티 글. `streamer_account.evidence` (jsonb)에 저장.

**2단 · 자동 확장 (후보 발굴)**
`spectator-v5`로 등록된 스트리머의 현재 게임을 조회 → 같은 로비의 나머지 puuid를 **후보 큐**에 적재.
스트리머들은 서로 내전을 하므로 **한 명을 알면 주변이 줄줄이 나온다.**
자동 등록은 절대 안 한다. 관리자 승인 큐를 거친다.

**3단 · 크라우드소싱**
제보 폼 + 관리자 검수. 근거 URL 필수 입력.

**최종 검증 (선택, 나중)**
Riot RSO로 본인 로그인 → `confidence = 'verified'` 뱃지. 신뢰도 최상.

### 하지 않을 것

> **타 사이트 자동 스크래핑 금지.**
> op.gg / lolsoop / 덥덥미 ToS 위반이고, Riot Production Key 심사에서도 감점 요인이다.
> "수동으로 참고해서 시드를 만든다"와 "봇으로 긁는다"는 완전히 다른 행위다.
> sooplol.com의 robots.txt는 Content-Signal 정책까지 명시해 두었다.

---

## 3. Riot API 제약 — 설계를 바꾼 3가지

### 3-1. `[확인]` 커스텀 게임(내전)은 API로 사후 조회가 **불가능**

프라이버시 정책상 match-v5 매치 목록에서 커스텀 게임은 아예 제외된다.
유일한 예외가 **토너먼트 코드로 생성된 게임** → [TOURNAMENT-CODE.md](TOURNAMENT-CODE.md) 참조.

`[추정]` Riot이 외부 RSO 기반으로 "플레이어가 본인 커스텀 게임 데이터 공개를 허용"하는 방향을 검토 중이라는 언급이 있으나, 시점·형태 불명. **기대하고 설계하지 말 것.**

→ **결론: 이미 지나간 내전은 API로 못 살린다.** 앞으로의 내전은 우리가 토너먼트 코드 발급자가 되어야 잡힌다.

### 3-2. `[확인]` 과거 데이터는 사라진다 — 백필은 시한부다

match-v5 데이터 보존은 **명목상 2년**.
`[확인]` 실제로는 1년 만에 삭제됐다는 버그 리포트가 Riot developer-relations 이슈로 올라와 있다
(`/matches/{matchId}` data deleted after 1 instead of 2 years).
`[확인]` 매치 ID 목록은 **이미 삭제된 경기의 ID도 반환한다** → 상세 조회 시 404. 정상 케이스로 처리해야 한다.

→ **명단이 확정되는 즉시 백필을 최우선으로 돌린다.** 오늘 안 긁으면 영영 없다.

### 3-3. `[확인]` 과거 시즌 티어/커리어는 API에 없다

league-v4는 **현재** 랭크만 준다. 과거 시즌 최고 티어, 대회 성적, 팀 이력 — 전부 없다.

→ 커리어 탭은 두 영역으로 **명확히 분리**한다:
- **관측 데이터** — 우리가 `rank_snapshot`을 쌓기 시작한 시점 이후. 진짜다.
- **수기 데이터** — 그 이전. 화면에 `수기` 뱃지를 달아 구분한다. 숨기지 않는다.

---

## 4. API 키 · 레이트리밋

| 키 종류 | 리밋 | 비고 |
|---|---|---|
| Development | 20 req/s, 100 req/2min | **24시간마다 만료** — 운영 불가 |
| Personal | 상향 (앱별 상이) | 개인 프로젝트용, 신청 필요 |
| Production | 500 req/10s, 30,000 req/10min | `[추정]` 앱마다 협의. Tournament API는 여기 붙는다 |

`[확인]` Production Key 승인 요건: **동작하는 사이트/프로토타입 URL + 유저 플로우 설명**.
기획 단계에서도 신청은 가능하나, 공개 가능한 수준이 되기 전엔 승인되지 않는다.

**메서드별 리밋(method rate limit)이 앱 리밋과 별개로 존재한다.** 두 개를 동시에 지켜야 한다.

### 백필 비용 추산 (스트리머 100명 · 계정 200개 가정)

| 항목 | 계산 | 호출 수 |
|---|---|---|
| 매치 ID 목록 | 200계정 × 2년치 600경기 ÷ 100 | ~1,200 |
| 매치 상세 | 유니크 매치 ~100,000 | ~100,000 |
| **합계** | | **~101,200** |

- Development key(100 req/2min): 100,000 ÷ 100 × 2분 ≈ **33시간**
- Production key(30,000 req/10min): ≈ **34분**

→ Personal key만 있어도 **며칠이면 백필이 끝난다.** 병목은 키가 아니라 명단이다.

**단, 타임라인(`/timeline`)은 경기당 1~5MB다.** 전량 수집하면 수백 GB.
→ **타임라인은 "스트리머 2명 이상이 만난 경기"에만 선택적으로 받는다.** (설계 핵심 결정)

---

## 5. 정적 데이터

- **Data Dragon** `https://ddragon.leagueoflegends.com` — 챔피언/아이템/룬 이름·아이콘. 무료, 레이트리밋 없음, 버전별 URL.
- **Community Dragon** — DDragon에 없는 에셋 보완.
→ 우리 서버에 버전 고정으로 캐싱하고 패치마다 갱신한다. 런타임 의존 금지.

---

## 6. 법적 · 윤리 체크리스트

**Riot**
- [ ] "isn't endorsed by Riot Games" 고지 문구 (푸터)
- [ ] 서비스명에 Riot 상표 직접 사용 주의 ("SOOP LOL"은 `[추정]` 회색지대 — 로고/폰트는 확실히 금지)
- [ ] 데이터 유료 판매 금지. 광고는 일반적으로 허용
- [ ] Dev key로 공개 운영 금지 (24h 만료)

**개인정보 — 이게 제일 위험하다**
- [ ] **부계정 노출은 실제 분쟁이 된다.** 스트리머가 밝히지 않은 계정을 우리가 붙이면 사고다.
- [ ] 원칙: **본인이 공개적으로 밝힌 계정만 등록.** 근거 URL 없으면 등록하지 않는다.
- [ ] 스트리머 본인의 삭제/숨김 요청 경로를 **처음부터** 만든다 (`visibility` 플래그 + 문의 창구)
- [ ] `confidence` 등급을 화면에 노출한다. `unverified`를 확정처럼 보여주지 않는다.

**타 서비스**
- [ ] 자동 스크래핑 금지 (§2 참조)
- [ ] SOOP 프로필 이미지 핫링크 대신 자체 캐싱 (`[추정]` 핫링크 차단 가능성)

---

## 출처

- [League of Legends — Riot Developer Relations](https://support-developer.riotgames.com/hc/en-us/articles/22698698001939-League-of-Legends)
- [Tournament V5 Is Here | Riot Games](https://www.riotgames.com/en/DevRel/tournament-v5-is-coming)
- [Riot Developer Portal — LoL Docs](https://developer.riotgames.com/docs/lol)
- [Riot Games Developer Policies](https://developer.riotgames.com/policies/general)
- [Info About Specific Data — Riot API Libraries](https://riot-api-libraries.readthedocs.io/en/latest/specifics.html)
- [Your Application — Riot API Libraries](https://riot-api-libraries.readthedocs.io/en/latest/applications.html)
- [BUG: match data deleted after 1 instead of 2 years](https://github.com/RiotGames/developer-relations/issues/902)
- [BUG: match-v5 by-puuid ids returning no-longer-existing games](https://github.com/RiotGames/developer-relations/issues/868)
- [OP.GG MCP Server](https://glama.ai/mcp/servers/@opgginc/opgg-mcp/blob/3deb7939797a8fca0be7ce57513ebc6227df5256/README.md)
- [How to register a pro player tag — OP.GG Help](https://help.op.gg/hc/en-us/articles/30785969467161-How-to-register-a-pro-player-tag)
- [LOLPros.GG FAQ](https://lolpros.gg/about/faq)
- [덥덥미 — 치지직 스트리머 솔로랭크 리더보드](https://wwme.kr/lol/leaderboard)
- [LOLSOOP — 롤 스트리머 전적 검색](https://lolsoop.com/)
- [SOOPLOL — 롤 스트리머 & 대회 정보](https://sooplol.com/)
- [SOOP Developers — Open API](https://developers.sooplive.co.kr/?szWork=openapi)
