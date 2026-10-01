"use client";

import Link from "next/link";
import { useState } from "react";
import {
  championById, championIconPath, POSITION_LABEL, profileHref, type MatchOutcome, type PublicRosterEntry,
} from "@soop-lol/core/lib/contract";
import {
  participantKey, participantKda, teamPlayers, type MatchDetailSet,
} from "./match-details-model.ts";

const OUTCOME_LABEL: Record<MatchOutcome, string> = { win: "승", draw: "무", loss: "패", unknown: "?" };

/**
 * One expansion body for personal history and versus history.
 *
 * `streamerId` 는 **어느 줄이 기준 스트리머인가**에만 쓴다. 예전엔 여기에 상대전적 링크를
 * 만들려고 slug·versusPath·기간 필터까지 통째로 받았는데, 그 링크를 걷어내면서 같이 지웠다.
 */
export function MatchDetails({ sets, streamerId, highlightedStreamerIds = [] }: {
  sets: MatchDetailSet[];
  streamerId: string;
  highlightedStreamerIds?: string[];
}) {
  const [selectedId, setSelectedId] = useState(sets[0]?.matchId);
  const selected = sets.find((set) => set.matchId === selectedId) ?? sets[0];
  if (!selected) return <p className="match-details-empty">세트 기록이 없습니다.</p>;

  return (
    <div className="match-details" data-match-id={selected.matchId}>
      <div className="match-details-toolbar">
        <div className="match-details-sets" role="group" aria-label="세트 선택">
          {sets.map((set) => {
            const me = set.players.find((player) => player.streamer_id === streamerId);
            return (
              <button key={set.matchId} type="button" aria-pressed={selected.matchId === set.matchId}
                onClick={() => setSelectedId(set.matchId)}>
                {set.label}
                {me && <span data-outcome={me.outcome}>{OUTCOME_LABEL[me.outcome]}</span>}
              </button>
            );
          })}
        </div>
        <span className="match-details-stat-label">K / D / A</span>
      </div>
      <div className="match-details-teams">
        {[100, 200].map((teamId) => {
          const players = teamPlayers(selected.players, teamId);
          const side = teamId === 100 ? "블루" : "레드";
          const name = players.find((player) => player.team_name)?.team_name;
          return (
            <section className="match-details-team" key={teamId}
              data-side={teamId === 100 ? "blue" : "red"} aria-label={`${side} 팀`}>
              <h4>
                <span className="match-details-side">{side}</span>
                <strong>{name ?? "팀"}</strong>
                {players.length > 0 && (
                  <span className="match-details-outcome" data-outcome={players[0].outcome}>
                    {OUTCOME_LABEL[players[0].outcome]}
                  </span>
                )}
              </h4>
              {!players.length ? <p className="match-details-empty">확인된 참가 정보가 없습니다.</p> : (
                <ul>
                  {players.map((player) => (
                    /* ⚠ 키에 streamer_id 를 쓰면 안 된다 — 미확인 자리는 NULL 이고,
                       한 경기에 둘이면 키가 겹친다(0022). 자리 번호가 유일하다. */
                    <MatchPlayer key={participantKey(player)}
                      player={player} streamerId={streamerId}
                      highlighted={player.streamer_id != null && highlightedStreamerIds.includes(player.streamer_id)} />
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

/** 한 줄 = 포지션 · 챔피언 아이콘 · 스트리머명 · 챔피언명 · KDA. 이 다섯 칸이 전부다. */
function MatchPlayer({ player, streamerId, highlighted }: {
  player: PublicRosterEntry;
  streamerId: string;
  highlighted: boolean;
}) {
  const champion = championById(player.champion_id);
  const championName = champion?.name ?? player.champion_name ?? "챔피언 미상";
  const isMe = player.streamer_id === streamerId;

  return (
    <li className="match-details-player" data-highlighted={isMe || highlighted}>
      <span className="match-details-position">
        {player.team_position ? POSITION_LABEL[player.team_position] ?? "—" : "—"}
      </span>
      <span className="match-details-champion-icon" title={championName} aria-hidden="true">
        ?
        {champion && (
          <img src={championIconPath(champion)}
            alt="" loading="lazy" onError={(event) => { event.currentTarget.hidden = true; }} />
        )}
      </span>
      {/* ★ 사람을 못 붙인 자리는 화면에서 읽은 인게임명으로 선다(0022).
          링크를 걸 곳이 없으므로 이름만 둔다 — 자리를 비우면 5대5 가 4명이 된다. */}
      {player.slug ? (
        <Link className="match-details-name" href={profileHref("lol", player.slug)}
          title={player.display_name ?? ""}>
          {player.display_name}
        </Link>
      ) : (
        <span className="match-details-name match-details-unidentified" title="아직 사람을 확인하지 못한 자리입니다">
          {player.observed_name ?? "미확인"}
          <em>미등록</em>
        </span>
      )}
      <span className="match-details-champion-name" title={championName}>{championName}</span>
      <span className="match-details-kda">{participantKda(player)}</span>
    </li>
  );
}
