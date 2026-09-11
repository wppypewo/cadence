import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/db.mjs';

function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cadence-correction-'));
  const store = new Store(dir);
  const insert = store.db.prepare(
    'INSERT INTO cards(id,kind,mode,level,freq,tags,answer,accept,search,headword,payload) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
  );
  for (const card of [
    { id: 'self-1', kind: 'vocab-recall', mode: 'self', level: 'A1', freq: 1, front: { word: 'école', gloss: '學校' } },
    { id: 'typed-1', kind: 'conj', mode: 'typed', level: 'A1', freq: 1, answer: 'vais', front: { verb: 'aller' } },
    { id: 'weak-2', kind: 'connector', mode: 'choice', level: 'B1', freq: 0, answer: 'subjonctif', front: { connector: 'bien que' } },
  ]) {
    insert.run(card.id, card.kind, card.mode, card.level, card.freq, '[]', card.answer ?? null, null, '', '', JSON.stringify(card));
  }
  return { dir, store, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('人工評分更正以追加事件重放，不多算一次作答', async () => {
  const f = fixture();
  try {
    const before = f.store.review({ cardId: 'self-1', rating: 1, correct: false, selfRated: true, at: new Date('2026-09-11T10:00:00+08:00') });
    const corrected = await f.store.correctReview({ id: before.eventId, rating: 4 });
    assert.equal(corrected.rating, 4);
    assert.equal(f.store.state('self-1').reps, 1);
    assert.equal(f.store.state('self-1').lapses, 0);
    assert.deepEqual({ ...f.store.db.prepare('SELECT rating, correct FROM reviews').get() }, { rating: 4, correct: 1 });
    const lines = readFileSync(path.join(f.dir, 'reviews.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(lines.length, 2);
    assert.equal(lines[1].type, 'rating-correction');
    assert.equal(lines[1].target, before.eventId);
    assert.equal((await f.store.auditJournal()).inSync, true);
  } finally { f.close(); }
});

test('只能更正最新一筆人工評分，自動批改不能被覆寫', async () => {
  const f = fixture();
  try {
    const manual = f.store.review({ cardId: 'self-1', rating: 3, correct: true, selfRated: true });
    const auto = f.store.review({ cardId: 'typed-1', rating: 3, correct: true, selfRated: false });
    await assert.rejects(() => f.store.correctReview({ id: manual.eventId, rating: 1 }), /只能更正剛才/);
    await assert.rejects(() => f.store.correctReview({ id: auto.eventId, rating: 1 }), /自動批改/);
    assert.equal(readFileSync(path.join(f.dir, 'reviews.jsonl'), 'utf8').trim().split('\n').length, 2);
  } finally { f.close(); }
});

test('弱點批次只取答錯過的卡，並遵守科目範圍與上限', () => {
  const f = fixture();
  try {
    f.store.review({ cardId: 'self-1', rating: 1, correct: false });
    f.store.review({ cardId: 'weak-2', rating: 1, correct: false });
    f.store.review({ cardId: 'weak-2', rating: 1, correct: false });
    assert.deepEqual(f.store.queueWeak(1).map((card) => card.id), ['weak-2']);
    assert.deepEqual(f.store.queueWeak(10, { levels: ['A1'] }).map((card) => card.id), ['self-1']);
    assert.equal(f.store.queueWeak(10, { kinds: ['conj'] }).length, 0);
  } finally { f.close(); }
});
