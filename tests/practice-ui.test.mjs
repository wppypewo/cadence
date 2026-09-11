import test from 'node:test';
import assert from 'node:assert/strict';
import { countWords } from '../web/js/practice.mjs';

test('寫作字數以空白分詞，省音與連字號不會被重複計算', () => {
  assert.equal(countWords("J’aime l’université et peut-être Paris."), 5);
  assert.equal(countWords('  Bonjour,\n tout le monde !  '), 4);
  assert.equal(countWords(''), 0);
});
