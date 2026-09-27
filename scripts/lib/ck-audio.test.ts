import {test} from 'node:test';
import assert from 'node:assert/strict';
import {splitAudioRanges,audioManifest} from './ck-audio.ts';
const parts=[{index:1,offset_sec:0,length_sec:50},{index:2,offset_sec:50,length_sec:50}];
test('음성 분할 경계와 범위 밖 요청을 구분한다',()=>{
  const split=splitAudioRanges([[45,10],[95,10]],parts);
  assert.deepEqual(split.pieces.map(p=>[p.at,p.span,p.part.index]),[[45,5,1],[50,5,2],[95,5,2]]);
  assert.deepEqual(split.outOfRange,[[100,105]]);
  const manifest=audioManifest({vodId:1,title:null,vodSeconds:100,plannedRanges:[[95,10]],outOfRange:[[100,105]],clips:[{id:'a',at:95,seconds:5,audio:'a.wav',cached:true}],failed:[]});
  assert.equal(manifest.complete,true); assert.deepEqual(manifest.outOfRange,[[100,105]]); assert.equal('cached' in manifest.clips[0],false);
});
test('전체 범위 밖도 빈 산출물로 남기고 완료로 표시하지 않는다',()=>{
  const result=splitAudioRanges([[110,10]],parts);
  assert.deepEqual(result,{pieces:[],outOfRange:[[110,120]]});
  assert.equal(audioManifest({vodId:1,title:null,vodSeconds:100,plannedRanges:[[110,10]],outOfRange:result.outOfRange,clips:[],failed:[]}).complete,false);
});
test('파트 사이 공백 뒤의 유효 조각을 버리지 않는다',()=>{
  const result=splitAudioRanges([[5,30]],[{index:1,offset_sec:0,length_sec:10},{index:2,offset_sec:20,length_sec:20}]);
  assert.deepEqual(result.outOfRange,[[10,20]]);
  assert.deepEqual(result.pieces.map(p=>[p.at,p.span]),[[5,5],[20,15]]);
});
