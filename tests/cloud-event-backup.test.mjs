import test from 'node:test';
import assert from 'node:assert/strict';
import { backupRow, planAppend } from '../src/cloud/event-backup.mjs';

const row = (id, extra = {}) => ({ owner_id: 'o', event_id: id, at: `t${id}`, ...extra });

test('空檔：全部列追加，去掉 owner_id', () => {
  const plan = planAppend('', [row('a'), row('b')]);
  assert.equal(plan.appended, 2);
  assert.deepEqual(plan.text.trimEnd().split('\n').map((l) => JSON.parse(l)), [
    { event_id: 'a', at: 'ta' }, { event_id: 'b', at: 'tb' },
  ]);
  assert.deepEqual(plan.missingFromCloud, []);
});

test('以 event_id 比對：payload 鍵順序不同也不重複追加', () => {
  const existing = `${JSON.stringify({ event_id: 'a', payload: { y: 1, x: 2 } })}\n`;
  const plan = planAppend(existing, [row('a', { payload: { x: 2, y: 1 } }), row('b')]);
  assert.equal(plan.appended, 1);
  assert.equal(JSON.parse(plan.text).event_id, 'b');
});

test('雲端已刪的列只回報，不從備份移除', () => {
  const existing = ['a', 'gone'].map((id) => JSON.stringify({ event_id: id })).join('\n') + '\n';
  const plan = planAppend(existing, [row('a')]);
  assert.equal(plan.text, '');
  assert.deepEqual(plan.missingFromCloud, ['gone']);
});

test('既有檔末沒有換行時先補一個', () => {
  const plan = planAppend(JSON.stringify({ event_id: 'a' }), [row('b')]);
  assert.ok(plan.text.startsWith('\n'));
  assert.ok(plan.text.endsWith('\n'));
});

test('雲端同一批重複的 event_id 只寫一次', () => {
  assert.equal(planAppend('', [row('a'), row('a')]).appended, 1);
});

test('既有檔有壞行或缺 event_id 時拒絕追加', () => {
  assert.throws(() => planAppend('{"event_id":"a"}\nnot json\n', []), /第 2 行/);
  assert.throws(() => planAppend('{"id":"a"}\n', []), /缺 event_id/);
});

test('法文重音原樣寫出', () => {
  const plan = planAppend('', [row('a', { card_id: 'v:cœur|NOM|r', payload: { answer: 'élève' } })]);
  assert.ok(plan.text.includes('cœur') && plan.text.includes('élève'));
});

test('backupRow 不動原物件', () => {
  const r = row('a');
  backupRow(r);
  assert.equal(r.owner_id, 'o');
});
