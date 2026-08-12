/**
 * 챔피언 **한글 이름 → 챔피언 ID**.
 *
 * 표 자체는 `champions.ko.json` 이고 Riot Data Dragon 에서 생성한다
 * (`npm run build:champions`). 여기서는 **읽는 방법**만 정한다.
 *
 * ★ 왜 이름으로 찾나
 *   내전은 Riot API 로 조회가 안 되므로 방송 **결과 화면을 읽어** 넣는다.
 *   화면에 있는 건 한글 이름뿐이다. ID 를 사람이 옮겨 적으면 반드시 틀린다 —
 *   실제로 '제리' 를 895 로 쓸 뻔했고 정답은 221 이었다. 조용히 다른 챔피언
 *   전적이 되는 종류의 실수라 사람 손을 아예 뺀다.
 *
 * ★ 띄어쓰기는 무시한다
 *   화면에서 읽어 적을 때 '리 신' 을 '리신' 으로, '자르반 4세' 를 '자르반4세' 로
 *   쓰는 일이 잦다. 그것 때문에 판독이 실패하면 사람만 지친다.
 *   대신 **모르는 이름은 조용히 넘기지 않고 null 을 준다** — 호출부가 거부한다.
 */

import table from "./champions.ko.json" with { type: "json" };

export interface Champion {
  id: number;
  /** 한글 이름 (Data Dragon ko_KR) */
  name: string;
  /** 영문 키 (`MissFortune`). match-v5 의 championName 과 같은 값이다. */
  en: string;
}

export const CHAMPIONS: Champion[] = table.champions;
export const CHAMPION_DATA_VERSION: string = table.version;

/** 띄어쓰기·대소문자를 지운 조회 키. '리 신' 과 '리신' 이 같아진다. */
const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();

const byName = new Map<string, Champion>();
for (const c of CHAMPIONS) {
  byName.set(norm(c.name), c);
  byName.set(norm(c.en), c);   // 영문으로 적어도 받는다
}
const byId = new Map<number, Champion>(CHAMPIONS.map((c) => [c.id, c]));

/**
 * 한글(또는 영문) 이름으로 챔피언을 찾는다. **모르면 `null`** — 0 이나 추측을 돌려주지 않는다.
 * 0 은 '모른다' 라는 뜻으로 이미 쓰이고 있어서(champion_stat 이 걸러낸다),
 * 여기서 0 을 내면 오타가 '알 수 없는 챔피언' 으로 조용히 저장된다.
 */
export function championByName(name: string): Champion | null {
  return byName.get(norm(name)) ?? null;
}

export function championIdByName(name: string): number | null {
  return championByName(name)?.id ?? null;
}

export function championById(id: number): Champion | null {
  return byId.get(id) ?? null;
}
