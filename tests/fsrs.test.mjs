/**
 * FSRS-6 移植正確性測試
 *
 * fixtures/fsrs-golden.json 的 732 組數值不是手抄，是把官方參考實作
 * （py-fsrs 的 fsrs/scheduler.py）原始碼直接執行後傾印出來的。
 * 這個檔案的價值在於：改動 fsrs.mjs 卻改壞公式時，這裡會立刻紅。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createScheduler, DEFAULT_PARAMETERS, RATING } from '../src/engine/fsrs.mjs';

const golden = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/fsrs-golden.json', import.meta.url)), 'utf8'),
);

/** 相對誤差。浮點運算順序不同會有末位差異，1e-12 已遠嚴於實務需求。 */
function closeTo(actual, expected, msg) {
  const scale = Math.max(1, Math.abs(expected));
  assert.ok(
    Math.abs(actual - expected) <= 1e-12 * scale,
    `${msg}：預期 ${expected}，實際 ${actual}`,
  );
}

test('對照 py-fsrs 參考實作的 732 組黃金值', () => {
  const cache = new Map();
  const sched = (dr) => {
    if (!cache.has(dr)) cache.set(dr, createScheduler({ desiredRetention: dr, maximumInterval: 36500 }));
    return cache.get(dr);
  };

  for (const c of golden.cases) {
    const s = sched(c.dr);
    const got =
      c.kind === 'initial'
        ? s.review(null, c.rating, 0)
        : s.review({ stability: c.S0, difficulty: c.D0 }, c.rating, c.elapsed);
    const label = `${c.kind} dr=${c.dr} rating=${c.rating} S0=${c.S0} D0=${c.D0} t=${c.elapsed}`;
    closeTo(got.stability, c.S, `${label} 穩定度`);
    closeTo(got.difficulty, c.D, `${label} 難度`);
    assert.equal(got.intervalDays, c.iv, `${label} 間隔天數`);
    if (c.kind === 'review' && c.elapsed >= 1) {
      closeTo(got.retrievabilityBefore, c.R, `${label} 可提取性`);
    }
  }
});

test('預設參數是 FSRS-6 的 21 個，且 w[20] 就是 DECAY', () => {
  assert.equal(DEFAULT_PARAMETERS.length, 21);
  assert.equal(DEFAULT_PARAMETERS[20], 0.1542);
  assert.equal(createScheduler().DECAY, -0.1542);
});

test('新卡的初始穩定度是查表 w[rating-1]，不是線性公式', () => {
  // 有份流傳的 wiki 寫成 S0(G) = w0 + (G-1)*w1，與參數值不符，這條測試把它釘死。
  const s = createScheduler();
  assert.equal(s.initialStability(RATING.AGAIN), 0.212);
  assert.equal(s.initialStability(RATING.HARD), 1.2931);
  assert.equal(s.initialStability(RATING.GOOD), 2.3065);
  assert.equal(s.initialStability(RATING.EASY), 8.2956);
});

test('遺忘曲線：剛複習完是 1，S 天後恰好是 90%', () => {
  const s = createScheduler();
  assert.equal(s.retrievability(10, 0), 1);
  closeTo(s.retrievability(10, 10), 0.9, '一個穩定度單位後');
  closeTo(s.retrievability(3.7, 3.7), 0.9, '換一個穩定度');
  assert.ok(s.retrievability(10, 100) < s.retrievability(10, 20), '時間越久越低');
});

test('目標保留率越高，間隔越短', () => {
  const strict = createScheduler({ desiredRetention: 0.97 });
  const loose = createScheduler({ desiredRetention: 0.8 });
  assert.ok(strict.nextInterval(50) < loose.nextInterval(50));
  // 保留率剛好等於 0.9 時，間隔應等於穩定度本身。
  assert.equal(createScheduler({ desiredRetention: 0.9 }).nextInterval(50), 50);
});

test('難度被夾在 1..10，且答 Again 會變難、答 Easy 會變簡單', () => {
  const s = createScheduler();
  assert.ok(s.nextDifficulty(5, RATING.AGAIN) > 5);
  assert.ok(s.nextDifficulty(5, RATING.EASY) < 5);
  assert.ok(Math.abs(s.nextDifficulty(5, RATING.GOOD) - 5) < 0.2, 'Good 幾乎不動');
  assert.ok(s.nextDifficulty(1, RATING.AGAIN) <= 10);
  assert.equal(s.nextDifficulty(1, RATING.EASY), 1, '已經最簡單就不再往下');
  assert.equal(s.nextDifficulty(1, RATING.GOOD), 1);
});

test('難度撞到 10 之後，評分就失去影響力（線性阻尼的已知後果）', () => {
  // (10 - D) 這個因子在 D = 10 時歸零，四種評分算出同一個值。
  // 與參考實作逐位元核對過，不是移植錯誤。程式對此的處置見 fsrs.mjs 的註解。
  const s = createScheduler();
  const results = [1, 2, 3, 4].map((r) => s.nextDifficulty(10, r));
  for (const d of results) closeTo(d, 9.985228369296838, 'D=10 的更新值');
  assert.ok(results.every((d) => d < 10), '均值回歸讓它離開上限，但一次只挪 0.015');
});

test('答錯會讓穩定度掉下來，答對會往上', () => {
  const s = createScheduler();
  const card = { stability: 30, difficulty: 5 };
  const again = s.review(card, RATING.AGAIN, 30);
  const good = s.review(card, RATING.GOOD, 30);
  assert.ok(again.stability < card.stability, '答錯後穩定度下降');
  assert.ok(good.stability > card.stability, '答對後穩定度上升');
  assert.ok(s.review(card, RATING.EASY, 30).stability > good.stability, 'Easy 高於 Good');
  assert.ok(s.review(card, RATING.HARD, 30).stability < good.stability, 'Hard 低於 Good');
});

test('間隔上限與下限', () => {
  const s = createScheduler({ maximumInterval: 365 });
  assert.equal(s.nextInterval(1e9), 365);
  assert.equal(s.nextInterval(1e-9), 1, '再脆弱的卡也至少隔一天');
});

test('同一天重答走短期公式，不套遺忘曲線', () => {
  const s = createScheduler();
  const card = { stability: 5, difficulty: 5 };
  const sameDay = s.review(card, RATING.GOOD, 0);
  assert.equal(sameDay.retrievabilityBefore, 1, '間隔 0 天時可提取性為 1');
  // S=5 時 Good 的增幅算出來小於 1，被 max(increase, 1.0) 夾住，結果恰好等於原值。
  // 也就是「同一天再答對一次不會讓卡變更穩」，這是 FSRS-6 的設計，不是 bug。
  assert.equal(sameDay.stability, 5, '同日答 Good，穩定度持平');
  assert.ok(s.review(card, RATING.EASY, 0).stability > 5, '同日答 Easy 才會推高');
  // 同日答 Again 不應該把穩定度打到比長期遺忘公式更低。
  assert.ok(s.review(card, RATING.AGAIN, 0).stability > 0);
});

test('壞輸入直接丟錯，不靜默算出垃圾', () => {
  assert.throws(() => createScheduler({ parameters: [1, 2, 3] }), /21 個參數/);
  assert.throws(() => createScheduler({ desiredRetention: 0 }), /desiredRetention/);
  assert.throws(() => createScheduler({ desiredRetention: 1 }), /desiredRetention/);
  assert.throws(() => createScheduler().review(null, 5, 0), /rating/);
  assert.throws(() => createScheduler().review(null, 2.5, 0), /rating/);
});
