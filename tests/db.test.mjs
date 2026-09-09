/**
 * 儲存層測試。
 *
 * 這一層的核心承諾只有一句：**兩個 JSONL 是唯一的事實來源，SQLite 隨時可以丟掉重建**。
 * 所以測試的重點放在「重建之後拿到的東西要跟原本一模一樣」，
 * 以及「一行壞掉不會賠掉整份紀錄」。其餘的統計查詢測的是 scope 有沒有真的吃進去——
 * 側欄說「只練 A2」，畫面上的每個數字就都得是 A2 的。
 *
 * 全部在 os.tmpdir() 底下跑，不碰使用者真正的 data/。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, localDay, CHECKIN_SKILLS } from '../src/db.mjs';

const DAY_MS = 86_400_000;

/** 一張最小可用的卡。payload 就是卡本身，資料庫存的是它的 JSON。 */
function card(id, over = {}) {
  return {
    id,
    kind: 'vocab-recall',
    mode: 'choice',
    level: 'A1',
    freq: 1,
    tags: ['test'],
    answer: id,
    accept: [id],
    front: { word: id },
    ...over,
  };
}

const BANK = [
  card('a1-recall-1', { freq: 9 }),
  card('a1-recall-2', { freq: 5 }),
  card('a2-recall-1', { level: 'A2', freq: 7 }),
  card('a1-conj-1', { kind: 'conj', mode: 'type', freq: 3 }),
  card('a2-conj-1', { kind: 'conj', mode: 'type', level: 'A2', freq: 8 }),
];

/** 開一個臨時 Store，題庫已灌好。回傳 [store, dir]。 */
async function open(bank = BANK) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cadence-db-'));
  mkdirSync(path.join(dir, 'bank'), { recursive: true });
  writeFileSync(path.join(dir, 'bank', 'cards.json'), JSON.stringify(bank), 'utf8');
  const store = new Store(dir);
  await store.loadBank();
  return [store, dir];
}

function cleanup(store, dir) {
  store.close();
  rmSync(dir, { recursive: true, force: true });
}

test('localDay 用本地時區切日，深夜複習不會被算到隔天', () => {
  const lateNight = new Date(2026, 8, 9, 23, 45);
  assert.equal(localDay(lateNight), '2026-09-09');
  const earlyMorning = new Date(2026, 8, 10, 0, 15);
  assert.equal(localDay(earlyMorning), '2026-09-10');
});

test('loadBank 灌題庫，card() 拿得回完整卡片', async () => {
  const [store, dir] = await open();
  try {
    assert.equal(store.cardCount(), 5);
    const c = store.card('a1-recall-1');
    assert.equal(c.freq, 9);
    assert.deepEqual(c.accept, ['a1-recall-1']);
    assert.equal(store.card('沒有這張'), null);
  } finally {
    cleanup(store, dir);
  }
});

test('重灌題庫會清掉指向不存在卡片的狀態', async () => {
  const [store, dir] = await open();
  try {
    store.review({ cardId: 'a2-conj-1', rating: 3, correct: true });
    assert.ok(store.state('a2-conj-1'));
    // 新題庫裡沒有 a2-conj-1 了。留著孤兒狀態會讓 summary 的 seen 大於 total。
    writeFileSync(
      path.join(dir, 'bank', 'cards.json'),
      JSON.stringify(BANK.filter((c) => c.id !== 'a2-conj-1')),
      'utf8',
    );
    await store.loadBank();
    assert.equal(store.state('a2-conj-1'), null);
    assert.equal(store.cardCount(), 4);
  } finally {
    cleanup(store, dir);
  }
});

test('review() 先寫 JSONL 再更新索引，兩邊都要有', async () => {
  const [store, dir] = await open();
  try {
    const at = new Date(2026, 8, 9, 10, 0);
    const state = store.review({ cardId: 'a1-recall-1', rating: 3, answered: 'école', correct: true, reason: 'exact', ms: 1200, at });
    assert.ok(state.stability > 0);
    assert.equal(state.reps, 1);
    assert.equal(state.lapses, 0);

    const lines = readFileSync(path.join(dir, 'reviews.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.v, 1);
    assert.equal(entry.card, 'a1-recall-1');
    assert.equal(entry.day, '2026-09-09');
    assert.equal(entry.answered, 'école');
    assert.equal(entry.correct, true);
    assert.equal(entry.elapsed, 0);
  } finally {
    cleanup(store, dir);
  }
});

test('review() 對不存在的卡直接丟錯，不會寫進紀錄', async () => {
  const [store, dir] = await open();
  try {
    assert.throws(() => store.review({ cardId: '沒有這張', rating: 3 }), /找不到卡片/);
    assert.equal(store.journalInfo().exists, false);
  } finally {
    cleanup(store, dir);
  }
});

test('reps 與 lapses 會累加，答錯才算一次 lapse', async () => {
  const [store, dir] = await open();
  try {
    const day = (n) => new Date(2026, 8, 9 + n, 10, 0);
    store.review({ cardId: 'a1-recall-1', rating: 3, correct: true, at: day(0) });
    store.review({ cardId: 'a1-recall-1', rating: 1, correct: false, reason: 'accent', at: day(1) });
    store.review({ cardId: 'a1-recall-1', rating: 3, correct: true, at: day(2) });
    const s = store.state('a1-recall-1');
    assert.equal(s.reps, 3);
    assert.equal(s.lapses, 1);
  } finally {
    cleanup(store, dir);
  }
});

test('reindex 從 JSONL 重算，結果與原本逐位元相同', async () => {
  const [store, dir] = await open();
  try {
    const day = (n) => new Date(2026, 8, 1 + n, 10, 0);
    for (let i = 0; i < 6; i += 1) {
      store.review({ cardId: 'a1-recall-1', rating: (i % 4) + 1, correct: i % 4 !== 0, at: day(i) });
      store.review({ cardId: 'a2-conj-1', rating: 3, correct: true, at: day(i) });
    }
    const before = store.allStates();
    const summaryBefore = store.summary({}, day(6));

    const result = await store.reindex();
    assert.equal(result.applied, 12);
    assert.equal(result.skipped, 0);
    assert.deepEqual(store.allStates(), before);
    assert.deepEqual(store.summary({}, day(6)), summaryBefore);
  } finally {
    cleanup(store, dir);
  }
});

test('reindex 遇到壞掉的行只跳過那一行，其餘照樣救回來', async () => {
  const [store, dir] = await open();
  try {
    store.review({ cardId: 'a1-recall-1', rating: 3, correct: true, at: new Date(2026, 8, 1, 10) });
    // 模擬寫到一半斷電：半行 JSON，加上一行欄位不齊的紀錄。
    appendFileSync(path.join(dir, 'reviews.jsonl'), '{"v":1,"card":"a1-rec\n', 'utf8');
    appendFileSync(path.join(dir, 'reviews.jsonl'), '{"v":1,"card":"a1-recall-2"}\n', 'utf8');
    appendFileSync(path.join(dir, 'reviews.jsonl'), '\n', 'utf8');
    store.review({ cardId: 'a2-conj-1', rating: 3, correct: true, at: new Date(2026, 8, 2, 10) });

    const result = await store.reindex();
    assert.equal(result.applied, 2);
    assert.equal(result.skipped, 2);
    assert.deepEqual(result.bad.map((b) => b.line), [2, 3]);
    // 好的兩筆都還在。
    assert.ok(store.state('a1-recall-1'));
    assert.ok(store.state('a2-conj-1'));
    assert.equal(store.state('a1-recall-2'), null);
  } finally {
    cleanup(store, dir);
  }
});

test('scope 會套用到每一個統計數字，不是只套用在其中幾個', async () => {
  const [store, dir] = await open();
  try {
    const now = new Date(2026, 8, 9, 12, 0);
    store.review({ cardId: 'a1-recall-1', rating: 3, correct: true, at: now });
    store.review({ cardId: 'a2-conj-1', rating: 1, correct: false, reason: 'accent', at: now });

    const all = store.summary({}, now);
    assert.equal(all.totalCards, 5);
    assert.equal(all.seenCards, 2);
    assert.equal(all.totalReviews, 2);

    const conj = store.summary({ kinds: ['conj'] }, now);
    assert.equal(conj.totalCards, 2);
    assert.equal(conj.seenCards, 1);
    assert.equal(conj.totalReviews, 1);
    assert.equal(conj.todayReviews, 1);
    assert.equal(conj.todayCorrect, 0);

    const a2 = store.summary({ levels: ['A2'] }, now);
    assert.equal(a2.totalCards, 2);

    const a2conj = store.summary({ kinds: ['conj'], levels: ['A2'] }, now);
    assert.equal(a2conj.totalCards, 1);
    assert.equal(a2conj.newCards, 0);

    // 各 kind 的 total 加起來要等於不分 scope 的總數，否則其中一邊算錯了。
    const kinds = store.byKind({}, now);
    assert.equal(kinds.reduce((a, k) => a + k.total, 0), all.totalCards);
    assert.equal(store.byKind({ kinds: ['conj'] }, now).length, 1);

    assert.equal(store.errorProfile().length, 1);
    assert.deepEqual(store.errorProfile({ kinds: ['conj'] }), [{ reason: 'accent', count: 1 }]);
    assert.deepEqual(store.errorProfile({ kinds: ['vocab-recall'] }), []);

    assert.equal(store.daily(30, {}, now).length, 1);
    assert.equal(store.daily(30, { kinds: ['conj'] }, now)[0].count, 1);
    assert.equal(store.daily(30, { kinds: ['conj'] }, now)[0].correct, 0);
  } finally {
    cleanup(store, dir);
  }
});

test('newCount 與 dueCount 也吃 scope', async () => {
  const [store, dir] = await open();
  try {
    const now = new Date(2026, 8, 9, 12, 0);
    store.review({ cardId: 'a1-recall-1', rating: 1, correct: false, at: now });
    assert.equal(store.newCount(), 4);
    assert.equal(store.newCount({ kinds: ['conj'] }), 2);
    // 評 1 分的卡幾分鐘後就到期，隔天一定在到期清單裡。
    const tomorrow = new Date(now.getTime() + DAY_MS);
    assert.equal(store.dueCount({}, tomorrow), 1);
    assert.equal(store.dueCount({ kinds: ['conj'] }, tomorrow), 0);
  } finally {
    cleanup(store, dir);
  }
});

test('queue 先給到期卡，剩餘額度按頻率補新卡', async () => {
  const [store, dir] = await open();
  try {
    const now = new Date(2026, 8, 9, 12, 0);
    store.review({ cardId: 'a1-recall-2', rating: 1, correct: false, at: now });
    const tomorrow = new Date(now.getTime() + DAY_MS);

    const q = store.queue({ limit: 3, now: tomorrow });
    assert.equal(q[0].id, 'a1-recall-2');
    assert.ok(q[0].state);
    // 其餘按 freq 由高到低：a1-recall-1(9)、a2-conj-1(8)。
    assert.deepEqual(q.slice(1).map((c) => c.id), ['a1-recall-1', 'a2-conj-1']);
    assert.equal(q[1].state, null);

    // scope 會一路帶進新卡的挑選。
    const onlyA1 = store.queue({ limit: 5, now: tomorrow, levels: ['A1'] });
    assert.deepEqual(onlyA1.map((c) => c.id), ['a1-recall-2', 'a1-recall-1', 'a1-conj-1']);
  } finally {
    cleanup(store, dir);
  }
});

test('每日新卡上限用完之後，queue 不再補新卡', async () => {
  const [store, dir] = await open();
  try {
    const now = new Date();
    assert.equal(store.newIntroducedToday(), 0);
    store.review({ cardId: 'a1-recall-1', rating: 3, correct: true, at: now });
    store.review({ cardId: 'a1-recall-2', rating: 3, correct: true, at: now });
    // 同一張卡再答一次不算「今天新學的又多一張」。
    store.review({ cardId: 'a1-recall-1', rating: 3, correct: true, at: now });
    assert.equal(store.newIntroducedToday(), 2);

    const q = store.queue({ limit: 10, now, newLimit: 2 });
    assert.equal(q.filter((c) => c.state === null).length, 0);
    assert.equal(store.queue({ limit: 10, now, newLimit: 3 }).filter((c) => c.state === null).length, 1);
  } finally {
    cleanup(store, dir);
  }
});

test('streak 連續才算，斷一天就歸零', async () => {
  const [store, dir] = await open();
  try {
    const now = new Date();
    const back = (n) => new Date(now.getTime() - n * DAY_MS);
    for (const n of [0, 1, 2]) store.review({ cardId: 'a1-recall-1', rating: 3, correct: true, at: back(n) });
    assert.equal(store.streak({}, now), 3);

    // 第 4 天前也練過，但第 3 天沒練——連續就斷在那裡。
    store.review({ cardId: 'a1-recall-1', rating: 3, correct: true, at: back(4) });
    assert.equal(store.streak({}, now), 3);

    // 今天還沒練但昨天練過，連續天數要保留（今天還來得及），仍然斷在中間那一天。
    assert.equal(store.streak({}, new Date(now.getTime() + DAY_MS)), 3);
    // 隔了兩天沒練就歸零。
    assert.equal(store.streak({}, new Date(now.getTime() + 3 * DAY_MS)), 0);
    // 沒有任何紀錄時是 0，不是 1。
    assert.equal(store.streak({ kinds: ['connector'] }, now), 0);
  } finally {
    cleanup(store, dir);
  }
});

test('upcoming 把已經到期的算成 backlog，不混進未來幾天的圖', async () => {
  const [store, dir] = await open();
  try {
    const now = new Date(2026, 8, 9, 12, 0);
    store.review({ cardId: 'a1-recall-1', rating: 1, correct: false, at: now });
    store.review({ cardId: 'a2-conj-1', rating: 4, correct: true, at: now });

    const later = new Date(now.getTime() + 2 * DAY_MS);
    const up = store.upcoming(60, {}, later);
    assert.equal(up.backlog, 1);
    assert.ok(up.days.every((d) => d.day > localDay(later)));
    assert.equal(up.days.reduce((a, d) => a + d.count, 0) + up.backlog, 2);
  } finally {
    cleanup(store, dir);
  }
});

test('dueCount 與 upcoming.backlog 用同一條界線：當天稍晚到期的卡算今天', async () => {
  const [store, dir] = await open();
  try {
    // 早上 08:00 答錯一張，FSRS 會把它排到當天稍晚或隔天。
    const morning = new Date(2026, 8, 9, 8, 0);
    store.review({ cardId: 'a1-recall-1', rating: 1, correct: false, at: morning });

    // 同一天的 23:00 來看：兩個統計必須說一樣的話。
    // 舊版 dueCount 比瞬間、upcoming 比本地日，這裡會得到 0 與 1。
    const night = new Date(2026, 8, 9, 23, 0);
    assert.equal(store.dueCount({}, night), store.upcoming(30, {}, night).backlog);

    // byKind 的 due 欄也吃同一條界線。
    const byKind = store.byKind({}, night);
    const sum = byKind.reduce((a, k) => a + k.due, 0);
    assert.equal(sum, store.dueCount({}, night));
  } finally {
    cleanup(store, dir);
  }
});

test('weakest 只收錯過的卡，並附上最近一次的錯法', async () => {
  const [store, dir] = await open();
  try {
    const day = (n) => new Date(2026, 8, 1 + n, 10, 0);
    store.review({ cardId: 'a1-recall-1', rating: 3, correct: true, at: day(0) });
    store.review({ cardId: 'a2-conj-1', rating: 1, correct: false, reason: 'wrong', at: day(0) });
    store.review({ cardId: 'a2-conj-1', rating: 1, correct: false, reason: 'accent', at: day(1) });

    const weak = store.weakest(10);
    assert.equal(weak.length, 1);
    assert.equal(weak[0].card.id, 'a2-conj-1');
    assert.equal(weak[0].lapses, 2);
    assert.equal(weak[0].wrong, 2);
    assert.equal(weak[0].lastReason, 'accent');
    assert.deepEqual(store.weakest(10, { kinds: ['vocab-recall'] }), []);
  } finally {
    cleanup(store, dir);
  }
});

test('設定寫得進去、讀得回來，改目標記憶率會換掉排程器', async () => {
  const [store, dir] = await open();
  try {
    assert.equal(store.desiredRetention, 0.9);
    assert.equal(store.dailyNewLimit, 15);
    const before = store.scheduler;
    store.set('desiredRetention', 0.95);
    assert.equal(store.desiredRetention, 0.95);
    assert.notEqual(store.scheduler, before);
    store.set('dailyNewLimit', 30);
    assert.equal(store.dailyNewLimit, 30);
    assert.equal(store.get('沒設過的鍵', '預設值'), '預設值');
  } finally {
    cleanup(store, dir);
  }
});

// ---- CO／PO 的手動打卡 -------------------------------------------------
//
// 這幾題守的是打卡與 reviews.jsonl 同級：事實在 JSONL，SQLite 只是鏡像。
// 特別要釘死「撤銷也是追加」——回頭改既有的行才是真正會壞掉的做法。

test('打卡先寫 checkins.jsonl 再進索引，兩邊都要有', async () => {
  const [store, dir] = await open();
  try {
    const at = new Date(2026, 8, 9, 21, 30);
    const entry = store.checkin({ skill: 'CO', at });
    assert.equal(entry.skill, 'CO');
    assert.equal(entry.day, '2026-09-09');
    assert.equal(entry.done, true);

    const lines = readFileSync(path.join(dir, 'checkins.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), entry);

    const s1 = store.checkinSummary('CO', { now: at });
    assert.equal(s1.done, true);
    assert.equal(s1.lastDay, '2026-09-09');
    assert.equal(s1.recent, 1);
    // 另一科不會被牽連。
    assert.equal(store.checkinSummary('PO', { now: at }).done, false);
  } finally {
    cleanup(store, dir);
  }
});

test('撤銷是追加一行，不回頭改既有的行', async () => {
  const [store, dir] = await open();
  try {
    const at = new Date(2026, 8, 9, 21, 30);
    store.checkin({ skill: 'PO', at });
    store.checkin({ skill: 'PO', done: false, at: new Date(2026, 8, 9, 21, 31) });

    const lines = readFileSync(path.join(dir, 'checkins.jsonl'), 'utf8').trim().split('\n');
    // 兩行都在。第一行原封不動——這就是「只增不改」在檔案層的樣子。
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).done, true);
    assert.equal(JSON.parse(lines[1]).done, false);
    // 索引以最後一行為準。
    assert.equal(store.checkinSummary('PO', { now: at }).done, false);
    assert.equal(store.checkinSummary('PO', { now: at }).recent, 0);
  } finally {
    cleanup(store, dir);
  }
});

test('recent 數的是最近 window 天裡打了幾天，不是總筆數', async () => {
  const [store, dir] = await open();
  try {
    const now = new Date(2026, 8, 10, 9, 0);
    for (const d of [10, 9, 8, 2]) store.checkin({ skill: 'CO', at: new Date(2026, 8, d, 20, 0) });
    // 同一天按兩次只算一天。
    store.checkin({ skill: 'CO', at: new Date(2026, 8, 9, 22, 0) });

    const week = store.checkinSummary('CO', { window: 7, now });
    assert.equal(week.recent, 3);
    assert.equal(week.window, 7);
    assert.equal(week.lastDay, '2026-09-10');
    // 拉長視窗才看得到 9/2 那一天。
    assert.equal(store.checkinSummary('CO', { window: 30, now }).recent, 4);
  } finally {
    cleanup(store, dir);
  }
});

test('不是 CO／PO 的科目一律拒絕，也不會留下任何一行', async () => {
  const [store, dir] = await open();
  try {
    assert.deepEqual(CHECKIN_SKILLS, ['CO', 'PO']);
    assert.throws(() => store.checkin({ skill: 'CE' }), /不是可打卡的科目/);
    assert.throws(() => store.checkin({ skill: '' }), /不是可打卡的科目/);
    assert.equal(existsSync(path.join(dir, 'checkins.jsonl')), false);
  } finally {
    cleanup(store, dir);
  }
});

test('reindex 連打卡一起重算，撤銷過的那天仍然是撤銷', async () => {
  const [store, dir] = await open();
  try {
    const now = new Date(2026, 8, 10, 9, 0);
    store.review({ cardId: 'a1-recall-1', rating: 3, correct: true, at: new Date(2026, 8, 9, 10) });
    store.checkin({ skill: 'CO', at: new Date(2026, 8, 9, 20, 0) });
    store.checkin({ skill: 'PO', at: new Date(2026, 8, 9, 20, 1) });
    store.checkin({ skill: 'PO', done: false, at: new Date(2026, 8, 9, 20, 2) });
    const before = store.checkinState({ now });

    const result = await store.reindex();
    assert.equal(result.applied, 1);
    assert.equal(result.checkins, 3);
    assert.equal(result.skipped, 0);
    assert.deepEqual(store.checkinState({ now }), before);
  } finally {
    cleanup(store, dir);
  }
});

test('沒有 checkins.jsonl 不是錯誤：第一次打卡之前那個檔本來就不存在', async () => {
  const [store, dir] = await open();
  try {
    const result = await store.reindex();
    assert.equal(result.checkins, 0);
    assert.equal(result.bad.length, 0);
    assert.equal(store.checkinInfo().exists, false);
    // 查詢照樣要能回答，不能因為檔案不在就丟錯。
    assert.equal(store.checkinState().CO.done, false);
  } finally {
    cleanup(store, dir);
  }
});

test('打卡檔壞掉的行只跳過那一行，並標明是哪個檔', async () => {
  const [store, dir] = await open();
  try {
    store.checkin({ skill: 'CO', at: new Date(2026, 8, 9, 20, 0) });
    appendFileSync(path.join(dir, 'checkins.jsonl'), '{"v":1,"skill":"PO"\n', 'utf8');
    appendFileSync(path.join(dir, 'checkins.jsonl'), '{"v":1,"skill":"PO"}\n', 'utf8');

    const result = await store.reindex();
    assert.equal(result.checkins, 1);
    assert.equal(result.skipped, 2);
    assert.deepEqual(result.bad.map((b) => b.file), ['checkins.jsonl', 'checkins.jsonl']);
  } finally {
    cleanup(store, dir);
  }
});
