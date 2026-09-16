import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('口說固定 prompt 只把 10 分鐘準備給第三部分', () => {
  const text = readFileSync(new URL('../study/delf-b1-production-orale.md', import.meta.url), 'utf8');
  const prompt = text.split('```')[1];
  const part2 = prompt.slice(prompt.indexOf('Partie 2'), prompt.indexOf('Partie 3'));
  const part3 = prompt.slice(prompt.indexOf('Partie 3'));
  assert.match(part2, /不給準備時間/);
  assert.doesNotMatch(part2, /10 分鐘/);
  assert.match(part3, /10 分鐘準備/);
});
