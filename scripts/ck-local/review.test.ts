import {test} from 'node:test';
import assert from 'node:assert/strict';
import {reviewLabels} from './review.mjs';
const state={vod_id:1,run_id:'one',total_sec:100,candidates:[{n:1,peak:30},{n:2,peak:60}]};
test('실제로 열었다고 명시하고 파일도 있는 원본만 학습 라벨로 받는다',()=>{
 assert.equal(reviewLabels(state,{verdicts:'1:result,2:other',seen:'30,60'},()=>true).length,2);
 assert.throws(()=>reviewLabels(state,{verdicts:'1:result'},()=>true),/seen/);
 assert.throws(()=>reviewLabels(state,{verdicts:'1:result',seen:'30'},()=>false),/파일/);
});
test('뒤쪽 라벨이 틀려도 중간 저장 없이 전체 입력을 거부한다',()=>{
 assert.throws(()=>reviewLabels(state,{verdicts:'1:result,99:other',seen:'30,60'},()=>true),/없는 후보/);
 assert.throws(()=>reviewLabels(state,{labels:'30=result,30=other',seen:'30'},()=>true),/서로 다른/);
 assert.throws(()=>reviewLabels(state,{labels:'1:99=result',seen:'30'},()=>true),/시각/);
});
