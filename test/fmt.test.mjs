// 終端輸出格式。中文是全形，表格若用字串長度對齊就會歪掉，所以寬度計算是重點。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  displayWidth, truncate, padEnd, padStart, table, bytes, num, pct, ago, date, day, bar, kv,
} from '../src/fmt.mjs';

test('中文與 emoji 算兩欄，ASCII 算一欄', () => {
  assert.equal(displayWidth('abc'), 3);
  assert.equal(displayWidth('中文'), 4);
  assert.equal(displayWidth('中文abc'), 7);
  assert.equal(displayWidth('北海道🎿'), 8);
  assert.equal(displayWidth(''), 0);
});

test('ANSI 顏色碼不計入寬度', () => {
  assert.equal(displayWidth('\x1b[36m中文\x1b[0m'), 4);
});

test('truncate 依顯示寬度切，切完不會超出上限', () => {
  assert.equal(truncate('短', 10), '短');
  const t = truncate('這是一段很長的中文標題需要被截斷', 10);
  assert.ok(displayWidth(t) <= 10, `截斷後寬度 ${displayWidth(t)} 超過 10`);
  assert.ok(t.endsWith('…'));
});

test('padEnd／padStart 補到指定顯示寬度', () => {
  assert.equal(displayWidth(padEnd('中文', 10)), 10);
  assert.equal(displayWidth(padStart('中文', 10)), 10);
  assert.equal(padEnd('太長的中文字串', 4), '太長的中文字串', '超過寬度時不截斷也不報錯');
});

test('表格每一行的顯示寬度都對齊', () => {
  const rows = [
    { a: '中文專案', b: '1' },
    { a: 'english', b: '22' },
    { a: '混合mixed', b: '333' },
  ];
  const out = table(rows, [
    { label: '名稱', value: (r) => r.a },
    { label: '數量', align: 'right', value: (r) => r.b },
  ]);
  const lines = out.split('\n');
  assert.equal(lines.length, 4, '表頭加三列');
  // 最後一欄靠右，所以每一行都應該結束在同一欄——用字串長度對齊的話中文列會短掉。
  const widths = [...new Set(lines.map((l) => displayWidth(l)))];
  assert.equal(widths.length, 1, `各行寬度不一致：${widths.join(',')}`);
});

test('沒有資料的表格印出可讀的提示，不是空字串', () => {
  assert.match(table([], [{ label: 'x', value: () => '' }]), /無資料/);
});

test('欄位都沒有標題時不留空白表頭', () => {
  const out = table([{ a: '1' }], [{ value: (r) => r.a }]);
  assert.equal(out.split('\n').length, 1);
});

test('bytes 依量級換單位', () => {
  assert.equal(bytes(0), '0 B');
  assert.equal(bytes(512), '512 B');
  assert.equal(bytes(1024), '1.0 KB');
  assert.equal(bytes(1024 * 1024 * 157), '157 MB');
  assert.equal(bytes(undefined), '0 B');
});

test('num 加千分位，pct 對極小值另外標示', () => {
  assert.equal(num(37520), '37,520');
  assert.equal(pct(1, 4), '25.0%');
  assert.equal(pct(0, 0), '0%', '分母為 0 不能變成 NaN');
  assert.equal(pct(1, 100000), '<0.1%');
  assert.equal(pct(0, 100), '0.0%');
});

test('ago 用中文說相對時間，壞值回破折號', () => {
  const now = Date.now();
  assert.equal(ago(new Date(now - 30 * 1000).toISOString()), '剛剛');
  assert.equal(ago(new Date(now - 3 * 3600 * 1000).toISOString()), '3 小時前');
  assert.equal(ago(new Date(now - 5 * 86400 * 1000).toISOString()), '5 天前');
  assert.equal(ago(null), '—');
  assert.equal(ago('not-a-date'), '—');
});

test('date／day 對壞值不拋錯', () => {
  assert.equal(date(null), '—');
  assert.equal(date('壞掉'), '—');
  assert.equal(day(null), null);
  assert.match(day('2026-09-08T12:00:00.000Z'), /^\d{4}-\d{2}-\d{2}$/);
});

test('bar 的長度不超過指定寬度，非零值至少畫一格', () => {
  assert.equal(bar(10, 10, 5).length, 5);
  assert.equal(bar(0, 10, 5).length, 0);
  assert.equal(bar(1, 100000, 20).length, 1, '極小值也要看得見');
  assert.equal(bar(5, 0, 20), '');
});

test('kv 的標籤欄對齊，且不留行尾空白', () => {
  const out = kv([['總計', '157 MB', ''], ['對話文字', '8.7 MB', '5.6%']]);
  const lines = out.split('\n');
  assert.equal(lines.length, 2);
  assert.ok(lines.every((l) => !/\s$/.test(l)), '不得留行尾空白');
  assert.ok(lines[1].includes('5.6%'));
});
