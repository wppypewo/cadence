/**
 * API 層測試。這一層不碰 HTTP，所以可以直接呼叫。
 *
 * 兩件事特別要守：
 *  1. **出題時答案不能跟著送出去**。答案留在回應裡，devtools 的 network 面板一開就破功。
 *  2. **打字題的評分規則**。答對是 Good、只差重音或大小寫是 Hard、錯是 Again。
 *     這條規則決定了往後所有排程，改動要是無意的就得被擋下來。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/db.mjs';
import { Api, HttpError } from '../src/api.mjs';

const BANK = [
  {
    id: 'v:ecole', kind: 'vocab-produce', mode: 'typed', level: 'A1', freq: 9,
    tags: ['vocab'], answer: 'école', accept: ['école'], note: '陰性名詞',
    front: { zh: '學校' },
  },
  {
    id: 'v:chien', kind: 'vocab-recall', mode: 'self', level: 'A1', freq: 8,
    tags: ['vocab'], answer: '狗', accept: null, front: { word: 'chien' },
  },
  {
    id: 'k:bien-que', kind: 'connector', mode: 'choice', level: 'B1', freq: 0,
    tags: ['connector', 'subjonctif'], answer: 'subjonctif', accept: ['subjonctif'],
    options: ['indicatif', 'subjonctif'], front: { connector: 'bien que' },
  },
  {
    id: 'c:etre:present:1', kind: 'conj', mode: 'typed', level: 'A2', freq: 7,
    tags: ['conj', 'être'], answer: 'es', accept: ['es'], front: { verb: 'être', pronoun: 'tu' },
  },
];

async function open() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cadence-api-'));
  mkdirSync(path.join(dir, 'bank'), { recursive: true });
  writeFileSync(path.join(dir, 'bank', 'cards.json'), JSON.stringify(BANK), 'utf8');
  writeFileSync(
    path.join(dir, 'bank', 'verbs.json'),
    JSON.stringify({ être: { aux: 'avoir', simple: { 'présent': ['suis', 'es', 'est', 'sommes', 'êtes', 'sont'] } } }),
    'utf8',
  );
  const store = new Store(dir);
  await store.loadBank();
  return [new Api(store), store, dir];
}

/** assert.throws 不回傳被丟出的錯，但這裡要看 status，所以自己接。 */
function caught(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new assert.AssertionError({ message: '預期會丟錯，但沒有' });
}

function cleanup(store, dir) {
  store.close();
  rmSync(dir, { recursive: true, force: true });
}

test('scope 只收白名單內的值，其餘直接 400', () => {
  assert.deepEqual(Api.scope({}), { kinds: [], levels: [] });
  assert.deepEqual(Api.scope({ kinds: 'conj,connector', levels: 'A1' }), {
    kinds: ['conj', 'connector'], levels: ['A1'],
  });
  // 空白與空項要被吃掉，不要變成查不到東西的 IN ('')。
  assert.deepEqual(Api.scope({ kinds: ' conj , ,' }).kinds, ['conj']);

  const err = caught(() => Api.scope({ kinds: 'conj,drop-table' }));
  assert.ok(err instanceof HttpError);
  assert.equal(err.status, 400);
  assert.match(err.message, /drop-table/);
  assert.equal(caught(() => Api.scope({ levels: 'C1' })).status, 400);
});

test('出題不帶答案，統計裡的弱點卡才帶', async () => {
  const [api, store, dir] = await open();
  try {
    const q = api.queue({ limit: 10 });
    for (const c of q.cards) {
      assert.equal('answer' in c, false, `${c.id} 把答案送出去了`);
      assert.equal('accept' in c, false);
      assert.equal('note' in c, false);
    }
    // 選擇題的選項要留著，否則畫面畫不出來。
    assert.deepEqual(q.cards.find((c) => c.id === 'k:bien-que').options, ['indicatif', 'subjonctif']);
    assert.equal(q.remaining.due + q.remaining.new, 4);
    assert.equal(q.newLimit, 15);

    api.review({ cardId: 'v:ecole', answer: 'ecole' });
    const weak = api.stats().weakest;
    assert.equal(weak.length, 1);
    // 弱點清單的用途就是看到自己寫錯的字，這裡答案要在，但不必給候選清單。
    assert.equal(weak[0].card.answer, 'école');
    assert.equal(weak[0].card.note, '陰性名詞');
    assert.equal('accept' in weak[0].card, false);
  } finally {
    cleanup(store, dir);
  }
});

test('打字題：答對 Good、只差重音 Again、只差大小寫 Hard', async () => {
  const [api, store, dir] = await open();
  try {
    const exact = api.review({ cardId: 'v:ecole', answer: 'école' });
    assert.equal(exact.rating, 3);
    assert.equal(exact.grade.reason, 'exact');
    assert.equal(exact.answer, 'école');
    assert.equal(exact.state.reps, 1);
    assert.ok(exact.state.intervalDays >= 1);

    const accent = api.review({ cardId: 'v:ecole', answer: 'ecole' });
    assert.equal(accent.rating, 1);
    assert.equal(accent.grade.correct, false);
    assert.equal(accent.grade.reason, 'accent');
    assert.equal(accent.state.lapses, 1);

    const caseOnly = api.review({ cardId: 'v:ecole', answer: 'École' });
    assert.equal(caseOnly.rating, 2);
    assert.equal(caseOnly.grade.correct, true);
    assert.equal(caseOnly.grade.reason, 'case');
    // 算對，所以不再多記一次 lapse。
    assert.equal(caseOnly.state.lapses, 1);

    const empty = api.review({ cardId: 'v:ecole', answer: '' });
    assert.equal(empty.rating, 1);
    assert.equal(empty.grade.reason, 'empty');
  } finally {
    cleanup(store, dir);
  }
});

test('自評題由前端給分，且分數必須在 1..4', async () => {
  const [api, store, dir] = await open();
  try {
    const r = api.review({ cardId: 'v:chien', rating: 4 });
    assert.equal(r.rating, 4);
    assert.equal(r.grade, null);

    for (const rating of [0, 5, 2.5, '3', undefined, null]) {
      assert.equal(caught(() => api.review({ cardId: 'v:chien', rating })).status, 400);
    }
  } finally {
    cleanup(store, dir);
  }
});

test('review 缺 cardId 是 400，卡片不存在是 404', async () => {
  const [api, store, dir] = await open();
  try {
    assert.equal(caught(() => api.review({})).status, 400);
    assert.equal(caught(() => api.review({ cardId: '沒有這張', rating: 3 })).status, 404);
  } finally {
    cleanup(store, dir);
  }
});

test('settings 擋掉超出範圍的值，合法的值寫得進去', async () => {
  const [api, store, dir] = await open();
  try {
    assert.deepEqual(api.settings(null), { desiredRetention: 0.9, dailyNewLimit: 15, examDate: null });

    const saved = api.settings({ desiredRetention: 0.85, dailyNewLimit: 30, examDate: '2026-12-01' });
    assert.deepEqual(saved, { desiredRetention: 0.85, dailyNewLimit: 30, examDate: '2026-12-01' });
    assert.equal(store.desiredRetention, 0.85);

    // 0.98 以上的目標記憶率會讓間隔塌成每天複習，擋掉比讓人踩進去好。
    for (const bad of [0.5, 0.99, 'abc']) {
      assert.equal(caught(() => api.settings({ desiredRetention: bad })).status, 400);
    }
    assert.equal(caught(() => api.settings({ examDate: '2026/12/01' })).status, 400);
    // 清掉考試日期是合法動作。
    assert.equal(api.settings({ examDate: null }).examDate, null);
  } finally {
    cleanup(store, dir);
  }
});

test('stats 的每個數字都吃 scope，紀錄檔資訊不吃', async () => {
  const [api, store, dir] = await open();
  try {
    api.review({ cardId: 'v:ecole', answer: 'école' });
    api.review({ cardId: 'c:etre:present:1', answer: 'est' });

    const all = api.stats();
    assert.equal(all.summary.totalCards, 4);
    assert.equal(all.errorProfile.length, 1);

    const conj = api.stats({ kinds: 'conj' });
    assert.deepEqual(conj.scope, { kinds: ['conj'], levels: [] });
    assert.equal(conj.summary.totalCards, 1);
    assert.equal(conj.byKind.length, 1);
    assert.equal(conj.weakest.length, 1);
    // JSONL 量的是磁碟上的檔案，不隨勾選的題型變。
    assert.deepEqual(conj.journal, all.journal);

    const vocab = api.stats({ kinds: 'vocab-produce' });
    assert.deepEqual(vocab.errorProfile, []);
    assert.equal(vocab.weakest.length, 0);
  } finally {
    cleanup(store, dir);
  }
});

test('forecast 要有合法的考試日期才跑', async () => {
  const [api, store, dir] = await open();
  try {
    assert.equal(caught(() => api.forecast({})).status, 400);
    assert.equal(caught(() => api.forecast({ exam: '不是日期' })).status, 400);
    assert.equal(caught(() => api.forecast({ exam: '2020-01-01' })).status, 400);
  } finally {
    cleanup(store, dir);
  }
});

test('forecast 回傳計畫，並且不把整份模擬結果塞進候選方案', async () => {
  const [api, store, dir] = await open();
  try {
    const exam = new Date();
    exam.setDate(exam.getDate() + 21);
    const iso = exam.toISOString().slice(0, 10);

    const f = api.forecast({ exam: iso, target: 0.8 });
    assert.equal(f.plan.examDate, iso);
    assert.equal(f.plan.cardsInScope, 4);
    assert.equal(f.plan.days.length, f.plan.daysUntilExam + 1);
    // 沒有足夠歷史時要老實標成 assumed-good，不要假裝觀察到了分布。
    assert.equal(f.plan.ratingModel, 'assumed-good');
    assert.equal(f.inputs.ratingSample, 0);
    assert.equal(f.inputs.secondsSource, 'default');
    assert.equal(f.inputs.secondsPerCard, 8);

    assert.equal('result' in f.solved.recommended, false);
    assert.equal('result' in f.solved.ceiling, false);
    assert.ok(f.solved.tried.every((t) => !('result' in t)));

    // 沒給 target 就不做反推。
    assert.equal(api.forecast({ exam: iso }).solved, null);

    // scope 會縮小推演範圍。
    assert.equal(api.forecast({ exam: iso, kinds: 'conj' }).plan.cardsInScope, 1);
  } finally {
    cleanup(store, dir);
  }
});

test('作答秒數樣本不足時退回預設值，不拿三五筆去外推', async () => {
  const [api, store, dir] = await open();
  try {
    assert.equal(api.medianSeconds(), 8);
    for (let i = 0; i < 40; i += 1) {
      api.review({ cardId: 'v:chien', rating: 3, ms: 5000 });
    }
    assert.equal(api.medianSeconds(), 5);
  } finally {
    cleanup(store, dir);
  }
});

test('search：空查詢回空陣列，查得到的帶上學習狀態', async () => {
  const [api, store, dir] = await open();
  try {
    assert.deepEqual(api.search({}).hits, []);
    assert.deepEqual(api.search({ q: '   ' }).hits, []);

    const before = api.search({ q: 'école' });
    assert.equal(before.hits.length, 1);
    assert.equal(before.hits[0].card.id, 'v:ecole');
    assert.equal(before.hits[0].state, null);

    api.review({ cardId: 'v:ecole', answer: 'école' });
    const after = api.search({ q: 'école' });
    assert.ok(after.hits[0].state.stability > 0);

    // 用 tag 也查得到，這是「查 être 的變位」會走的路。
    assert.equal(api.search({ q: 'être' }).hits.length, 1);
  } finally {
    cleanup(store, dir);
  }
});

test('verb：查得到就回全表，查不到是 404', async () => {
  const [api, store, dir] = await open();
  try {
    const v = await api.verb('être');
    assert.equal(v.simple['présent'][1], 'es');
    await assert.rejects(() => api.verb('沒有這個動詞'), (err) => err.status === 404);
  } finally {
    cleanup(store, dir);
  }
});

test('summary 給的是整份題庫的數字，不隨側欄勾選變', async () => {
  const [api, store, dir] = await open();
  try {
    const s = api.summary();
    assert.equal(s.totalCards, 4);
    assert.equal(s.byKind.length, 4);
    assert.equal(s.settings.dailyNewLimit, 15);
    assert.equal(s.meta, null);
  } finally {
    cleanup(store, dir);
  }
});
