import test from 'node:test';
import assert from 'node:assert/strict';
import { compatiblePreparation } from './preparation-compat.mjs';
test('verified memo-only release preserves old cache, never unrelated or subsequent changes', () => {
  const record = { previous: 'old', current: 'memo-release', verified_result_equivalence: true };
  assert.equal(compatiblePreparation('old', 'memo-release', record), true);
  assert.equal(compatiblePreparation('other-old', 'memo-release', record), false);
  assert.equal(compatiblePreparation('old', 'new-result-model', record), false);
  assert.equal(compatiblePreparation('old', 'memo-release', null), false);
  assert.equal(compatiblePreparation('old', 'memo-release', { ...record, verified_result_equivalence: false }), false);
  assert.equal(compatiblePreparation('same', 'same', null), true);
});
