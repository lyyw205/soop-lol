-- 0084 — FC 카드 시세: "오늘 받았나" 를 카드마다 한 줄로 따로 남긴다.
--
-- 무엇이 틀려 있었나
--   시세 동기화(Engine G)는 "오늘 받았나" 를 `fco_card_price_daily.fetched_at` 으로 판단했다. 그래서 받을 때마다
--   **값이 같은 과거 날짜까지** fetched_at 을 새로 찍었다 — 카드마다 최대 365줄, 매일 30만 줄 넘게 다시 썼다.
--   새 줄 버전·WAL·표 부풀림(2026-10-12 이 표 44MB, 살아 있는 데이터의 약 2배)이 그대로 쌓였고,
--   비교하려고 카드마다 이력 전체를 받아 와 하루 약 14MB 를 내보냈다(Free 전송량 5GB/월).
--
-- 어떻게
--   카드별 마지막 수집 시각은 이 표 한 줄이다. 시세 표에는 **새 날짜와 값이 바뀐 날짜만** 쓰고,
--   무엇이 새로 들어갔고 바뀌었는지는 DB 가 비교해 그 줄만 돌려준다(syncCardPrices).
--
-- ★ `fco_card_price_daily.fetched_at` 의 뜻이 바뀐다 — "이 값을 처음 받았거나 마지막으로 바뀐 것을 본 시각".
--   마지막으로 받은 시각이 아니다(그건 여기).

CREATE TABLE fco_card_price_fetch (
  spid        bigint NOT NULL,
  grade       smallint NOT NULL CHECK (grade BETWEEN 0 AND 13),
  fetched_at  timestamptz NOT NULL,
  PRIMARY KEY (spid, grade)
);
ALTER TABLE fco_card_price_fetch ENABLE ROW LEVEL SECURITY;

-- 지금까지 받은 기록을 옮긴다 — 안 옮기면 오늘 받은 카드를 다시 받는다.
INSERT INTO fco_card_price_fetch (spid, grade, fetched_at)
SELECT spid, grade, max(fetched_at) FROM fco_card_price_daily GROUP BY spid, grade;
