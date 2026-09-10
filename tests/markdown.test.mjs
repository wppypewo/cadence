/**
 * 最小 Markdown 解析器的測試。
 *
 * 只測 parseBlocks／parseInline 這兩個純函式——render() 要 document，
 * 而這個專案沒有 DOM 測試環境，也不打算為了測 DOM 引一個套件。
 * 真正會出錯的地方本來就在切區塊：表格分隔線認不認得、程式碼區塊裡的
 * # 會不會被當成標題、清單續行有沒有黏回去。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBlocks, parseInline } from '../web/js/markdown.mjs';

test('標題吃 # 的數量，內容去掉前後空白', () => {
  const b = parseBlocks('# 一\n\n### 三');
  assert.deepEqual(b, [
    { type: 'heading', level: 1, text: '一' },
    { type: 'heading', level: 3, text: '三' },
  ]);
});

test('表格要靠第二列的分隔線才成立', () => {
  const md = '| 能力 | B1 | B1+ |\n|---|---|---|\n| Lexique | 3 | 5 |';
  const [t] = parseBlocks(md);
  assert.equal(t.type, 'table');
  assert.deepEqual(t.header, ['能力', 'B1', 'B1+']);
  assert.deepEqual(t.rows, [['Lexique', '3', '5']]);
});

test('沒有分隔線的 | 開頭行是段落，不是表格', () => {
  const [b] = parseBlocks('| 這只是一行普通的字');
  assert.equal(b.type, 'para');
});

test('程式碼區塊裡的 # 與 | 不會被當成標題或表格', () => {
  const md = '```\n# 這是 prompt 的一行\n| a | b |\n```';
  const b = parseBlocks(md);
  assert.equal(b.length, 1);
  assert.equal(b[0].type, 'code');
  assert.equal(b[0].text, '# 這是 prompt 的一行\n| a | b |');
});

test('程式碼區塊原樣保留縮排——PO 那份的 prompt 會被整段複製出去', () => {
  const md = '```\n規則：\n  1. 全程用法文\n    - 子項\n```';
  assert.equal(parseBlocks(md)[0].text, '規則：\n  1. 全程用法文\n    - 子項');
});

test('清單的續行黏回同一項', () => {
  const [l] = parseBlocks('- 第一項的上半\n  第一項的下半\n- 第二項');
  assert.equal(l.type, 'list');
  assert.equal(l.ordered, false);
  assert.deepEqual(l.items.map((i) => i.text), ['第一項的上半 第一項的下半', '第二項']);
});

test('巢狀清單記下深度', () => {
  const [l] = parseBlocks('- 上層\n  - 下層');
  assert.deepEqual(l.items.map((i) => i.depth), [0, 1]);
});

test('有序與無序清單不會併成同一塊', () => {
  const b = parseBlocks('1. 甲\n2. 乙\n\n- 丙');
  assert.deepEqual(b.map((x) => x.ordered), [true, false]);
});

test('引言遞迴解析，裡面的粗體仍然是行內語法', () => {
  const [q] = parseBlocks('> **準備時間**我沒有官方出處。\n> 以 convocation 為準。');
  assert.equal(q.type, 'quote');
  // quote 的 text 保留原始換行，交給 render() 再遞迴解析一次；
  // 段落的合併發生在那一層，不在這裡。
  assert.equal(q.text, '**準備時間**我沒有官方出處。\n以 convocation 為準。');
  const [inner] = parseBlocks(q.text);
  assert.equal(inner.type, 'para');
  assert.equal(parseInline(inner.text)[0].type, 'strong');
});

test('--- 是分隔線，不是標題', () => {
  assert.deepEqual(parseBlocks('---').map((b) => b.type), ['hr']);
});

test('段落讀到下一個區塊開頭就停', () => {
  const b = parseBlocks('一句話\n## 下一節');
  assert.deepEqual(b.map((x) => x.type), ['para', 'heading']);
});

test('行內只切粗體、行內碼與連結，其餘原樣', () => {
  assert.deepEqual(parseInline('六項全 **B1+** 剛好 25 分'), [
    { type: 'text', text: '六項全 ' },
    { type: 'strong', text: 'B1+' },
    { type: 'text', text: ' 剛好 25 分' },
  ]);
  assert.deepEqual(parseInline('用 `npm test` 跑'), [
    { type: 'text', text: '用 ' },
    { type: 'code', text: 'npm test' },
    { type: 'text', text: ' 跑' },
  ]);
});

test('沒收尾的 ``` 讀到檔尾就結束，不會把後面吃掉也不會丟例外', () => {
  const b = parseBlocks('```\n沒關起來');
  assert.deepEqual(b, [{ type: 'code', lang: '', text: '沒關起來' }]);
});

test('法文重音在解析過程中原樣保留', () => {
  const [t] = parseBlocks('| 名稱 |\n|---|\n| Compréhension de l’oral |');
  assert.equal(t.rows[0][0], 'Compréhension de l’oral');
});

test('連結：[字](網址) 與 <網址> 兩種都認得', () => {
  // CO 那份的用途就是存連結。渲染成不能點的字等於要人反白複製，那不算有入口。
  assert.deepEqual(parseInline('樣題在 [FEI](https://example.fr/b1) 這裡'), [
    { type: 'text', text: '樣題在 ' },
    { type: 'link', text: 'FEI', href: 'https://example.fr/b1' },
    { type: 'text', text: ' 這裡' },
  ]);
  // 尖括號式的顯示文字就是網址本身：抄得到那串字也是這份文件的用途之一。
  assert.deepEqual(parseInline('<https://example.fr/a.mp3>'), [
    { type: 'link', text: 'https://example.fr/a.mp3', href: 'https://example.fr/a.mp3' },
  ]);
});

test('連結：只放行 http／https，其餘原樣印出來', () => {
  // 擋掉的要看得見。靜靜地少一個連結，跟連結壞掉是同一件事但更難發現。
  assert.deepEqual(parseInline('<mailto:a@b.c>'), [{ type: 'text', text: '<mailto:a@b.c>' }]);
  assert.deepEqual(parseInline('[本機](./study/co.md)'), [{ type: 'text', text: '[本機](./study/co.md)' }]);

  // 網址裡有括號時，`[^)\s]+` 會停在第一個 `)`，剩下的字尾自成一段文字。
  // 分成幾段不重要，重要的是沒有一段變成 link、而且原文一個字都沒少。
  const src = '[點我](javascript:alert(1))';
  const parts = parseInline(src);
  assert.ok(parts.every((t) => t.type === 'text'));
  assert.equal(parts.map((t) => t.text).join(''), src);
});

test('連結：反引號裡的網址仍然是行內碼', () => {
  // 取的是位置最前的那一個，不是交替順序。反引號先開始，整段就歸行內碼。
  assert.deepEqual(parseInline('`<https://example.fr>`'), [
    { type: 'code', text: '<https://example.fr>' },
  ]);
});

test('連結：表格儲存格裡的連結照樣切得出來', () => {
  // 官方樣題那張表整張都是連結，切不出來的話那一節等於白寫。
  const [t] = parseBlocks('| 音檔 |\n|---|\n| <https://example.fr/ex1.mp3> |');
  assert.deepEqual(parseInline(t.rows[0][0]), [
    { type: 'link', text: 'https://example.fr/ex1.mp3', href: 'https://example.fr/ex1.mp3' },
  ]);
});
