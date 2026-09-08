/**
 * 批改邏輯測試。
 *
 * 這個檔案守的是一個產品決定，不只是函式行為：**重音算錯，大小寫不算錯**。
 * 兩者都是「看起來只差一點」，但一個會在考卷上被扣分，一個不會。
 * 哪天有人覺得「ecole 也放過吧」，這裡會先紅。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, stripAccents, grade, diffChars, missingAccents } from '../src/engine/grade.mjs';

test('normalize：NFC、撇號統一、空白收斂', () => {
  // 分解式的 e + U+0301 與預組合的 é 在畫面上一樣，字串比對卻不等。
  // macOS 從檔名複製過來的字串常是分解式，不先收斂就會整題誤判成錯。
  const decomposed = 'e\u0301cole';
  assert.equal(decomposed.length, 6);
  assert.equal(normalize(decomposed), 'école');
  assert.equal(normalize(decomposed).length, 5);

  // 鍵盤打的是 U+0027，法文排版與題庫裡的是 U+2019。三種撇號都要收成同一個。
  assert.equal(normalize("l'école"), 'l’école');
  assert.equal(normalize('lʼécole'), 'l’école');
  assert.equal(normalize('l‘école'), 'l’école');

  assert.equal(normalize('  je   suis  '), 'je suis');
  assert.equal(normalize(null), '');
  assert.equal(normalize(undefined), '');
});

test('stripAccents：變音符號與連字都要拆開', () => {
  assert.equal(stripAccents('être'), 'etre');
  assert.equal(stripAccents('naïtre'), 'naitre');
  assert.equal(stripAccents('ça'), 'ca');
  assert.equal(stripAccents('français'), 'francais');
  // œ／æ 不是變音符號，Unicode 分解拆不開，要另外對應成兩個字母。
  assert.equal(stripAccents('cœur'), 'coeur');
  assert.equal(stripAccents('Cœur'), 'Coeur');
  assert.equal(stripAccents('CŒUR'), 'COEUR');
  assert.equal(stripAccents('ex æquo'), 'ex aequo');
  assert.equal(stripAccents('ÆTHER'), 'AETHER');
});

test('grade：完全相同是 exact', () => {
  assert.deepEqual(grade('école', ['école']), { correct: true, reason: 'exact', matched: 'école' });
  // 撇號寫法不同仍算完全命中，normalize 已經把它們對齊。
  assert.equal(grade("l'école", ['l’école']).reason, 'exact');
});

test('grade：只差大小寫算對', () => {
  const r = grade('École', ['école']);
  assert.equal(r.correct, true);
  assert.equal(r.reason, 'case');
  assert.equal(r.matched, 'école');
});

test('grade：只差重音算錯，但要說得出來是哪個答案', () => {
  const r = grade('ecole', ['école']);
  assert.equal(r.correct, false);
  assert.equal(r.reason, 'accent');
  assert.equal(r.matched, 'école');

  // 同時差大小寫與重音時，判定要落在 accent——差重音才是實質錯誤。
  assert.equal(grade('Ecole', ['école']).reason, 'accent');
  assert.equal(grade('coeur', ['cœur']).reason, 'accent');
  assert.equal(grade('ca', ['ça']).reason, 'accent');
});

test('grade：其他情況是 wrong，且不亂猜 matched', () => {
  const r = grade('chien', ['école']);
  assert.equal(r.correct, false);
  assert.equal(r.reason, 'wrong');
  assert.equal(r.matched, null);
});

test('grade：空白作答是 empty，不是 wrong', () => {
  // 分開記是為了統計頁——「沒作答」與「拼錯」要能分辨，否則看不出是不會還是放棄。
  for (const input of ['', '   ', '\n', null, undefined]) {
    assert.deepEqual(grade(input, ['école']), { correct: false, reason: 'empty', matched: null });
  }
});

test('grade：多個可接受答案時，命中哪一個就回哪一個', () => {
  const accepted = ['je suis', "j'suis"];
  assert.equal(grade('je suis', accepted).matched, 'je suis');
  assert.equal(grade('j’suis', accepted).matched, 'j’suis');
  // 有一個是 exact 就不該退回 accent。
  assert.equal(grade('je suis', ['je sui', 'je suis']).reason, 'exact');
  // 空字串候選要被濾掉，不能讓空作答意外命中。
  assert.equal(grade('école', ['', 'école']).reason, 'exact');
});

test('diffChars：以正確答案為骨架逐格標記', () => {
  assert.deepEqual(diffChars('ecole', 'école'), [
    { ch: 'é', ok: false },
    { ch: 'c', ok: true },
    { ch: 'o', ok: true },
    { ch: 'l', ok: true },
    { ch: 'e', ok: true },
  ]);
  // 作答比答案短：缺的位置一律標錯，長度仍等於答案長度。
  const short = diffChars('éc', 'école');
  assert.equal(short.length, 5);
  assert.deepEqual(short.map((x) => x.ok), [true, true, false, false, false]);
  // 作答比答案長：多打的字不出現在結果裡，畫面只標答案的格子。
  assert.equal(diffChars('écoles', 'école').length, 5);
  // 用碼點切，不用 UTF-16 單元；組合字元經 normalize 後已是單一碼點。
  assert.equal(diffChars('école', 'école').every((x) => x.ok), true);
});

test('missingAccents：只回報「同一個字母、少了符號」的位置', () => {
  assert.deepEqual(missingAccents('ecole', 'école'), ['é']);
  assert.deepEqual(missingAccents('etre', 'être'), ['ê']);
  assert.deepEqual(missingAccents('ca', 'ça'), ['ç']);
  // 重複出現的符號只回一次——提示是「你漏了 é」，不是列出每個位置。
  assert.deepEqual(missingAccents('elevee', 'élevée'), ['é']);
  // 拼成另一個字時不該冒充成漏重音。
  assert.deepEqual(missingAccents('chien', 'école'), []);
  // 作答太短時，缺的位置沒有對應字母，不算漏重音。
  assert.deepEqual(missingAccents('', 'école'), []);
});
