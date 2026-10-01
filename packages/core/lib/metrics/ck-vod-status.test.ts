import {test} from 'node:test';
import assert from 'node:assert/strict';
import {recentFrom, newestFirst, vodWork, madeProgress, END_TOLERANCE_SEC, titleExclusion} from './ck-vod-status.ts';

const done={status:'done',failed:[],requested:[[0,100]],opened:[10]};
test('자동 조사 창은 오늘 포함 3개 KST 날짜다',()=>{
 assert.equal(recentFrom(new Date('2026-09-27T15:00:00Z')),'2026-09-26');
 assert.equal(recentFrom(new Date('2026-09-27T14:59:59Z')),'2026-09-25');
});
test('같은 시각 VOD는 번호로 안정 정렬한다',()=>{
 const at='2026-09-20 12:00:00';
 assert.deepEqual([1,3,2].map(title_no=>({title_no,ended_at:at})).sort(newestFirst).map(v=>v.title_no),[3,2,1]);
});
test('끝 경계 1초 차이는 완료다 — 하와이 VOD 회귀',()=>{
 const raw={scan:{status:'done',failed:[],requested:[[0,44078]],opened:[0]}};
 assert.equal(vodWork(raw,44079).reason,null);
 assert.equal(vodWork(raw,44078+END_TOLERANCE_SEC+1).reason,'partial');
});
test('중간의 빈 구간은 오차로 덮지 않는다',()=>{
 const raw={scan:{...done,requested:[[0,40],[43,100]]}};
 assert.equal(vodWork(raw,100).reason,'partial');
 assert.equal(vodWork(raw,100).uncovered,2);
});
test('requested 를 안 채운 done 스캔은 sampled 로 완료를 판단한다 — 206075411 실측 회귀',()=>{
 // ck-research 가 실제로 낸 형태: status=done, sampled 는 전 범위, requested 는 아예 없음.
 const raw={scan:{status:'done',failed:[],opened:[0,1000],sampled:[[0,24106]]},vod_total_sec:24106};
 assert.equal(vodWork(raw,24106).reason,null);
 assert.equal(vodWork(raw,24106).uncovered,0);
});
test('requested 가 있으면 sampled 가 더 넓어도 requested 를 따른다',()=>{
 const raw={scan:{status:'done',failed:[],opened:[0],requested:[[0,40]],sampled:[[0,100]]}};
 assert.equal(vodWork(raw,100).reason,'partial');
});
test('조사 기록이 길이를 알면 목록 길이보다 우선한다',()=>{
 assert.equal(vodWork({scan:done,vod_total_sec:100},200).reason,null);
 assert.equal(vodWork({scan:done},200).reason,'partial');
});
test('길이를 모르면 done이어도 완료로 단정하지 않는다',()=>{
 assert.equal(vodWork({scan:done},null).reason,'partial');
});
test('done 선언만으로는 부족하다 — 연 화면이 없으면 미완료',()=>{
 assert.equal(vodWork({scan:{...done,opened:[]}},100).reason,'partial');
});
test('상태 분류: 없음·기록만·진행 중·실패 남음',()=>{
 assert.equal(vodWork(undefined,100).reason,'new');
 assert.equal(vodWork({},100).reason,'lead_only');
 assert.equal(vodWork({scan:{opened:[1]}},100).reason,'lead_only','상태 없는 옛 기록은 미조사');
 assert.equal(vodWork({scan:{status:'running'}},100).reason,'running');
 assert.equal(vodWork({scan:{...done,failed:[[30,40]]}},100).reason,'failed_left');
 assert.equal(vodWork({scan:{...done,status:'failed'}},100).reason,'failed_left');
});
test('접근 불가는 근거가 있을 때만 건너뛴다',()=>{
 assert.equal(vodWork({access:{status:'unavailable',reason:'삭제 안내 확인'}},100).reason,null);
 assert.equal(vodWork({access:{status:'unavailable',reason:' '}},100).reason,'lead_only');
 assert.equal(vodWork({access:{status:'temporary',reason:'timeout'}},100).reason,'lead_only');
});
test('진척은 도장이 아니라 남은 일로 판단한다',()=>{
 const run=(end:number,extra={})=>vodWork({scan:{status:'running',requested:[[0,end]]},...extra},100);
 assert.equal(madeProgress(run(20),run(40)),true,'running 그대로여도 범위가 늘면 진척');
 assert.equal(madeProgress(run(40),run(40,{note:'메모만'})),false);
 assert.equal(madeProgress(run(100),vodWork({scan:{...done}},100)),true);
 assert.equal(madeProgress(vodWork({candidates:[{conclusion:'unresolved'}],scan:{status:'running',requested:[[0,100]]}},100),
  vodWork({candidates:[{conclusion:'match'}],scan:{status:'running',requested:[[0,100]]}},100)),true,'후보 해소');
 assert.equal(madeProgress(vodWork(undefined,100),vodWork(undefined,100)),false);
 assert.equal(madeProgress(vodWork({},100),vodWork({access:{status:'unavailable',reason:'비공개 확인'}},100)),true);
});
test('LCK Watch Party 태그 방송은 제목만으로 뺀다',()=>{
 assert.equal(titleExclusion('김민교x칸 LCK T1 vs BFX 플레이오프 #LckWatchParty'),'LCK Watch Party');
 assert.equal(titleExclusion('이상호 DNS vs NS 샤벨스승님응원갑니다 #LckWatchparty'),'LCK Watch Party');
 assert.equal(titleExclusion('김민교 롤 상어녀CK'),null);
 assert.equal(titleExclusion('김민교 LCK 결승 보고 내전'),null,'태그 없이 LCK 만 적힌 제목은 빼지 않는다');
});

test('게임별 도장은 따로 센다 — 롤 완료가 FC 완료가 아니다(fco_scan)', () => {
  const lolDone = { status: 'done', requested: [[0, 100]], opened: [10] };
  const raw = { scan: lolDone, candidates: [{ conclusion: 'unresolved' }] };
  assert.equal(vodWork(raw, 100).reason, null);
  assert.equal(vodWork(raw, 100, 'fco_scan').reason, 'lead_only', '롤만 끝난 VOD 는 FC 로는 아직 안 본 VOD 다');
  assert.equal(vodWork(raw, 100).unresolved, 1);
  assert.equal(vodWork(raw, 100, 'fco_scan').unresolved, 0, '롤 미해결 후보를 FC 일로 세지 않는다');
  const both = { ...raw, fco_scan: { status: 'running', requested: [[0, 50]] } };
  assert.equal(vodWork(both, 100, 'fco_scan').reason, 'running');
  assert.equal(vodWork(both, 100).reason, null, 'FC 도장이 롤 판정을 바꾸지 않는다');
});
