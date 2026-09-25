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
import { Store, localDay } from '../src/db.mjs';
import { Api, HttpError } from '../src/api.mjs';

const BANK = [
  {
    id: 'v:ecole', kind: 'vocab-produce', mode: 'typed', level: 'A2', freq: 9,
    tags: ['vocab'], answer: 'école', accept: ['école'], note: '陰性名詞',
    front: { word: 'école', gloss: '學校' },
  },
  {
    id: 'v:chien', kind: 'vocab-recall', mode: 'self', level: 'A2', freq: 8,
    tags: ['vocab'], answer: '狗', accept: null,
    front: { word: 'chien', gloss: '狗', en: ['dog'], glossSource: 'manual' },
  },
  {
    id: 'k:bien-que', kind: 'connector', mode: 'choice', level: 'B1', freq: 0,
    tags: ['connector', 'subjonctif'], answer: 'subjonctif', accept: ['subjonctif'],
    front: {
      connector: 'bien que', options: ['indicatif', 'subjonctif'],
      moodRaw: 'Subjonctif', fn: '對立讓步',
    },
  },
  {
    id: 'c:etre:present:1', kind: 'conj', mode: 'typed', level: 'A2', freq: 7,
    tags: ['conj', 'être'], answer: 'es', accept: ['es'], front: { verb: 'être', pronoun: 'tu' },
  },
  {
    id: 'p:IIA|1', kind: 'pick', mode: 'typed', level: 'B1', freq: 0,
    tags: ['pick', 'IIA'], answer: "à moins qu'", accept: ["à moins qu'"],
    front: {
      prompt: "J'ai du jus ___ vous préfériez de l'eau",
      options: ['sans que', 'à moins que', 'à moins de', 'sinon'],
      group: 'A', sec: 'II', src: '教材 111-2 II',
    },
  },
  {
    id: 'rw:III|2', kind: 'rw', mode: 'rewrite', level: 'B1', freq: 0,
    tags: ['rw', 'rwIII'], answer: "Si agréable qu'il soit, je ne le supporte pas.",
    accept: null, must: [['si agréable'], ['soit']], note: 'si + adj + que + subj',
    front: {
      prompt: 'Il est très agréable, mais…', tool: 'si … que + subj',
      sec: 'III', num: '2', src: '教材 111-2 III',
    },
  },
  {
    id: 'n:absent|ADJ', kind: 'nom', mode: 'typed', level: 'B1', freq: 0,
    tags: ['nom', 'nomIV'], answer: 'son absence',
    accept: ['son absence', "l'absence"], noun: 'absence',
    front: { base: 'absent', pos: 'ADJ', posZh: '形容詞', gloss: '缺席的', src: '[教材 111-2 IV]' },
  },
];

async function open(bank = BANK) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cadence-api-'));
  mkdirSync(path.join(dir, 'bank'), { recursive: true });
  writeFileSync(path.join(dir, 'bank', 'cards.json'), JSON.stringify(bank), 'utf8');
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
  assert.deepEqual(Api.scope({ kinds: 'conj,connector', levels: 'A2' }), {
    kinds: ['conj', 'connector'], levels: ['A2'],
  });
  // 空白與空項要被吃掉，不要變成查不到東西的 IN ('')。
  assert.deepEqual(Api.scope({ kinds: ' conj , ,' }).kinds, ['conj']);

  const err = caught(() => Api.scope({ kinds: 'conj,drop-table' }));
  assert.ok(err instanceof HttpError);
  assert.equal(err.status, 400);
  assert.match(err.message, /drop-table/);
  assert.equal(caught(() => Api.scope({ levels: 'C1' })).status, 400);
  assert.equal(caught(() => Api.scope({ levels: 'A1' })).status, 400);
});

test('出題不帶答案，統計裡的弱點卡才帶', async () => {
  const [api, store, dir] = await open();
  try {
    const q = api.queue({ limit: 10 });
    for (const c of q.cards) {
      assert.equal('answer' in c, false, `${c.id} 把答案送出去了`);
      assert.equal('accept' in c, false);
      assert.equal('note' in c, false);
      assert.equal(BANK.some((source) => source.id === c.id), false, '題庫 id 可能直接暴露答案');
    }
    const recall = q.cards.find((c) => c.kind === 'vocab-recall');
    assert.equal(recall.front.gloss, undefined);
    assert.equal(recall.front.en, undefined);
    assert.equal(recall.front.glossSource, undefined);
    const produce = q.cards.find((c) => c.kind === 'vocab-produce');
    assert.equal(produce.front.word, undefined);
    const connector = q.cards.find((c) => c.kind === 'connector');
    assert.equal(connector.front.moodRaw, undefined);
    assert.equal(connector.front.fn, undefined);
    // 選擇題的選項要留著，否則畫面畫不出來。
    assert.deepEqual(connector.front.options, ['indicatif', 'subjonctif']);
    assert.equal(q.remaining.due + q.remaining.new, BANK.length);
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

test('看字回想的釋義要翻面才取回，其他題型不能走 reveal', async () => {
  const [api, store, dir] = await open();
  try {
    const recall = api.queue({ kinds: 'vocab-recall', limit: 1 }).cards[0];
    assert.notEqual(recall.id, 'v:chien');
    const { intervals, ...shown } = api.reveal({ id: recall.id });
    assert.deepEqual(shown, { gloss: '狗', en: ['dog'], glossSource: 'manual' });
    // 評分鍵上的預覽：四個、整數天、至少 1 天、分數越高排得越遠（不會倒過來）。
    assert.equal(intervals.length, 4);
    for (const d of intervals) assert.ok(Number.isInteger(d) && d >= 1, `${d}`);
    for (let i = 1; i < 4; i += 1) assert.ok(intervals[i] >= intervals[i - 1], intervals.join(','));
    assert.equal(caught(() => api.reveal({ id: 'v:ecole' })).status, 400);
    assert.equal(caught(() => api.reveal({ id: '沒有這張' })).status, 404);
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

test('連接詞的功能提示只在作答後回傳', async () => {
  const [api, store, dir] = await open();
  try {
    const card = api.queue({ kinds: 'connector', limit: 1 }).cards[0];
    assert.equal(card.front.fn, undefined);
    const result = api.review({ cardId: card.id, answer: 'subjonctif' });
    assert.equal(result.fn, '對立讓步');
  } finally {
    cleanup(store, dir);
  }
});

test('挑連接詞題走三級批改，三種錯都是 Again', async () => {
  // 這題型的錯法要分得出來，但分級只影響回饋，不影響「對或錯」。
  // 省音沒寫在考卷上照樣不給分，這裡也就不能給 Hard。
  const [api, store, dir] = await open();
  try {
    const ok = api.review({ cardId: 'p:IIA|1', answer: "à moins qu'" });
    assert.equal(ok.grade.reason, 'exact');
    assert.equal(ok.rating, 3);

    const el = api.review({ cardId: 'p:IIA|1', answer: 'à moins que' });
    assert.equal(el.grade.reason, 'elision');
    assert.equal(el.grade.correct, false);
    assert.equal(el.rating, 1);

    // 同一個方框裡的另一格是選錯格，不是形式錯。
    const wrong = api.review({ cardId: 'p:IIA|1', answer: 'à moins de' });
    assert.equal(wrong.grade.reason, 'wrong');
    assert.equal(wrong.rating, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('改寫題要素齊全時先回自評，這一趟不記錄', async () => {
  // 整句沒有唯一解，只能自評；自評又必須看得到解答，
  // 而解答不能在作答前送到前端。兩趟就是為了同時滿足這兩件事。
  const [api, store, dir] = await open();
  try {
    const first = api.review({
      cardId: 'rw:III|2',
      answer: 'Si agréable soit-il, je ne le supporte pas.',
    });
    assert.equal(first.phase, 'self');
    assert.equal(first.answer, "Si agréable qu'il soit, je ne le supporte pas.");
    assert.equal(first.state, undefined);
    // 沒按自評就關掉視窗，不該留下半筆紀錄。
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM reviews').get().n, 0);

    const second = api.review({
      cardId: 'rw:III|2',
      answer: 'Si agréable soit-il, je ne le supporte pas.',
      rating: 3,
    });
    assert.equal(second.phase, 'done');
    assert.equal(second.rating, 3);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM reviews').get().n, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('改寫題缺了必要要素就當場判錯，不進自評', async () => {
  // 指定的連接詞或它要求的語氣缺一，意思再接近也不算改對。
  const [api, store, dir] = await open();
  try {
    const res = api.review({
      cardId: 'rw:III|2',
      answer: 'Il est très agréable mais je ne le supporte pas.',
    });
    assert.equal(res.phase, 'done');
    assert.equal(res.grade.reason, 'missing');
    assert.equal(res.rating, 1);
    assert.deepEqual(res.grade.miss, [['si agréable'], ['soit']]);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('改寫題自評「差很多」要記成答錯', async () => {
  // 要素齊全只代表連接詞用對了，不代表整句寫得出來。
  // 記成答對的話，統計會把一句自己都看不下去的答案算進正確率。
  const [api, store, dir] = await open();
  try {
    const res = api.review({
      cardId: 'rw:III|2',
      answer: 'Si agréable soit-il, blah blah.',
      rating: 1,
    });
    assert.equal(res.rating, 1);
    const row = store.db.prepare('SELECT correct FROM reviews WHERE card_id = ?').get('rw:III|2');
    assert.equal(row.correct, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('名詞化：冠詞算分，但「只錯冠詞」跟「用錯名詞」分開報', async () => {
  // 考卷第 IV 大題寫錯 le／la 就沒分，所以 correct 一律 false。
  // 但這兩種錯的補救方式完全不同，統計上必須分得開。
  const [api, store, dir] = await open();
  try {
    const ok = api.review({ cardId: 'n:absent|ADJ', answer: "l'absence" });
    assert.equal(ok.grade.correct, true);
    assert.equal(ok.rating, 3);

    const art = api.review({ cardId: 'n:absent|ADJ', answer: 'la absence' });
    assert.equal(art.grade.correct, false);
    assert.equal(art.grade.reason, 'article');
    assert.equal(art.rating, 1);

    const bad = api.review({ cardId: 'n:absent|ADJ', answer: "l'absent" });
    assert.equal(bad.grade.reason, 'wrong');
  } finally {
    cleanup(store, dir);
  }
});

test('名詞化出題時 noun 不能跟著送出去', async () => {
  // noun 是名詞本體，等於答案去掉冠詞。留在回應裡只剩冠詞要猜。
  const [api, store, dir] = await open();
  try {
    const q = api.queue({ kinds: 'nom', limit: 5 });
    assert.equal(q.cards.length, 1);
    const [card] = q.cards;
    assert.equal(card.noun, undefined);
    assert.equal(card.answer, undefined);
    assert.equal(card.accept, undefined);
    // 性別在建置階段就沒放進 front，這裡再確認一次它沒有從別條路徑漏回來。
    assert.equal(card.front.gender, undefined);
    assert.equal(card.front.base, 'absent');
  } finally {
    cleanup(store, dir);
  }
});

test('改寫題出題時必要要素不能跟著送出去', async () => {
  // must 的內容就是答案片段，留在回應裡等於把答案印在 network 面板上。
  const [api, store, dir] = await open();
  try {
    const q = api.queue({ kinds: 'rw', limit: 5 });
    assert.equal(q.cards.length, 1);
    const [card] = q.cards;
    assert.equal(card.must, undefined);
    assert.equal(card.answer, undefined);
    assert.equal(card.front.tool, 'si … que + subj');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('挑連接詞題出題時方框留著，答案不留', async () => {
  // 方框是題目的一部分——藏起來就換成了另一種題目。
  const [api, store, dir] = await open();
  try {
    const q = api.queue({ kinds: 'pick', limit: 5 });
    assert.equal(q.cards.length, 1);
    const [card] = q.cards;
    assert.equal(card.front.options.length, 4);
    assert.equal(card.answer, undefined);
    assert.equal(card.accept, undefined);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('自評題由前端給分，且分數必須在 1..4', async () => {
  const [api, store, dir] = await open();
  try {
    const r = api.review({ cardId: 'v:chien', rating: 4 });
    assert.equal(r.rating, 4);
    assert.equal(r.grade, null);
    assert.equal(r.answer, '狗');
    assert.deepEqual(r.en, ['dog']);
    assert.equal(r.glossSource, 'manual');

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

    const saved = api.settings({ desiredRetention: 0.85, dailyNewLimit: 30, examDate: '2026-12-01', startLevel: null });
    assert.deepEqual(saved, { desiredRetention: 0.85, dailyNewLimit: 30, examDate: '2026-12-01' });

    // null 是不設上限。Number(null) 是 0，若誤丟給 clampInt 就會變成「一張都不給」。
    assert.equal(api.settings({ dailyNewLimit: null }).dailyNewLimit, null);
    assert.equal(api.settings({ dailyNewLimit: 20 }).dailyNewLimit, 20);
    assert.equal(caught(() => api.settings({ startLevel: 'C1' })).status, 400);
    assert.equal(caught(() => api.settings({ startLevel: 'A1' })).status, 400);
    assert.deepEqual(api.settings({ startLevel: null }), api.settings(null));
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
    assert.equal(all.summary.totalCards, BANK.length);
    assert.equal(all.errorProfile.length, 1);

    const conj = api.stats({ kinds: 'conj' });
    assert.deepEqual(conj.scope, { kinds: ['conj'], levels: [], active: true });
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
    assert.equal(f.plan.cardsInScope, BANK.length);
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

test('search：中文釋義查得到，變位卡以動詞計為一組', async () => {
  const [api, store, dir] = await open();
  try {
    // 中文只存在 payload 的 front 裡，answer／tags／id 都沒有。
    // 沒有 search 欄的話這一查會是 0 筆——中翻法那批卡的題面就是中文。
    const zh = api.search({ q: '學校' });
    assert.equal(zh.hits.length, 1);
    assert.equal(zh.hits[0].card.id, 'v:ecole');

    // nom 卡的釋義在 front.gloss。
    assert.equal(api.search({ q: '缺席' }).hits[0].card.id, 'n:absent|ADJ');
    // connector 的中文若沒寫就不該硬湊，但法文本身要查得到。
    assert.equal(api.search({ q: 'bien que' }).hits.length, 1);

    // 上限套在「組」上：變位卡整個動詞算一組。
    const verb = api.search({ q: 'être' });
    assert.equal(verb.groups, 1);
    assert.equal(verb.total, verb.hits.length);
    assert.equal(verb.truncated, false);
  } finally {
    cleanup(store, dir);
  }
});

test('search：完全相符的詞頭排在高頻模糊結果前面', async () => {
  const bank = [
    {
      id: 'v:chaton', kind: 'vocab-recall', mode: 'self', level: 'A1', freq: 100,
      tags: ['vocab'], front: { word: 'chaton', gloss: '小貓' },
    },
    {
      id: 'v:chat', kind: 'vocab-recall', mode: 'self', level: 'A1', freq: 1,
      tags: ['vocab'], front: { word: 'chat', gloss: '貓' },
    },
  ];
  const [api, store, dir] = await open(bank);
  try {
    assert.equal(api.search({ q: 'chat' }).hits[0].card.id, 'v:chat');
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
    assert.equal(s.totalCards, BANK.length);
    assert.equal(s.byKind.length, 7);
    assert.equal(s.settings.dailyNewLimit, 15);
    assert.equal(s.meta, null);
  } finally {
    cleanup(store, dir);
  }
});

test('today：四科都在，題型全部歸了科，且不隨側欄勾選變', async () => {
  const [api, store, dir] = await open();
  try {
    store.set('examDate', '2027-05-01');
    const t = api.today();
    assert.deepEqual(t.tasks.map((x) => x.id), ['CE', 'PE', 'CO', 'PO']);
    assert.equal(t.examDate, '2027-05-01');
    // BANK 裡七種題型各一張：CE 拿 vocab-recall 那張，其餘六張都是 PE。
    assert.equal(t.tasks[0].total, 1);
    assert.equal(t.tasks[1].total, 6);
    // today() 不吃參數，所以沒有「被篩選改掉」這回事——這一行是防止有人日後加上去。
    assert.equal(api.today.length, 0);
  } finally {
    cleanup(store, dir);
  }
});

test('today：新卡額度扣掉今天已引入的量', async () => {
  const [api, store, dir] = await open();
  try {
    store.set('dailyNewLimit', 3);
    assert.equal(api.today().newBudget, 3);
    const card = api.queue({ limit: 1, kinds: 'vocab-recall' }).cards[0];
    api.review({ cardId: card.id, rating: 3 });
    const t = api.today();
    assert.equal(t.newToday, 1);
    assert.equal(t.newBudget, 2);
    assert.equal(t.reviewsToday, 1);
  } finally {
    cleanup(store, dir);
  }
});

test('today／queue：不設上限時額度欄位回 null，新卡數以還能學的張數為準', async () => {
  const [api, store, dir] = await open();
  try {
    store.set('dailyNewLimit', null);
    const t = api.today();
    assert.equal(t.newLimit, null);
    assert.equal(t.newBudget, null);
    assert.equal(t.tasks[0].newUnlimited, true);
    assert.equal(t.tasks[0].newAvailable, 1);
    assert.equal(t.tasks[1].newAvailable, 6);
    const q = api.queue({ limit: 20 });
    assert.equal(q.newLimit, null);
    assert.equal(q.cards.length, BANK.length);
  } finally {
    cleanup(store, dir);
  }
});

test('A1 單字不出新卡，但 A1 變位照出、學過的 A1 卡照常到期', async () => {
  const a1 = { id: 'a1:bonjour', kind: 'vocab-recall', mode: 'self', level: 'A1', freq: 99, tags: ['vocab'], front: { word: 'bonjour', gloss: '你好' } };
  const a1conj = {
    id: 'c:avoir|pres|0', kind: 'conj', mode: 'typed', level: 'A1', freq: 50, tags: ['conj'],
    answer: 'ai', accept: ['ai'], front: { infinitive: 'avoir', tense: '現在式', person: 'je' },
  };
  const [api, store, dir] = await open([...BANK, a1, a1conj]);
  try {
    const q = api.queue({ limit: 20 });
    assert.equal(q.cards.some((card) => card.level === 'A1' && card.kind !== 'conj'), false);
    assert.equal(q.cards.some((card) => card.kind === 'conj' && card.level === 'A1'), true);
    assert.equal(q.remaining.new, BANK.length + 1);
    assert.equal('startLevel' in api.today(), false);
    assert.equal(api.summary().totalCards, BANK.length + 1);
    assert.equal(api.search({ q: 'bonjour' }).hits[0].card.level, 'A1');

    // 以前學過的 A1 單字卡：到期了就要回到佇列，不能因為等級被藏起來。
    api.review({ cardId: a1.id, rating: 3 });
    assert.ok(api.search({ q: 'bonjour' }).hits[0].state);
    assert.equal(api.summary().totalCards, BANK.length + 2);
    const later = new Date(Date.now() + 400 * 86_400_000);
    const due = store.queue({ ...Api.activeScope(), limit: 20, now: later, newLimit: 0 });
    assert.ok(due.some((card) => card.id === a1.id));

    // 側欄明確勾了 A2 就只照勾的，A1 變位也不出。
    const onlyA2 = api.queue({ limit: 20, levels: 'A2' });
    assert.equal(onlyA2.cards.some((card) => card.level === 'A1'), false);
  } finally {
    cleanup(store, dir);
  }
});

test('推演遵守中翻法解鎖門檻', async () => {
  const pair = [
    { id: 'v:ami|r', kind: 'vocab-recall', mode: 'self', level: 'A2', freq: 2, tags: ['vocab'], front: { word: 'ami', gloss: '朋友' } },
    { id: 'v:ami|p', kind: 'vocab-produce', mode: 'typed', level: 'A2', freq: 2, tags: ['vocab'], answer: 'ami', accept: ['ami'], front: { gloss: '朋友' } },
  ];
  const [api, store, dir] = await open(pair);
  try {
    assert.equal(api.scopedStates(Api.activeScope()).find((card) => card.id.endsWith('|p')).prerequisite, 'v:ami|r');
    api.review({ cardId: 'v:ami|r', rating: 3 });
    assert.equal(api.scopedStates(Api.activeScope()).find((card) => card.id.endsWith('|p')).prerequisite, undefined);
  } finally { cleanup(store, dir); }
});

test('doc：只認白名單的三個代號，路徑不可能被塞進來', async () => {
  const [api, store, dir] = await open();
  try {
    const po = await api.doc({ id: 'po' });
    assert.equal(po.path, 'study/delf-b1-production-orale.md');
    assert.match(po.text, /production orale/i);
    const co = await api.doc({ id: 'co' });
    assert.equal(co.path, 'study/delf-b1-comprehension-orale.md');
    const pe = await api.doc({ id: 'pe' });
    assert.equal(pe.path, 'study/delf-b1-production-ecrite.md');
    assert.match(pe.text, /production écrite/i);

    for (const bad of ['', 'PO', '../package.json', 'study/delf-b1-production-orale.md', undefined]) {
      const err = await api.doc({ id: bad }).then(() => null, (e) => e);
      assert.ok(err instanceof HttpError, `${bad} 應該被擋下來`);
      assert.equal(err.status, 404);
    }
  } finally {
    cleanup(store, dir);
  }
});

test('打卡回傳整份 today，前端不必自己猜新狀態', async () => {
  const [api, store, dir] = await open();
  try {
    const before = api.today();
    const co = (t) => t.tasks.find((x) => x.id === 'CO');
    assert.equal(co(before).done, false);
    assert.equal(before.pendingChecks, 3);

    const after = api.checkin({ skill: 'CO' });
    assert.equal(co(after).done, true);
    assert.equal(co(after).recent, 1);
    assert.equal(after.pendingChecks, 2);
    // 再讀一次 today 要一樣：回傳的那份不是臨時湊出來的。
    assert.equal(co(api.today()).done, true);

    const undone = api.checkin({ skill: 'CO', done: false });
    assert.equal(co(undone).done, false);
    assert.equal(undone.pendingChecks, 3);
  } finally {
    cleanup(store, dir);
  }
});

test('打卡只認 CO／PE／PO，其餘一律 400', async () => {
  const [api, store, dir] = await open();
  try {
    for (const bad of ['CE', 'pe', 'co', '', undefined, null]) {
      const err = (() => { try { api.checkin({ skill: bad }); return null; } catch (e) { return e; } })();
      assert.ok(err instanceof HttpError, `${bad} 應該被擋下來`);
      assert.equal(err.status, 400);
    }
    // 擋下來就不該留下任何紀錄。
    assert.equal(store.checkinState().CO.lastDay, null);
  } finally {
    cleanup(store, dir);
  }
});

test('PE 打卡不會動到卡片那一半的數字', async () => {
  const [api, store, dir] = await open();
  try {
    const before = api.today().tasks.find((x) => x.id === 'PE');
    const after = api.checkin({ skill: 'PE' }).tasks.find((x) => x.id === 'PE');
    // 打卡記的是「今天寫了一篇作文」，跟到期卡是兩件事。
    // 混在一起的話，按一下打卡就會讓今天該練的卡憑空少掉。
    assert.equal(after.done, true);
    assert.equal(after.mode, 'cards');
    assert.equal(after.tracked, true);
    assert.equal(after.due, before.due);
    assert.equal(after.count, before.count);
    assert.equal(after.total, before.total);
  } finally {
    cleanup(store, dir);
  }
});

test('打卡不吃前端傳來的日期：事實檔只寫得進今天', async () => {
  const [api, store, dir] = await open();
  try {
    api.checkin({ skill: 'PO', day: '2020-01-01' });
    const po = api.today().tasks.find((x) => x.id === 'PO');
    // 日期由伺服器決定，補打舊日期這件事沒有被順手開出來。
    assert.equal(po.lastDay, localDay(new Date()));
  } finally {
    cleanup(store, dir);
  }
});

test('preview：名詞化與改寫整句的新卡先看解答，只讀、學過就不給', async () => {
  const [api, store, dir] = await open();
  try {
    const rw = api.preview({ id: 'rw:III|2' });
    assert.ok(rw.answer);
    assert.equal(rw.must, undefined);
    const nom = api.preview({ id: 'n:absent|ADJ' });
    assert.ok(nom.answer);
    // 看解答不算作答：沒有排程狀態、紀錄檔沒有多一行。
    assert.equal(store.state('n:absent|ADJ'), null);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM reviews').get().n, 0);

    // queue 發出去的是代號，preview 也要認得代號。
    const token = api.queue({ limit: 20, kinds: 'nom' }).cards[0].id;
    assert.equal(api.preview({ id: token }).answer, nom.answer);

    assert.equal(caught(() => api.preview({ id: 'v:chien' })).status, 400);
    assert.equal(caught(() => api.preview({ id: 'nope' })).status, 404);
    api.review({ cardId: 'n:absent|ADJ', answer: nom.answer });
    assert.equal(caught(() => api.preview({ id: 'n:absent|ADJ' })).status, 400);
  } finally {
    cleanup(store, dir);
  }
});
