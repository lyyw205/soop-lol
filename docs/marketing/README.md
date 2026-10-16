# 마케팅 진행 장부

> "마케팅 이어서 하자 / 지금 할 거 알려줘" 라고 하면 **이 파일의 '다음 할 일'부터** 이어 간다.
> 도구: Claude Code 플러그인 `marketing-skills`(coreyhaines31/marketingskills, 2026-10-15 설치). 스킬 원문: `~/.claude/plugins/marketplaces/marketingskills/skills/<이름>/SKILL.md`.
> 공통 기초 문서: `.agents/product-marketing.md`(버전·변경 기록 포함) — 모든 마케팅 스킬이 먼저 읽는다.

## 진행 순서와 상태 (마지막 갱신 2026-10-15)

| 단계 | 스킬 | 상태 | 산출물 |
|---|---|---|---|
| 1-1 기초 문서 | product-marketing | ✅ v6 | `.agents/product-marketing.md` |
| 1-2 경쟁사 | competitor-profiling | ✅ 8곳 | `competitor-profiles/` (`_summary.md` 먼저) |
| 1-3 고객 조사(롤) | customer-research | ✅ 1차 | `customer-research.md` |
| 1-4 포지셔닝 검토 | marketing-council | ✅ + 운영자 결정 | `council-2026-10-15-positioning.md` |
| 3(선행) 검색 설계 | site-architecture · programmatic-seo · seo-audit · schema · ai-seo | ✅ 설계만 | `seo-plan.md` |
| **2 전략** | **marketing-plan** (+ marketing-ideas) | ⏭ **다음** | 90일 계획(출시 전·출시·12주, 유입·첫 사용·재방문·추천, 단계별 지표) |
| 3 측정 | analytics | ⬜ | 출시 전 측정 설계(DAU·MAU·재방문율로 이어지는 중간 지표) |
| 3 문구 | copywriting | ⬜ | 첫 화면·스트리머·맞대결 페이지 문구(고객 원문 표현 사용) |
| 4 퍼뜨리기 | influencer-marketing · community-marketing · free-tools · content-strategy · social | ⬜ | 스트리머 관계 만들기(인맥 없음), 디시 갤러리, 캠공유·드래프트 도구, 데이터 분석 글 |
| 5 출시 | launch | ⬜ | 출시 일정·체크리스트 |
| 출시 후 | cro · ab-testing · referrals · marketing-loops | ⬜ | |
| 보류 | pricing · paywalls · offers · cold-email · revops · sales-enablement · prospecting · sms · emails · aso · ads | – | 팔 것·앱·영업 대상이 없어 지금 불필요 |

## 정해진 것 (운영자 결정)

- **포지셔닝:** 롤 CK 정면 승부. 차별점 = **완전 자동화로 사람이 매일 채우지 않아도 꾸준히·오래 공개**. 고객 메시지는 '빠짐없이·당일 반영·오래 남는 기록'(커버리지·반영 시간 수치로 증명).
- **유입:** 검색(SEO) 특화 — 쌍(A vs B)·날짜별 CK·대회 페이지를 자동 생성(약 2,900개 목표, 숲로그 234개).
- **광고:** 출시 후 단계적으로 하나씩. **목표 지표:** DAU·MAU·재방문율. **말투:** 담백·정확, 재미는 데이터가.
- **운영:** FC 백필 계속, **롤 자동 조사(ck-auto)는 실제 운영 전에 다시 켠다**(멈추면 차별점이 사라진다).
- 오류 신고·등록 요청 페이지는 별도로 추가 예정(출시 첫날 필요).

## 운영자가 따로 처리 중인 것 (2026-10-15 "할 만한 것 먼저 처리하고 올게")

마케팅 재개 전에 상태를 물어 확인할 것:
- [ ] SEO P0 구현 여부 — sitemap·robots·canonical·페이지별 제목/설명, `/lol/versus/{a}/{b}` 경로 + 옛 쿼리 301, 쌍 요약 파생 표·캐시, 숨김 스트리머 noindex, JS 없는 HTML 검증 (`seo-plan.md` §10)
- [ ] 도메인 구입 + 구글 서치 콘솔·네이버 서치어드바이저·다음 등록 시점 (`.com` + 443 — 토너먼트 콜백 제약)
- [ ] 네이버 검색광고 계정(무료) — 검색어 월간 검색량 확인용
- [x] AI 크롤러 — **결정(2026-10-15): AI 검색·답변(GEO)은 허용, 학습용 수집은 금지.** robots.txt `Content-Signal: search=yes, ai-input=yes, ai-train=no` + 학습봇 Disallow·403, 약관 5조. 봇 차단 전체: `apps/web/lib/bot-guard.ts`
- [ ] 롤 자동 조사 재개 시점 · 2026-01~07 롤 CK 백필(커버리지: 김민교 2026 우리 92 vs 숲로그 176)
- [ ] 출시 전 기술 체크리스트(별도): Riot 키 종류(Personal 필요), 코드 정리(브랜치·미커밋), 배포 구성, 동시 접속(M4-1), 법적 고지

## 남은 조사

- 숲스코프(soopscope.com) — 403 으로 자동 열람 불가, 사람이 브라우저로 확인
- FC 시청자 조사(포지셔닝에선 보류됐지만 FC 페이지 문구·검색어에 필요)
- 솔랭 맞대결 수요 — 근거 없음
- 검색량(네이버 키워드 도구)

## 원본 자료

- 경쟁사 화면·글 원문: `out/competitor-profiles/raw/`, `out/customer-research/raw/` (git 밖, 2026-10-15)
