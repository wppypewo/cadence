import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/db.mjs';
import { Api } from '../src/api.mjs';

function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cadence-features-'));
  const store = new Store(dir);
  const insert = store.db.prepare(
    'INSERT INTO cards(id,kind,mode,level,freq,tags,answer,accept,search,headword,payload) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
  );
  for (const card of [
    { id: 'self', kind: 'vocab-recall', mode: 'self', level: 'A1', freq: 2, front: { word: 'école', gloss: '學校' } },
    { id: 'typed', kind: 'conj', mode: 'typed', level: 'A2', freq: 1, answer: 'vais', accept: ['vais'], front: { verb: 'aller' } },
  ]) insert.run(card.id, card.kind, card.mode, card.level, card.freq, '[]', card.answer ?? null, JSON.stringify(card.accept ?? []), '', '', JSON.stringify(card));
  const api = new Api(store);
  return { dir, store, api, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('practice API 留下四科紀錄，today 只把完成與分數並列、不混成能力', () => {
  const f = fixture();
  try {
    const row = f.api.practice({ skill: 'CO', source: 'sample.mp3', durationSec: 900, score: 14, maxScore: 25 });
    assert.equal(row.skill, 'CO');
    const co = f.api.today().tasks.find((task) => task.id === 'CO');
    assert.equal(co.done, true);
    assert.equal(co.practiced, true);
    assert.equal(co.attempt.score, 14);
    assert.equal(co.tracked, false);
    assert.equal(f.api.stats().practice.bySkill.find((item) => item.skill === 'CO').attempts, 1);
  } finally { f.close(); }
});

test('mock API 驗證四科並在統計回傳最近模考', () => {
  const f = fixture();
  try {
    const scores = Object.fromEntries(['CE', 'PE', 'CO', 'PO'].map((skill) => [skill, { score: 15, maxScore: 25 }]));
    assert.equal(f.api.mock({ day: '2026-09-11', scores }).total, 60);
    assert.equal(f.api.stats().practice.mocks[0].total, 60);
    assert.throws(() => f.api.mock({ day: '2026-09-11', scores: {} }), /CE 缺少分數/);
  } finally { f.close(); }
});

test('review API 回傳可更正 id，弱點 preset 回有限且不含答案的批次', async () => {
  const f = fixture();
  try {
    const reviewed = f.api.review({ cardId: 'self', rating: 1 });
    assert.ok(reviewed.reviewId);
    assert.equal(reviewed.selfRated, true);
    const corrected = await f.api.correctReview({ id: reviewed.reviewId, rating: 3 });
    assert.equal(corrected.rating, 3);
    const weak = f.api.queue({ preset: 'weak', limit: 10 });
    assert.equal(weak.cards.length, 0);
    f.api.review({ cardId: 'self', rating: 1 });
    const again = f.api.queue({ preset: 'weak', limit: 1 });
    assert.equal(again.cards.length, 1);
    assert.equal(again.cards[0].answer, undefined);
    assert.throws(() => f.api.queue({ preset: 'mystery' }), /不認得的練習模式/);
  } finally { f.close(); }
});
