import test from 'node:test';
import assert from 'node:assert/strict';
import {consistencyViolations, fontLiterals} from './lib/consistency-checks.ts';
test('같은 규칙을 화면에서 재정의하거나 폐기한 경로를 쓰면 실패',()=>{
  assert.ok(consistencyViolations('packages/ui/example.ts','function matchOutcome(wins:number) { return wins > 0 }').length);
  assert.ok(consistencyViolations('apps/web/example.ts','const x = row.counts_toward_titles').length);
  assert.ok(consistencyViolations('apps/web/example.ts',`const labels = {ck:'내전', tournament:'대회',showmatch:'이벤트'}`).length);
  assert.deepEqual(consistencyViolations('apps/web/example.ts',`const medal = row.placement_rank === 1; const color = result === 'win' ? 'green' : 'red'`),[]);
  assert.deepEqual(fontLiterals('font-size: var(--type-meta); text-[length:var(--type-body)]'),{});
  assert.deepEqual(fontLiterals('font-size:10px; text-[10px]'),{'10px':2});
});
