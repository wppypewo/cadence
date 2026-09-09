/**
 * 「今天」的計算邏輯。這支測試盯著兩件容易在改版時悄悄壞掉的事：
 *
 *  1. **每日新卡上限是全域共用的**。曾經想過拆成每科一份，拆法沒有依據，
 *     而且會讓四科加起來超過上限。這裡釘死：兩科各自「最多」拿到共用額度，
 *     但額度本身只有一份。
 *  2. **CO／PO 不能假裝有進度**。題庫裡沒有音檔也沒有錄音評分，
 *     那兩科只能指向文件。任何時候它們冒出 count 或熟練度，都是有人在做假資料。
 *     `done` 是這條界線的例外，而且只有這一個例外：它不是系統算出來的，
 *     是使用者自己按下打卡鍵留的紀錄。系統照抄一份使用者說過的話不算造假，
 *     系統自己猜一個分數才算。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildToday, daysToExam, SKILL_KINDS } from '../src/engine/today.mjs';

const BY_KIND = [
  { kind: 'conj', total: 9073, seen: 40, mature: 0, due: 12 },
  { kind: 'connector', total: 25, seen: 25, mature: 3, due: 5 },
  { kind: 'nom', total: 92, seen: 0, mature: 0, due: 0 },
  { kind: 'pick', total: 75, seen: 2, mature: 0, due: 1 },
  { kind: 'rw', total: 88, seen: 0, mature: 0, due: 0 },
  { kind: 'vocab-produce', total: 3474, seen: 10, mature: 0, due: 3 },
  { kind: 'vocab-recall', total: 3549, seen: 100, mature: 20, due: 7 },
];

const BASE = { byKind: BY_KIND, newLimit: 15, newToday: 0, examDate: '2027-05-20', reviewsToday: 0, streakDays: 0 };

test('四科都在，順序固定為 CE PE CO PO', () => {
  const t = buildToday({ ...BASE, now: new Date('2026-09-09T10:00:00') });
  assert.deepEqual(t.tasks.map((x) => x.id), ['CE', 'PE', 'CO', 'PO']);
});

test('CE 只吃 vocab-recall', () => {
  const t = buildToday({ ...BASE, now: new Date('2026-09-09T10:00:00') });
  const ce = t.tasks[0];
  assert.deepEqual(ce.kinds, ['vocab-recall']);
  assert.equal(ce.total, 3549);
  assert.equal(ce.seen, 100);
  assert.equal(ce.due, 7);
  assert.equal(ce.unseen, 3449);
});

test('PE 把其餘六種題型加總', () => {
  const t = buildToday({ ...BASE, now: new Date('2026-09-09T10:00:00') });
  const pe = t.tasks[1];
  assert.equal(pe.kinds.length, 6);
  assert.equal(pe.total, 9073 + 25 + 92 + 75 + 88 + 3474);
  assert.equal(pe.due, 12 + 5 + 0 + 1 + 0 + 3);
});

test('七種題型不多不少全部歸了科，沒有孤兒', () => {
  const mapped = [...SKILL_KINDS.CE, ...SKILL_KINDS.PE].sort();
  const inBank = BY_KIND.map((r) => r.kind).sort();
  assert.deepEqual(mapped, inBank);
});

test('新卡額度全域共用：兩科各自看到的是同一份額度，不是各自一份', () => {
  const t = buildToday({ ...BASE, newLimit: 15, newToday: 0, now: new Date('2026-09-09T10:00:00') });
  assert.equal(t.newBudget, 15);
  assert.equal(t.tasks[0].newAvailable, 15);
  assert.equal(t.tasks[1].newAvailable, 15);
});

test('dayTotal 只加一次新卡額度，不是把各科的 count 相加', () => {
  const t = buildToday({ ...BASE, newLimit: 15, newToday: 0, now: new Date('2026-09-09T10:00:00') });
  // 到期：CE 7、PE 12+5+1+3 = 21，共 28。新卡額度 15 張是共用的，只加一次。
  assert.equal(t.dueTotal, 28);
  assert.equal(t.newAvailable, 15);
  assert.equal(t.dayTotal, 43);
  const naiveSum = t.tasks.filter((x) => x.mode === 'cards').reduce((a, x) => a + x.count, 0);
  assert.equal(naiveSum, 58);
  assert.ok(naiveSum > t.dayTotal, '各科 count 相加會重複計算新卡額度，這正是不給總數的理由');
});

test('今天已經學過的新卡要從額度扣掉', () => {
  const t = buildToday({ ...BASE, newLimit: 15, newToday: 6, now: new Date('2026-09-09T10:00:00') });
  assert.equal(t.newBudget, 9);
  assert.equal(t.tasks[0].count, 7 + 9);
});

test('額度用完就是 0，不會變成負的', () => {
  const t = buildToday({ ...BASE, newLimit: 15, newToday: 40, now: new Date('2026-09-09T10:00:00') });
  assert.equal(t.newBudget, 0);
  assert.equal(t.tasks[0].newAvailable, 0);
  assert.equal(t.tasks[0].count, 7); // 只剩到期卡
});

test('題目不夠時 newAvailable 以剩餘題數為準', () => {
  const t = buildToday({
    ...BASE,
    byKind: [{ kind: 'vocab-recall', total: 10, seen: 8, mature: 0, due: 0 }],
    newLimit: 15, newToday: 0, now: new Date('2026-09-09T10:00:00'),
  });
  assert.equal(t.tasks[0].newAvailable, 2);
  assert.equal(t.tasks[0].count, 2);
});

test('題庫沒有的題型不會讓加總爆掉', () => {
  const t = buildToday({ ...BASE, byKind: [], now: new Date('2026-09-09T10:00:00') });
  assert.equal(t.tasks[0].total, 0);
  assert.equal(t.tasks[1].total, 0);
  assert.equal(t.tasks[0].count, 0);
  assert.equal(t.pendingCards, 0);
});

test('CO 與 PO 指向文件，且明講系統追蹤不到', () => {
  const t = buildToday({ ...BASE, now: new Date('2026-09-09T10:00:00') });
  const [co, po] = t.tasks.slice(2);
  assert.equal(co.mode, 'doc');
  assert.equal(co.doc, 'study/delf-b1-comprehension-orale.md');
  assert.equal(co.tracked, false);
  assert.equal(co.count, undefined);
  assert.equal(po.mode, 'doc');
  assert.equal(po.doc, 'study/delf-b1-production-orale.md');
  assert.equal(po.tracked, false);
  assert.equal(po.count, undefined);
});

test('沒傳 checkins 時，兩科都是「還沒打卡」而不是 undefined', () => {
  // 前端拿 done 去決定按鈕文字。undefined 在畫面上會變成一顆狀態不明的鍵，
  // 所以這裡釘死預設值：沒有紀錄就是還沒做，不是不知道。
  const t = buildToday({ ...BASE, now: new Date('2026-09-09T10:00:00') });
  for (const task of t.tasks.slice(2)) {
    assert.equal(task.checkable, true);
    assert.equal(task.done, false);
    assert.equal(task.lastDay, null);
    assert.equal(task.recent, 0);
  }
  assert.equal(t.pendingChecks, 2);
});

test('打卡資料原樣帶進 task，且 tracked 不會因此變成 true', () => {
  const t = buildToday({
    ...BASE,
    checkins: {
      CO: { done: true, lastDay: '2026-09-09', recent: 3, window: 7 },
      PO: { done: false, lastDay: '2026-09-05', recent: 1, window: 7 },
    },
    now: new Date('2026-09-09T10:00:00'),
  });
  const [co, po] = t.tasks.slice(2);
  assert.equal(co.done, true);
  assert.equal(co.recent, 3);
  assert.equal(co.lastDay, '2026-09-09');
  // 打了卡也不代表系統評量得了這一科。這兩件事永遠分開。
  assert.equal(co.tracked, false);
  assert.equal(co.count, undefined);
  assert.equal(po.done, false);
  // 今天沒打卡的只剩 PO 一科。
  assert.equal(t.pendingChecks, 1);
});

test('CE／PE 不可打卡：那兩科的進度是卡片自己記的', () => {
  const t = buildToday({ ...BASE, now: new Date('2026-09-09T10:00:00') });
  for (const task of t.tasks.slice(0, 2)) {
    assert.notEqual(task.checkable, true);
    assert.equal(task.done, undefined);
  }
});

test('pendingCards 只數還有卡要做的科目', () => {
  const t = buildToday({
    ...BASE,
    byKind: [{ kind: 'vocab-recall', total: 10, seen: 10, mature: 0, due: 0 }],
    newLimit: 0, newToday: 0, now: new Date('2026-09-09T10:00:00'),
  });
  assert.equal(t.pendingCards, 0);
});

test('daysToExam 用日曆天算，不受當天時刻影響', () => {
  assert.equal(daysToExam('2026-09-10', new Date('2026-09-09T23:59:00')), 1);
  assert.equal(daysToExam('2026-09-10', new Date('2026-09-09T00:01:00')), 1);
  assert.equal(daysToExam('2026-09-09', new Date('2026-09-09T12:00:00')), 0);
});

test('考試日過了會是負數，呼叫端才有機會提醒', () => {
  assert.equal(daysToExam('2026-09-01', new Date('2026-09-09T12:00:00')), -8);
});

test('沒設考試日或格式不對都回 null，不是 NaN', () => {
  assert.equal(daysToExam(null, new Date('2026-09-09T12:00:00')), null);
  assert.equal(daysToExam('2027/05/20', new Date('2026-09-09T12:00:00')), null);
  assert.equal(buildToday({ ...BASE, examDate: null, now: new Date('2026-09-09T10:00:00') }).daysLeft, null);
});

test('day 是本地日期，不是 UTC 日期', () => {
  // 台北 UTC+8：本地 2026-09-09 早上八點，UTC 還是 09-09 凌晨；
  // 本地 00:30 時 UTC 已經是前一天，這一格才會抓到寫錯的實作。
  const t = buildToday({ ...BASE, now: new Date('2026-09-09T00:30:00') });
  assert.equal(t.day, '2026-09-09');
});
