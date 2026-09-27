"use client";

import type { CSSProperties } from "react";
import type { FcoSideView } from "@/lib/fco-match-view";

/**
 * 지표 비교 카드. 위는 "몇 개 지표에서 누가 앞섰나" 헤드라인, 아래는 분야(공격·빌드업·수비·기타)별
 * 카드 4장에 값과 비율 막대를 적는다. 데스크톱 2×2, 모바일 1열.
 */

/* ── 지표 정의 ─────────────────────────────────── */

interface Metric {
  key: string;
  group: "공격" | "빌드업" | "수비" | "기타";
  label: string;
  /** 우위 판정용 수치 */
  a: number;
  b: number;
  /** 화면 표시 문자열 */
  showA: string;
  showB: string;
  /** 비율 지표는 분수를 같이 적는다. 표본이 작으면 %가 과장되기 때문이다. */
  fracA?: string;
  fracB?: string;
  /** 파울·오프사이드·경고는 적을수록 좋다 */
  lowerIsBetter?: boolean;
  /** 막대 비율을 두 값의 합이 아니라 이 값 기준으로 (점유율처럼 합이 100인 경우) */
  share?: boolean;
}

function ratio(success: number, tries: number) { return tries > 0 ? success / tries : null; }
function pctText(value: number | null) { return value == null ? "—" : `${Math.round(value * 100)}%`; }

function sum(side: FcoSideView, key: "intercept") {
  return side.squad.reduce((total, player) => total + player[key], 0);
}

function metricsOf(a: FcoSideView, b: FcoSideView): Metric[] {
  const count = (group: Metric["group"], key: string, label: string, va: number, vb: number, extra: Partial<Metric> = {}): Metric =>
    ({ key, group, label, a: va, b: vb, showA: `${va}`, showB: `${vb}`, ...extra });
  const rate = (group: Metric["group"], key: string, label: string, sa: number, ta: number, sb: number, tb: number): Metric => {
    const ra = ratio(sa, ta), rb = ratio(sb, tb);
    return { key, group, label, a: ra ?? -1, b: rb ?? -1, showA: pctText(ra), showB: pctText(rb), fracA: `${sa}/${ta}`, fracB: `${sb}/${tb}` };
  };
  const goalsA = a.shoot.goalTotal ?? 0, goalsB = b.shoot.goalTotal ?? 0;
  return [
    count("공격", "shots", "슛", a.shoot.shootTotal ?? 0, b.shoot.shootTotal ?? 0),
    count("공격", "onTarget", "유효 슛", a.shoot.effectiveShootTotal ?? 0, b.shoot.effectiveShootTotal ?? 0),
    rate("공격", "accuracy", "슛 정확도", a.shoot.effectiveShootTotal ?? 0, a.shoot.shootTotal ?? 0, b.shoot.effectiveShootTotal ?? 0, b.shoot.shootTotal ?? 0),
    rate("공격", "finishing", "골 결정력", goalsA, a.shoot.shootTotal ?? 0, goalsB, b.shoot.shootTotal ?? 0),
    count("빌드업", "possession", "점유율", a.detail.possession ?? 0, b.detail.possession ?? 0,
      { showA: `${a.detail.possession ?? 0}%`, showB: `${b.detail.possession ?? 0}%`, share: true }),
    rate("빌드업", "passRate", "패스 성공률", a.pass.passSuccess ?? 0, a.pass.passTry ?? 0, b.pass.passSuccess ?? 0, b.pass.passTry ?? 0),
    count("빌드업", "through", "스루 패스 성공", a.pass.throughPassSuccess ?? 0, b.pass.throughPassSuccess ?? 0),
    count("빌드업", "dribble", "드리블 거리", a.detail.dribble ?? 0, b.detail.dribble ?? 0,
      { showA: `${a.detail.dribble ?? 0}yd`, showB: `${b.detail.dribble ?? 0}yd` }),
    rate("수비", "tackleRate", "태클 성공률", a.defence.tackleSuccess ?? 0, a.defence.tackleTry ?? 0, b.defence.tackleSuccess ?? 0, b.defence.tackleTry ?? 0),
    count("수비", "blocks", "블락 성공", a.defence.blockSuccess ?? 0, b.defence.blockSuccess ?? 0),
    count("수비", "intercept", "인터셉트", sum(a, "intercept"), sum(b, "intercept")),
    count("기타", "fouls", "파울", a.detail.foul ?? 0, b.detail.foul ?? 0, { lowerIsBetter: true }),
    count("기타", "cards", "경고·퇴장", (a.detail.yellowCards ?? 0) + (a.detail.redCards ?? 0), (b.detail.yellowCards ?? 0) + (b.detail.redCards ?? 0), { lowerIsBetter: true }),
    count("기타", "offside", "오프사이드", a.detail.offsideCount ?? 0, b.detail.offsideCount ?? 0, { lowerIsBetter: true }),
  ];
}

/** 0 = 왼쪽 우위, 1 = 오른쪽 우위, null = 동률이거나 비교 불가(시도 0) */
function leader(m: Metric): 0 | 1 | null {
  if (m.a < 0 || m.b < 0 || m.a === m.b) return null;
  const aBetter = m.lowerIsBetter ? m.a < m.b : m.a > m.b;
  return aBetter ? 0 : 1;
}

/** 막대 폭. 적을수록 좋은 지표도 "값의 크기"를 그대로 그린다 — 뒤집으면 숫자와 막대가 어긋나 보인다. */
function barShare(m: Metric): [number, number] {
  const a = Math.max(0, m.a), b = Math.max(0, m.b);
  const total = a + b;
  return total > 0 ? [a / total * 100, b / total * 100] : [0, 0];
}

/** 몰수 경기는 도중에 끊겨 점유율 합이 100 이 안 되는 등 지표가 비어 있다. 카드 안에서도 알린다. */
function ForfeitNote({ a, b }: { a: FcoSideView; b: FcoSideView }) {
  const side = [a, b].find((s) => s.forfeit);
  return side ? <p className="fc-cmp-forfeit">{side.name} {side.forfeit}로 끝난 경기라 끝까지 치른 경기처럼 비교할 수 없습니다.</p> : null;
}

const GROUPS = ["공격", "빌드업", "수비", "기타"] as const;

export function FcoCompare({ sides }: { sides: FcoSideView[] }) {
  const [a, b] = sides;
  if (!a || !b) return <div className="fc-empty">양쪽 참가자의 상세 기록이 없습니다.</div>;
  const metrics = metricsOf(a, b);
  const decided = metrics.map(leader);
  const winsA = decided.filter((x) => x === 0).length;
  const winsB = decided.filter((x) => x === 1).length;
  const ties = decided.length - winsA - winsB;

  return <div className="fc-cmp">
    <ForfeitNote a={a} b={b} />

    <div className="fc-cmp-hero">
      <div className="fc-cmp-count" data-side="0" data-lead={winsA > winsB}><b>{winsA}</b><span>{a.name}</span></div>
      <div className="fc-cmp-headline">
        <small>{decided.length}개 지표 중 우위</small>
        <span className="fc-cmp-pips" aria-hidden="true">
          {decided.map((x, i) => <i key={i} data-side={x ?? "tie"} style={{ "--n": i } as CSSProperties} />)}
        </span>
        <small>{ties > 0 ? `동률·비교 불가 ${ties}` : "\u00a0"}</small>
      </div>
      <div className="fc-cmp-count" data-side="1" data-lead={winsB > winsA}><b>{winsB}</b><span>{b.name}</span></div>
    </div>

    <div className="fc-cmp-groups">
      {GROUPS.map((group) => {
        const rows = metrics.filter((m) => m.group === group);
        const lead = rows.map(leader);
        const ga = lead.filter((x) => x === 0).length, gb = lead.filter((x) => x === 1).length;
        return <section className="fc-cmp-group" key={group}>
          <header>
            <h3>{group}</h3>
            <span className="fc-cmp-group-score" aria-label={`${a.name} ${ga} 대 ${b.name} ${gb}`}>
              <b data-lead={ga > gb}>{ga}</b><i>:</i><b data-lead={gb > ga}>{gb}</b>
            </span>
          </header>
          {rows.map((m, i) => {
            const [wa, wb] = barShare(m);
            return <div className="fc-cmp-row" key={m.key}>
              <div className="fc-cmp-val" data-lead={lead[i] === 0}><b>{m.showA}</b>{m.fracA && <small>{m.fracA}</small>}</div>
              <span className="fc-cmp-label">{m.label}{m.lowerIsBetter && <em>적을수록 우위</em>}</span>
              <div className="fc-cmp-val is-right" data-lead={lead[i] === 1}>{m.fracB && <small>{m.fracB}</small>}<b>{m.showB}</b></div>
              {/* 밀리는 쪽 막대는 흐리게. 적을수록 우위인 지표는 짧은 쪽이 앞선 쪽이다. 동률이면 둘 다 그대로. */}
              <span className="fc-cmp-bar">
                <i data-side="0" data-behind={lead[i] == null ? undefined : lead[i] === 1} style={{ width: `${wa}%` }} />
                <i data-side="1" data-behind={lead[i] == null ? undefined : lead[i] === 0} style={{ width: `${wb}%` }} />
              </span>
            </div>;
          })}
        </section>;
      })}
    </div>

  </div>;
}
