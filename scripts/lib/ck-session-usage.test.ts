import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sessionUsage,sessionSummary} from './ck-session-usage.ts';
test('캐시 입력과 일반 입력을 구분하고 누락된 사용량을 0으로 속이지 않는다',()=>{
 const u=sessionUsage({type:'result',usage:{input_tokens:2,cache_creation_input_tokens:100,cache_read_input_tokens:900,output_tokens:20}});
 assert.equal(u.cache_read_input_tokens,900);assert.equal(u.input_tokens,2);
 assert.throws(()=>sessionUsage({type:'result'}));
 assert.throws(()=>sessionUsage({type:'result',usage:{input_tokens:-1}}));
});
test('세션 응답을 한 줄로 남기고 긴 응답·제어 문자·실패를 처리한다',()=>{
 assert.equal(sessionSummary({result:'2경기 저장\n 다음 위치 1200초\t미완료'}),'조사 요약: 2경기 저장 다음 위치 1200초 미완료');
 assert.equal(sessionSummary({is_error:true,result:'\x1b[31m사용량 한도\x1b[0m'}),'실패 요약: 사용량 한도');
 assert.match(sessionSummary({result:'가'.repeat(2000)}),/원본 참조/);
 assert.ok(sessionSummary({result:'가'.repeat(2000)}).length<1700);
 assert.equal(sessionSummary(null),'조사 요약: 응답 요약 없음');
});
