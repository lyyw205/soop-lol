/**
 * 게임별 감시 목록(streamer_watch)의 단일 출처. 스크립트마다 SQL 을 따로 짜지 않는다.
 * 수집 대상이지 중요도 표시가 아니다 — 훑은 방송의 참가자는 목록 밖이어도 기록한다.
 */
import { db } from './client.ts';

export const WATCH_GAMES = ['lol', 'fconline'] as const;
export type WatchGame = typeof WATCH_GAMES[number];

export function parseWatchGame(value: string | undefined): WatchGame {
  const game = value ?? 'lol';
  if (!(WATCH_GAMES as readonly string[]).includes(game)) throw new Error(`게임은 ${WATCH_GAMES.join('|')} 중 하나다: ${game}`);
  return game as WatchGame;
}

export interface WatchedStreamer {
  id: string; display_name: string; slug: string;
  channel_id: string | null; vod_availability: string | null;
}

/** 이 게임의 감시 대상과 활성 SOOP 채널. 채널이 없으면 channel_id 가 null 이다. */
export async function listWatched(game: WatchGame): Promise<WatchedStreamer[]> {
  return db()<WatchedStreamer[]>`
    SELECT s.id, s.display_name, s.slug, c.channel_id, c.vod_availability
      FROM streamer_watch w
      JOIN streamer s ON s.id = w.streamer_id
      LEFT JOIN streamer_channel c ON c.streamer_id = s.id AND c.platform = 'soop' AND c.active_to IS NULL
     WHERE w.game_code = ${game}
     ORDER BY s.display_name`;
}

export async function watchedIds(game: WatchGame): Promise<Set<string>> {
  const rows = await db()<{ streamer_id: string }[]>`SELECT streamer_id FROM streamer_watch WHERE game_code = ${game}`;
  return new Set(rows.map(r => r.streamer_id));
}

export async function setWatched(streamerId: string, game: WatchGame, on: boolean): Promise<void> {
  if (on) await db()`INSERT INTO streamer_watch (streamer_id, game_code) VALUES (${streamerId}, ${game}) ON CONFLICT DO NOTHING`;
  else await db()`DELETE FROM streamer_watch WHERE streamer_id = ${streamerId} AND game_code = ${game}`;
}

export async function clearWatched(game: WatchGame): Promise<number> {
  return (await db()`DELETE FROM streamer_watch WHERE game_code = ${game} RETURNING streamer_id`).length;
}
