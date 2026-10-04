import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateScanResume} from './ck-resume.ts';
test('짧은 재개 정보만 허용하고 잘못된 위치·거대한 기록은 거부한다',()=>{
 validateScanResume({next_action:'6경기 결과창 확인',next_at:120,context:['상 어=상어녀; 앞 경기 원본에서 확인']});
 validateScanResume(null);
 for(const value of [{}, {next_action:'다음',next_at:-1}, {next_action:'다음',next_at:1.2},
  {next_action:'다음',context:['x'.repeat(501)]}, {next_action:'다음',history:[]}]) assert.throws(()=>validateScanResume(value));
});
