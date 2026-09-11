/**
 * 考前推演測試。
 *
 * 推演出來的數字沒有辦法跟外部標準對照——它是一組明確假設下的模擬結果。
 * 所以這裡測的是**假設有沒有被遵守**：種子固定就必須逐位元重現、
 * 每日上限不能被突破、做不完的要進 backlog、輸入的卡片物件不能被改到。
 * 這些一旦破了，畫面上那句「考試當天預期記得 x%」就不能信。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { simulate, solveDailyNew, ratingDistribution } from '../src/engine/forecast.mjs';

/** 造一批卡：newCards 張沒學過的，seenCards 張有 state 的。 */
function makeCards(newCards, seenCards, from) {
  const cards = [];
  for (let i = 0; i < newCards; i += 1) cards.push({ id: `new-${i}` });
  for (let i = 0; i < seenCards; i += 1) {
    const due = new Date(from);
    due.setDate(due.getDate() + (i % 5));
    cards.push({ id: `seen-${i}`, stability: 3 + (i % 10), difficulty: 5, due: due.toISOString() });
  }
  return cards;
}

const FROM = new Date(2026, 8, 9);
const EXAM = new Date(2026, 9, 9);

function baseOpts(over = {}) {
  return {
    cards: makeCards(200, 100, FROM),
    from: FROM,
    examDate: EXAM,
    dailyLimit: 40,
    dailyNew: 10,
    desiredRetention: 0.9,
    secondsPerCard: 8,
    ...over,
  };
}

test('同樣的輸入必定得到同樣的結果', () => {
  // 推演會被拿來做決定（要不要調新卡量）。同一份設定每次看到不同數字，
  // 使用者無從判斷是自己改了什麼還是模擬在抖。
  const a = simulate(baseOpts());
  const b = simulate(baseOpts());
  assert.deepEqual(a, b);
});

test('換種子會得到不同的抽樣結果', () => {
  // 反過來確認隨機來源真的有接上——如果 rnd 沒被用到，換種子也會一模一樣。
  const a = simulate(baseOpts());
  const c = simulate(baseOpts({ seed: 99 }));
  assert.notEqual(a.expectedRecall, c.expectedRecall);
});

test('天數含起點與考試當天', () => {
  const r = simulate(baseOpts());
  assert.equal(r.daysUntilExam, 30);
  assert.equal(r.days.length, 31);
  assert.equal(r.days[0].day, '2026-09-09');
  assert.equal(r.days.at(-1).day, '2026-10-09');
  assert.equal(r.examDate, '2026-10-09');
});

test('考試日就是今天時仍然回一天，不是空陣列', () => {
  const r = simulate(baseOpts({ examDate: FROM }));
  assert.equal(r.daysUntilExam, 0);
  assert.equal(r.days.length, 1);
  assert.ok(r.peakDay);
});

test('每天的總量不超過 dailyLimit，新卡不超過 dailyNew', () => {
  const r = simulate(baseOpts({ dailyLimit: 40, dailyNew: 10 }));
  for (const d of r.days) {
    assert.ok(d.reviews + d.learned <= 40, `${d.day} 做了 ${d.reviews + d.learned} 張`);
    assert.ok(d.learned <= 10, `${d.day} 學了 ${d.learned} 張新卡`);
  }
});

test('額度不夠時到期卡會遞延，並記錄最高積壓量', () => {
  // 這是「臨時抱佛腳為什麼會崩」的機制本身，必須真的會發生。
  const tight = simulate(baseOpts({ dailyLimit: 5, dailyNew: 0 }));
  assert.ok(tight.backlogPeak > 0);
  assert.ok(tight.days.some((d) => d.deferred > 0));

  const roomy = simulate(baseOpts({ dailyLimit: 400, dailyNew: 0 }));
  assert.equal(roomy.backlogPeak, 0);
  assert.ok(roomy.days.every((d) => d.deferred === 0));
});

test('solveDailyNew 掃過每一格，ceiling 不會漏掉二分搜尋跳過的尖峰', () => {
  const opts = baseOpts({ maxNew: 30, target: 0.99, dailyNew: undefined });
  const r = solveDailyNew(opts);

  // 0..maxNew 每一格都要真的跑過。舊版二分只跑 6 格，回報的「上限」是假的。
  assert.equal(r.exhaustive, true);
  assert.equal(r.tried.length, 31);
  assert.deepEqual(r.tried.map((t) => t.dailyNew), Array.from({ length: 31 }, (_, i) => i));

  // ceiling 必須是所有跑過的格子裡最高的答對率，不是搜尋路徑終點。
  const max = Math.max(...r.tried.map((t) => t.rate));
  assert.equal(r.ceiling.rate, max);
  for (const t of r.tried) assert.ok(t.rate <= r.ceiling.rate);
});

test('maxNew 很大時改成粗掃加局部補滿，模擬次數不隨 maxNew 線性膨脹', () => {
  const r = solveDailyNew(baseOpts({ maxNew: 600, target: 0.99, dailyNew: undefined }));
  assert.equal(r.exhaustive, false);
  // 61 格粗掃 + 最佳格附近補滿，遠少於 601 次。
  assert.ok(r.tried.length < 100, `跑了 ${r.tried.length} 次`);
  assert.ok(r.tried.some((t) => t.dailyNew === 600));
  const max = Math.max(...r.tried.map((t) => t.rate));
  assert.equal(r.ceiling.rate, max);
});

test('不修改呼叫端傳進來的卡片物件', () => {
  // 同一份 cards 陣列在 solveDailyNew 裡會被跑很多次，被改到就會互相污染。
  const cards = makeCards(20, 20, FROM);
  const before = JSON.parse(JSON.stringify(cards));
  simulate(baseOpts({ cards }));
  assert.deepEqual(cards, before);
});

test('沒有評分分布時標成 assumed-good，有的話標 observed', () => {
  assert.equal(simulate(baseOpts()).ratingModel, 'assumed-good');
  assert.equal(
    simulate(baseOpts({ ratings: { hard: 0.2, good: 0.7, easy: 0.1 } })).ratingModel,
    'observed',
  );
});

test('分母是範圍內全部的卡，沒學到的算 0 分', () => {
  // 只練得完一小部分卻回報 95%，會讓人以為準備好了。
  const r = simulate(baseOpts({ dailyLimit: 5, dailyNew: 1 }));
  assert.equal(r.cardsInScope, 300);
  assert.ok(r.coverage < 1);
  assert.ok(r.expectedRecallRate <= r.coverage);
  assert.ok(r.buckets.untouched > 0);

  const sum = r.buckets.strong + r.buckets.shaky + r.buckets.weak;
  assert.equal(sum, r.studiedByExam);
  assert.equal(sum + r.buckets.untouched, r.cardsInScope);
});

test('分鐘數只在有給每張秒數時才算', () => {
  const withTime = simulate(baseOpts({ secondsPerCard: 8 }));
  assert.ok(withTime.days.some((d) => d.minutes > 0));
  const withoutTime = simulate(baseOpts({ secondsPerCard: null }));
  assert.ok(withoutTime.days.every((d) => d.minutes === null));
});

test('ratingDistribution：樣本不足回 null，足夠時三個機率加總為 1', () => {
  const rows = [];
  for (let i = 0; i < 60; i += 1) rows.push({ rating: [2, 3, 3, 4][i % 4] });
  // 預設門檻是 50 筆，60 筆過得去。
  assert.ok(ratingDistribution(rows));
  const d = ratingDistribution(rows, 10);
  assert.equal(d.sample, 60);
  assert.ok(Math.abs(d.hard + d.good + d.easy - 1) < 1e-12);
  assert.ok(Math.abs(d.good - 0.5) < 1e-12);

  // 樣本不足就回 null，讓呼叫端退回「一律 Good」而不是拿三筆紀錄外推。
  assert.equal(ratingDistribution([{ rating: 3 }, { rating: 4 }]), null);
  // 評分 1（Again）不算進「答對時給幾分」的分布。
  assert.equal(ratingDistribution([{ rating: 1 }, { rating: 1 }, { rating: 3 }], 3), null);
});

test('solveDailyNew：達得到目標時回傳仍能達標的最大新卡量', () => {
  const r = solveDailyNew(baseOpts({ target: 0.5, maxNew: 40 }));
  assert.equal(r.achievable, true);
  assert.ok(r.recommended.rate >= 0.5);
  assert.ok(r.recommended.dailyNew >= 1);
  // 回報的每一組都要帶得走，不含整份模擬結果（那是 MB 等級的物件）。
  assert.ok(r.tried.length > 0);
  assert.ok(r.tried.every((t) => !('result' in t)));
  // tried 依新卡量排序，方便畫成一條曲線。
  const order = r.tried.map((t) => t.dailyNew);
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test('solveDailyNew：達不到目標時誠實回報，並給出實際能到的上限', () => {
  const r = solveDailyNew(baseOpts({ target: 0.999, maxNew: 40 }));
  assert.equal(r.achievable, false);
  assert.ok(r.ceiling.rate < 0.999);
  // 達不到就把最好的那一組當建議，不回一個沒跑過的數字。
  assert.equal(r.recommended.dailyNew, r.ceiling.dailyNew);
  assert.ok(r.tried.some((t) => t.dailyNew === r.recommended.dailyNew));
});

test('locked 的卡（低於起始等級的新卡）不會被學，考試那天算成沒碰過', () => {
  const cards = makeCards(50, 0, FROM).map((c, i) => (i < 30 ? { ...c, locked: true } : c));
  const r = simulate(baseOpts({ cards, dailyNew: 10 }));
  const learned = r.days.reduce((a, d) => a + d.learned, 0);
  assert.equal(learned, 20);
  assert.equal(r.buckets.untouched, 30);
});
