import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, localDay } from '../src/db.mjs';
import { Api } from '../src/api.mjs';
import { tokenize, resolveForm, readCheck } from '../src/engine/lexicon.mjs';

const DAY = 86_400_000;

function fixture(cards) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cadence-reading-'));
  const store = new Store(dir);
  const insert = store.db.prepare(
    'INSERT INTO cards(id,kind,mode,level,freq,tags,answer,accept,search,headword,payload) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
  );
  for (const c of cards) {
    insert.run(c.id, c.kind, 'typed', c.level ?? 'B1', 0, '', c.answer ?? null, null, '', c.headword ?? null, JSON.stringify(c));
  }
  return { store, api: new Api(store), close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const lex = (words, verbs = {}) => ({ has: (w) => words.includes(w), verbOf: (f) => verbs[f] ?? null });

test('tokenize 原文一字不漏，撇號與連字號拆開', () => {
  const s = "Qu'il vienne, peut-être… ___ à l'école.";
  const tokens = tokenize(s);
  assert.equal(tokens.map((t) => t.text).join(''), s);
  assert.deepEqual(tokens.filter((t) => t.word).map((t) => t.text), ['Qu', 'il', 'vienne', 'peut', 'être', 'à', 'l', 'école']);
});

test('resolveForm 依序試原形、變位表、陰性複數、詞幹補字尾', () => {
  const l = lex(['maison', 'grand', 'traiter', 'venir', 'vendre'], { venu: 'venir' });
  assert.deepEqual(resolveForm('Maison', l), { word: 'maison', via: 'exact' });
  assert.deepEqual(resolveForm('venu', l), { word: 'venir', via: 'conj' });
  assert.deepEqual(resolveForm('grandes', l), { word: 'grand', via: 'form' });
  assert.deepEqual(resolveForm('traitent', l), { word: 'traiter', via: 'stem' });
  assert.deepEqual(resolveForm('vendent', l), { word: 'vendre', via: 'stem' });
  // 詞幹不到 3 個字母不猜：tes 不能變成 ter。
  assert.equal(resolveForm('tes', lex(['ter'])), null);
  assert.equal(resolveForm('de', l), null);
});

test('readCheck 分母只算題庫收了的字，穩了也算學過', () => {
  const l = lex(['maison', 'grand', 'être']);
  const status = (w) => ({ maison: 'mature', grand: 'seen' })[w] ?? 'fresh';
  const { tokens, counts } = readCheck('La grande maison doit être là.', l, status);
  assert.deepEqual(counts, { inBank: 3, seen: 2, mature: 1, outside: 3 });
  assert.equal(tokens.find((t) => t.text === 'grande').word, 'grand');
  assert.equal(tokens.find((t) => t.text === 'La').status, 'outside');
});

test('lexicon 的複合變位只取最後一個字，而且不搶單字答案的對應', () => {
  const f = fixture([
    { id: 'v:avoir|VER|r', kind: 'vocab-recall', headword: 'avoir', front: { word: 'avoir' } },
    { id: 'v:être|VER|r', kind: 'vocab-recall', headword: 'être', front: { word: 'être' } },
    { id: 'c:être|pc|0', kind: 'conj', headword: 'être', answer: 'ai été', front: {} },
    { id: 'c:avoir|pr|0', kind: 'conj', headword: 'avoir', answer: 'ai', front: {} },
  ]);
  try {
    const l = f.store.lexicon();
    assert.equal(l.verbOf('ai'), 'avoir');
    assert.equal(l.verbOf('été'), 'être');
    assert.equal(l.has('être'), true);
    assert.equal(l.has('ai'), false);
  } finally { f.close(); }
});

test('readingSentences 放挑連接詞題目，改寫題的解答要答過才放', () => {
  const f = fixture([
    { id: 'p:I|1', kind: 'pick', answer: 'bien que', front: { prompt: '___ il pleuve, je sors.', src: '教材' } },
    { id: 'rw:A|1', kind: 'rw', answer: 'Il pleut, pourtant je sors.', front: { prompt: '雖然下雨我還是出門。' } },
  ]);
  try {
    assert.deepEqual(f.store.readingSentences().map((s) => s.id), ['p:I|1']);
    f.store.review({ cardId: 'rw:A|1', rating: 3 });
    assert.deepEqual(f.store.readingSentences().map((s) => s.id), ['p:I|1', 'rw:A|1']);
  } finally { f.close(); }
});

test('sentence API 同一天固定同一句，i 可以換句並繞回', () => {
  const f = fixture([
    { id: 'v:pleuvoir|VER|r', kind: 'vocab-recall', headword: 'pleuvoir', front: { word: 'pleuvoir' } },
    { id: 'p:I|1', kind: 'pick', front: { prompt: '___ il pleuve.' } },
    { id: 'p:I|2', kind: 'pick', front: { prompt: 'Il pleut ___ je sors.' } },
    { id: 'c:pleuvoir|pr|2', kind: 'conj', headword: 'pleuvoir', answer: 'pleut', front: {} },
  ]);
  try {
    assert.equal(f.api.sentence().index, f.api.sentence().index);
    assert.equal(f.api.sentence({ i: '2' }).index, 0);
    assert.equal(f.api.sentence({ i: '-1' }).index, 1);
    const one = f.api.sentence({ i: '1' }).sentence;
    assert.deepEqual(one.counts, { inBank: 1, seen: 0, mature: 0, outside: 3 });
    f.store.review({ cardId: 'v:pleuvoir|VER|r', rating: 3 });
    assert.equal(f.api.sentence({ i: '1' }).sentence.counts.seen, 1);
    assert.throws(() => f.api.sentence({ i: 'x' }), /i 需要是整數/);
  } finally { f.close(); }
});

test('maturedRecently 只列窗口內第一次跨過 21 天的卡', () => {
  const f = fixture([
    { id: 'c:aller|pr|0', kind: 'conj', headword: 'aller', answer: 'vais', front: { verb: 'aller', pronoun: 'je', tenseZh: '直陳式現在' } },
    { id: 'v:vieux|ADJ|r', kind: 'vocab-recall', headword: 'vieux', front: { word: 'vieux', gloss: '老' } },
  ]);
  const now = new Date();
  const ago = (d) => new Date(now.getTime() - d * DAY);
  try {
    // 兩次都答 Easy、間隔夠長，第二次作答後穩定度會超過 21 天。
    f.store.review({ cardId: 'c:aller|pr|0', rating: 4, at: ago(12) });
    f.store.review({ cardId: 'c:aller|pr|0', rating: 4, at: ago(2) });
    f.store.review({ cardId: 'v:vieux|ADJ|r', rating: 4, at: ago(40) });
    f.store.review({ cardId: 'v:vieux|ADJ|r', rating: 4, at: ago(30) });
    assert.ok(f.store.state('v:vieux|ADJ|r').stability >= 21);

    const rows = f.store.maturedRecently({ days: 7, now });
    assert.deepEqual(rows.map((r) => r.id), ['c:aller|pr|0']);
    assert.equal(rows[0].day, localDay(ago(2)));

    const weekly = f.api.weekly();
    assert.equal(weekly.matureTotal, 2);
    assert.equal(weekly.items[0].label, 'je vais');
    assert.equal(weekly.items[0].sub, 'aller・直陳式現在');
  } finally { f.close(); }
});

test('outlook 沒設考試日期時不推演；設了就照 7 天節奏算，停下來的數字不會比較多', () => {
  const f = fixture([
    { id: 'v:chat|NOM|r', kind: 'vocab-recall', level: 'A2', headword: 'chat', front: { word: 'chat' } },
    { id: 'v:chien|NOM|r', kind: 'vocab-recall', level: 'B1', headword: 'chien', front: { word: 'chien' } },
  ]);
  try {
    assert.deepEqual(f.api.outlook(), { examDate: null });
    const exam = new Date(Date.now() + 60 * DAY);
    f.store.set('examDate', localDay(exam));
    for (let i = 0; i < 14; i += 1) f.store.review({ cardId: 'v:chat|NOM|r', rating: 3 });
    const o = f.api.outlook();
    assert.equal(o.windowReviews, 14);
    assert.equal(o.pace, 2);
    assert.equal(o.cardsInScope, 2);
    assert.ok(o.stoppedRecall <= o.expectedRecall);
    assert.equal(f.api.outlook(), o, '作答數沒變時直接回快取');
    f.store.review({ cardId: 'v:chat|NOM|r', rating: 3 });
    assert.notEqual(f.api.outlook(), o);
  } finally { f.close(); }
});
