import assert from "node:assert/strict";
import * as ck from "../../packages/core/lib/db/ck.ts";
import { db } from "../../packages/core/lib/db/client.ts";
import { listReviewEvents, getReviewEvent } from "../../packages/core/lib/db/event-review.ts";

/** 실제 저장/조회 경로로 분모, 0 KDA, 명시적 완료, 수정 후 해제와 롤백을 검증한다. */
export async function verifyReviewProgress() {
  const sql = db();
  const [event] = await sql<{ id: string }[]>`INSERT INTO event (name, slug, kind, game_code)
    VALUES ('검수 현황', 'review-progress', 'tournament', 'lol') RETURNING id`;
  const [person] = await sql<{ id: string }[]>`INSERT INTO streamer (display_name, slug)
    VALUES ('검수 선수', 'review-progress-person') RETURNING id`;
  const lead = await ck.upsertEventLead({ source: 'vod_title', source_key: 'vod:progress', title: '검수 현황 VOD', observed_at: new Date() });
  for (const n of [1, 2]) await ck.upsertMatchFromScan({
    match_id: `progress:${n}`, event_id: event.id, series_id: 'progress:series', series_game_no: n,
    played_at: new Date('2026-09-20T00:00:00Z'), played_at_precision: 'date', winning_team: 100,
    result_evidence: '검증용', participants: Array.from({ length: 8 }, (_, i) => ({
      participant_id: i + 1, team_id: i < 5 ? 100 as const : 200 as const,
      observed_name: `선수 ${i + 1}`, team_position: i === 0 ? "TOP" : i === 1 ? "NONE" : null,
      champion_id: i < 2 ? 268 : 0, streamer_id: i === 0 ? person.id : null,
      kills: i === 0 ? 0 : null, deaths: i === 0 ? 0 : null, assists: i === 0 ? 0 : null,
    })),
  });
  const frames = await ck.recordEvidenceFrames(lead, [
    {frame_path:'progress/a.jpg',match_id:'progress:1'},
    {frame_path:'progress/b.jpg',match_id:'progress:1'},
    {frame_path:'progress/c.jpg',match_id:'progress:2'},
  ]);
  const detail = async (id = 'progress:1') => (await ck.getMatchDetail(id))!;
  const list = async () => (await ck.listEventLeads({ with_matches: true })).find(l => l.id === lead)!;
  const complete = async (id = 'progress:1') => ck.setMatchReviewCompleted(id, true, (await detail(id)).match.review_version);
  const counts = await list();
  assert.equal(counts.match_count, 2, '프레임 수로 경기를 중복 계산하지 않는다');
  assert.equal(counts.participant_count, 16);
  assert.equal(counts.position_count, 2, "미확정 포지션 NONE은 채워진 것으로 세지 않는다");
  assert.equal(counts.linked_count, 2);
  assert.equal(counts.champion_count, 4, "챔피언 ID 0은 미입력이다");
  assert.equal(counts.kda_count, 2, '0/0/0도 완전한 입력이다');
  await ck.markMatchReviewed('progress:1', true);
  assert.equal((await list()).completed_count, 0, '관리자 보호는 완료가 아니다');
  await complete();
  assert.equal((await list()).completed_count, 1, '8명·빈 KDA도 완료할 수 있다');
  assert.ok((await detail()).match.reviewed_at);
  const checked = await detail();
  await ck.applyMatchReview('progress:1', { participants: { patch: [
    { participant_id: 1, changes: { kills: 0 }, expect: { kills: 0 } },
  ] } });
  assert.equal((await detail()).match.review_completed_at?.getTime(), checked.match.review_completed_at?.getTime(), '동일 값은 완료 유지');
  await ck.applyMatchReview('progress:1', { participants: { patch: [
    { participant_id: 1, changes: { kills: 1 }, expect: { kills: 0 } },
  ] } });
  assert.equal((await detail()).match.review_completed_at, null);
  await assert.rejects(() => ck.setMatchReviewCompleted('progress:1', true, checked.match.review_version), /경기 값이 바뀌/);
  await complete();
  const beforeRollback = await detail();
  await assert.rejects(() => ck.applyMatchReview('progress:1', {
    match: { changes: { winning_team: 200 }, expect: { winning_team: 100 } },
    participants: { add: [{ participant_id: 1, team_id: 100, observed_name: '겹침' }] },
  }), /이미/);
  assert.deepEqual(await detail(), beforeRollback, '실패한 변경은 완료·버전도 되돌린다');
  await complete('progress:2');
  assert.equal((await list()).completed_count, 2);
  assert.equal((await ck.listEventLeads({with_matches:true,unreviewed:true})).some(l => l.id === lead), false);
  assert.equal((await listReviewEvents('tournament', true)).some(e => e.id === event.id), false);
  const eventCounts = (await listReviewEvents('tournament')).find(e => e.id === event.id)!;
  assert.equal(eventCounts.completed_count, 2);
  assert.equal(eventCounts.position_count, 2);
  assert.equal(eventCounts.champion_count, 4);
  assert.equal(eventCounts.kda_count, 2);
  assert.equal((await detail()).match.position_count, 1);
  assert.equal((await detail()).match.champion_count, 2);
  assert.equal((await getReviewEvent('review-progress'))!.series[0].sets[0].linked_count, 1);
  await ck.applyMatchReview('progress:1', { match: {
    changes: { best_of: 3, best_of_evidence: '규정' }, expect: { best_of: null, best_of_evidence: null },
  } });
  assert.equal((await detail()).match.review_completed_at, null);
  assert.equal((await detail('progress:2')).match.review_completed_at, null, '공유 규정은 다른 세트의 완료도 해제');
  await complete();
  await sql`UPDATE match_participant SET assists=2 WHERE match_id='progress:1' AND participant_id=1`;
  assert.equal((await detail()).match.review_completed_at, null, '직접 DB 변경도 완료 해제');
  await complete();
  await ck.setMatchReviewCompleted('progress:1', false, (await detail()).match.review_version);
  assert.ok((await detail()).match.reviewed_at, '완료 취소가 자동 수정 보호를 풀지 않는다');
  await ck.relinkEvidenceFrame(frames[0].id, 'progress:2');
  assert.ok((await ck.listReviewChanges({match_id:'progress:1'})).some(r => r.entity === 'frame' && r.after === 'progress:2'), '이동 전 경기에서도 프레임 변경 이력 조회');
  assert.ok((await ck.listReviewChanges({lead_id:lead})).some(r => r.field === 'kills'), 'VOD에서도 경기 수정 이력 조회');
  console.log('Review progress/completion regressions passed');
}
