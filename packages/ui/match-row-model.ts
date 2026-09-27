/**
 * 접힌 경기 한 줄이 쓰는 **표시 규칙의 단일 출처**.
 *
 * ★ 왜 모았나
 *   같은 정보(날짜·대회명·스코어·승패·다전제 형식)를 세 화면이 각자 그리고 있었다 —
 *   개인 기록 매치 히스토리, 상대전적 경기 기록, 개인 기록 상대전적 탭의 확장 목록.
 *   그래서 한 곳을 고칠 때마다 나머지가 어긋났다. 실제로 겪은 것:
 *     · `BO3` 뱃지를 넣자 확장 목록만 그리드 칸이 밀려 승패가 다음 줄로 떨어졌다
 *     · 승패 판정식(`승 * 2 vs 세트 수`)이 세 벌로 복사돼 있었다
 *     · 날짜를 KST 로 고칠 때 한 화면만 UTC 로 남아 같은 경기가 다른 날짜로 보였다
 *
 *   마크업까지 한 컴포넌트로 묶지는 않는다. 세 화면은 열 구성이 서로 다르고(타임라인 유무,
 *   상대 표기, `3일 전`), 억지로 합치면 분기 투성이 컴포넌트가 된다.
 *   **판정과 문구만** 공유하고 배치는 각 화면이 정한다 — packages/ui/README.md 의 방침과 같다.
 */

export type MatchOutcomeKind = "win" | "draw" | "loss";

/**
 * 다전제의 승패. **세트 과반**을 이기면 승, 정확히 반이면 무승부다.
 * 무승부는 옛 2세트제 조별리그에서 실제로 나온다(멸망전 2014·2015·2017 에서 12건).
 * 그래서 "이긴 세트가 더 많지 않으면 패" 로 단순화하면 안 된다.
 */
export function matchOutcome(setWins: number, sets: number): MatchOutcomeKind {
  if (setWins * 2 === sets) return "draw";
  return setWins * 2 > sets ? "win" : "loss";
}

export const OUTCOME_LABEL: Record<MatchOutcomeKind, string> = {
  win: "승", draw: "무", loss: "패",
};

/**
 * 다전제 형식 뱃지 문구. `best_of` 는 **몇 판 몇 선승인가**이고 세트 수가 아니다.
 *
 * ★ `best_of = 1` 은 `BO1` 이 아니라 **"단판"** 이다. 한국어로 BO1 이라 쓰는 사람이 없고,
 *   멸망전 시드만 해도 단판 시리즈가 305건이라 그대로 두면 화면이 온통 `BO1` 이 된다.
 *   `setCountLabel(1)` 과 문구가 같으므로 어느 경로로 와도 같은 글자가 나온다.
 *
 * ⚠ 값이 없을 때 **빈 문자열을 돌려준다.** 호출부가 `{best_of && <small>}` 로 요소 자체를
 *   지우면 그리드 칸이 밀린다(실제로 승패가 다음 줄로 떨어졌다). 칸은 두고 내용만 비운다.
 */
export function bestOfLabel(bestOf: number | null | undefined): string {
  if (!bestOf) return "";
  return bestOf === 1 ? "단판" : `BO${bestOf}`;
}

/**
 * 형식을 모를 때 대신 보여줄 문구. 세트가 여럿이면 "N세트", 하나면 "단판".
 * `bestOfLabel` 이 비었을 때만 쓴다 — 둘을 같이 보여주면 같은 사실이 두 번 나온다.
 *
 * ★ 형식(`BO3`)과 세트 수(`2세트`)는 **성격이 다른 사실**이다. 앞은 규정이고 뒤는 일어난 일이다.
 *   그래도 한 칸에 같이 두는 이유는, 모를 때 칸을 비우면 읽는 사람이 "형식 미상" 인지
 *   "버그로 안 나온 것" 인지 구분할 수 없기 때문이다. 모르는 건 모른다고 적되 빈칸은 안 된다.
 */
export function setCountLabel(sets: number, standalone: boolean): string {
  if (sets > 1) return `${sets}세트`;
  // ★ 모은 세트가 하나라고 단판은 아니다 — Bo3 의 첫 판만 모았어도 하나다(0035).
  //   원래 한 판짜리(시리즈 없는 단독 경기)일 때만 단판이라 부른다.
  return standalone ? "단판" : "1세트";
}

/**
 * 형식이 있으면 형식을, 없으면 세트 수를 보여준다. **화면 세 곳이 이 함수만 쓴다.**
 *
 * ⚠ `bestOfLabel` 을 직접 부르지 마라. 형식을 모르는 줄만 칸이 비어 한 화면만 달라 보인다
 *   (실제로 상대전적 확장 목록에서 그랬다). 형식을 단독으로 쓸 자리는 지금 없다.
 */
export function formatBadge(bestOf: number | null | undefined, sets: number, standalone: boolean): string {
  return bestOfLabel(bestOf) || setCountLabel(sets, standalone);
}

/**
 * 타임라인 왼쪽 날짜 칸에 **글자를 쓸 것인가.** 같은 날 경기가 이어지면 맨 위 한 번만 쓰고,
 * 아래 줄들은 그 날짜에 딸린 것으로 읽힌다.
 *
 * ★ 왜 함수로 뺐나
 *   개인 기록 매치 히스토리에만 넣었더니 상대전적 경기 기록은 그대로 날짜를 반복했다.
 *   "같은 모양이면 같은 규칙" 이 이 화면들의 원칙이라 판정을 한 곳에 둔다.
 *
 * ⚠ 호출부는 **글자만** 감춘다. 날짜 칸 자체를 지우면 그리드 칸이 밀리고, 화면 낭독기는
 *   줄마다 날짜를 들어야 하므로 sr-only 로 남긴다.
 *
 * @param groupBroken 연도 머리글처럼 흐름을 끊는 것이 사이에 끼면 다시 쓴다.
 */
export function isRepeatedDate(date: string, previous: string, groupBroken = false): boolean {
  return !groupBroken && previous === date;
}
