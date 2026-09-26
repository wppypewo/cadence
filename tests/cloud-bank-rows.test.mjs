import test from 'node:test';
import assert from 'node:assert/strict';
import { cardRow, inList, referenceRows, uploadableCards } from '../src/cloud/bank-rows.mjs';

test('變位卡不上雲端（GPL-2.0 隔離）', () => {
  const cards = [{ id: 'c:être', kind: 'conj' }, { id: 'v:cœur|NOM|r', kind: 'vocab' }];
  assert.deepEqual(uploadableCards(cards).map((c) => c.id), ['v:cœur|NOM|r']);
});

test('卡片列帶 search／headword 與題庫版本，缺欄位補預設值', () => {
  const card = {
    id: 'v:cœur|NOM|r', kind: 'vocab', mode: 'recall', level: 'A2',
    front: { word: 'cœur', gloss: '心' }, answer: 'cœur',
  };
  const row = cardRow(card, 'owner-1', 'fp');
  assert.equal(row.owner_id, 'owner-1');
  assert.equal(row.freq, 0);
  assert.deepEqual(row.tags, []);
  assert.equal(row.accept, null);
  assert.equal(row.search, '心 cœur');
  assert.equal(row.headword, 'cœur');
  assert.equal(row.bank_version, 'fp');
  assert.equal(row.payload, card);
});

test('參考資料列：每個連接詞一列，最後一列記排除的變位卡數', () => {
  const rows = referenceRows({
    connectors: [{ connector: 'bien que' }],
    meta: { builtAt: 't', counts: { verbTables: 7 } },
    owner: 'o', bankVersion: 'fp', cardCount: 3, allCardCount: 10,
  });
  assert.deepEqual(rows.map((r) => [r.entry_type, r.entry_key]), [['connector', 'bien que'], ['meta', 'bank']]);
  assert.equal(rows[1].payload.excluded.conjugationCards, 7);
  assert.equal(rows[1].payload.excluded.verbTables, 7);
});

test('PostgREST in 清單：每個值加雙引號，引號與反斜線跳脫', () => {
  assert.equal(inList(['k:comme si', "v:aujourd'hui|ADV|r"]), `in.("k:comme si","v:aujourd'hui|ADV|r")`);
  assert.equal(inList(['a,b', 'x(y)']), 'in.("a,b","x(y)")');
  assert.equal(inList(['say "hi"', 'back\\slash']), 'in.("say \\"hi\\"","back\\\\slash")');
});
