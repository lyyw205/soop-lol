/**
 * 스트리머 프로필의 섹션들.
 *
 * ★ 왜 탭인가
 *   한 페이지에 아홉 섹션을 세로로 쌓았더니 스크롤이 너무 길어졌다. 상대만 65명이라
 *   그 아래(챔피언·최근 경기)는 사실상 아무도 못 본다.
 *   첫 탭에는 참여한 모든 경기의 히스토리를 두고, 상대·대회·챔피언은 별도 탭으로 본다.
 *
 * ★ 탭은 주소에 남는다(`?tab=`)
 *   클라이언트 상태로 두면 링크로 공유가 안 되고 새로고침에 사라진다.
 *   그리고 서버가 **그 탭에 필요한 것만 질의**할 수 있다 — 상대 전적 탭이 아니면
 *   경기 이력(세트 전부)을 아예 안 읽는다.
 */

import { RecordEventItem, RecordEventList, RecordSectionTabs } from "../../../packages/ui/record-structure";

import type { MatchCategoryFilter } from "@soop-lol/core/lib/metrics/category";

import type { EventRecord } from "@soop-lol/core/lib/db/public";
import type { OpponentSort } from "@soop-lol/core/lib/metrics/opponents";
import { POSITION_LABEL, type Position } from "@soop-lol/core/lib/riot/types";

import { kstYear } from "@soop-lol/core/lib/time";
import { EmptyLine } from "./public";

export const PROFILE_TABS = [
  { key: "games", label: "매치 히스토리" },
  { key: "opponents", label: "상대 전적" },
  { key: "events", label: "대회" },
  { key: "champions", label: "챔피언" },
] as const;

export type ProfileTab = (typeof PROFILE_TABS)[number]["key"];
export const DEFAULT_PROFILE_TAB: ProfileTab = "games";

export function isProfileTab(v: string | null | undefined): v is ProfileTab {
  return PROFILE_TABS.some((t) => t.key === v);
}

/** 주소를 만드는 함수. 탭을 옮겨도 연도·정렬 선택이 살아 있어야 한다. */
export type HrefFor = (next: {
  tab?: ProfileTab;
  year?: number | null;
  sort?: OpponentSort | null;
  category?: MatchCategoryFilter;
  page?: number | null;
}) => string;

/**
 * 탭 막대.
 *
 * `scroll={false}` 는 여기서도 필수다 — 탭이 화면 위쪽이라 지금은 티가 안 나지만,
 * 스크롤을 내린 상태에서 탭을 누르면 Next 가 맨 위로 올려 버린다.
 */
export function TabBar({ active, hrefFor }: {
  active: ProfileTab;
  hrefFor: HrefFor;
}) {
  return <RecordSectionTabs active={active} label="개인 기록 섹션"
    items={PROFILE_TABS.map((tab) => ({ key: tab.key, label: tab.label, href: hrefFor({ tab: tab.key }) }))} />;
}

export function EventList({ events, year }: { events: EventRecord[]; year?: number }) {
  if (events.length === 0) {
    return (
      <EmptyLine>{year ? `${year}년에 나간 대회가 없습니다.` : "아직 대회 기록이 없습니다."}</EmptyLine>
    );
  }
  return (
    <RecordEventList>
      {events.map((e) => (
        <RecordEventItem key={e.event_slug}>
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <span className="font-medium text-ink-200">
              {e.event_name}
              {/* 올스타전·이벤트 매치 — 목록엔 그대로, 우승 숫자에서만 뺀다(0052). 왜 숫자가 안 맞는지 여기서 보이게. */}
              {!e.counts_toward_titles && <span className="ml-2 text-[11px] font-normal text-ink-400">이벤트전 · 우승 집계 제외</span>}
            </span>
            <span className="text-[11px] text-ink-400">
              {e.placement && (
                <span
                  className={`mr-2 rounded px-1.5 py-0.5 ${
                    e.placement_rank === 1
                      ? "border border-amber-400/40 bg-amber-400/10 text-amber-300"
                      : "border border-ink-700 text-ink-300"
                  }`}
                >
                  {e.placement}
                </span>
              )}
              {e.team_name && <span className="text-ink-300">{e.team_name}</span>}
              {e.position && (
                <span className="ml-1">· {POSITION_LABEL[e.position as Position] ?? e.position}</span>
              )}
              <span className="ml-2">{kstYear(new Date(e.starts_at))}</span>
            </span>
          </div>
          {/*
            경기가 0건인 이유는 세 가지고, 셋은 전혀 다른 말이다.
              · 예선 탈락(99)      — 본선에 못 올라갔다. 기록이 없는 게 아니라 **없는 게 기록**이다.
              · 본선 순위가 있는데 0 — 올라갔는데 우리가 경기를 못 붙였다. 우리 쪽 구멍이다.
              · 순위 자체를 모름    — 둘 중 뭔지 우리도 모른다. 모른다고 적는다.
            한 문장으로 뭉뚱그리면 예선에서 떨어진 사람이 데이터 결함처럼 보인다.
          */}
          {e.matches === 0 ? (
            <p className="tabular mt-2 text-[11px] text-ink-400">
              {e.placement_rank === 99
                ? "예선에서 탈락해 본선 경기가 없습니다."
                : e.placement === "실격"
                  ? "실격 처리되어 본선 경기가 없습니다."
                : e.placement_rank == null
                  ? "본선 경기 기록이 없습니다 — 예선에서 탈락했는지, 우리가 경기를 못 붙였는지는 확인하지 못했습니다."
                  : "명단에는 있으나 경기 기록을 붙이지 못했습니다 — 라이엇 계정을 확인하지 못한 참가자입니다."}
            </p>
          ) : (
            <p className="tabular mt-2 text-sm text-ink-300">
              매치 {e.match_wins}승
              {e.match_draws > 0 && ` ${e.match_draws}무`}
              {" "}{e.matches - e.match_wins - e.match_draws}패
              <span className="ml-3 text-[11px] text-ink-500">
                세트로는 {e.set_wins}승 {e.sets - e.set_wins}패
              </span>
            </p>
          )}
        </RecordEventItem>
      ))}
    </RecordEventList>
  );
}
