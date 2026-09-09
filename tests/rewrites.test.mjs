/**
 * 改寫題（考卷第 III 大題）的解析與半自動批改測試。
 *
 * 這個檔案守的是一個教學決定：**整句不做字串比對**。
 * 同一題有好幾種都對的寫法，程式只查兩件有定論的事——
 * 指定的連接詞用了沒有、後面接的語氣對不對——其餘交給自評。
 * 哪天有人把整句比對加回來，這裡會先紅。
 *
 * 表格用行內字串當樣本，不讀 vault：測的是解析規則，
 * 不是「今天筆記裡剛好有幾題」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMust, parseRewriteTable } from '../src/build/rewrites.mjs';
import { gradeRewrite } from '../src/engine/grade.mjs';
import { makeRewriteCards } from '../src/build/bank.mjs';

const MD = `## III. Transformez les phrases（用指定連接詞改寫）18%

| # | 原句 / 工具 | 改寫解答 | 理由 | 必要要素 |
|---|---|---|---|---|
| 1 | Bien qu'il ait fait des démarches…（avoir + beau） | Il a eu beau faire des démarches, il n'a rien obtenu. | avoir beau + inf | \`eu beau\` ＋ \`faire\` |
| 2 | Il est très agréable, mais…（si … que + subj） | Si agréable qu'il soit, je ne le supporte pas. | si + adj + que + subj | \`si agréable\` ＋ \`soit\` |
| 3 | S'il venait…（au cas où） | Au cas où il viendrait, préviens-moi. | au cas où + cond | \`au cas où\` ＋ \`viendrait／viendra\` |

## IV. Nominalisez（名詞化）

| # | 動詞 | 名詞 |
|---|---|---|
| 1 | construire | la construction |
`;

const BANK = `## 題庫

| # | 中文（教材逐字）/ 指定工具 | 法文解答（教材逐字） | 理由 | 必要要素 | 出處 |
|---|---|---|---|---|---|
| 1 | 今年夏天很熱，而去年夏天很冷。（alors que） | Cet été a été chaud, alors que l'été dernier a été froid. | alors que + 直陳式 | \`alors que\` ＋ \`a été\` | 教材 OPPOSITION-課本 p.1 |
| 2 | 雖然下雨，我們還是出門了。（malgré） | Malgré la pluie, nous sommes sortis. | malgré + 名詞 | \`malgré\` | |

## 教材原文瑕疵

| # | 說明 |
|---|---|
| 1 | 第 7 題原文缺一個 accent |
`;

test('parseMust：＋ 是且，／ 是或', () => {
  // 兩種分隔符都是全形。半形加號會出現在要素本身（avoir + beau），
  // 拿它當分隔符會把一個要素劈成兩半。
  assert.deepEqual(parseMust('`au cas où` ＋ `viendrait／viendra`'), [
    ['au cas où'],
    ['viendrait', 'viendra'],
  ]);
  assert.deepEqual(parseMust(''), []);
});

test('parseRewriteTable：指定工具從題幹末尾的括號裡抽出來', () => {
  // 工具是題目的限制條件，不是註記。連著括號印出去，
  // 使用者會把「（avoir + beau）」當成句子的一部分。
  const items = parseRewriteTable(MD, {
    head: '## III.', tail: '## IV.', sec: 'III', fallbackSrc: '教材 111-2 III',
  });
  assert.equal(items.length, 3);
  assert.equal(items[0].tool, 'avoir + beau');
  assert.equal(items[0].prompt, "Bien qu'il ait fait des démarches…");
  assert.deepEqual(items[0].must, [['eu beau'], ['faire']]);
  assert.equal(items[0].id, 'rw:III|1');
});

test('parseRewriteTable：tail 擋住下一個大題', () => {
  // 第 IV 大題也是三欄以上的表，界線沒切好會把名詞化題當成改寫題收進來。
  const items = parseRewriteTable(MD, {
    head: '## III.', tail: '## IV.', sec: 'III', fallbackSrc: 'x',
  });
  assert.ok(items.every((it) => it.tool !== ''));
  assert.ok(!items.some((it) => it.answer === 'la construction'));
});

test('parseRewriteTable：出處逐題取，缺的才套 fallback', () => {
  // 擴充題庫每題出自講義不同頁，共用一個標籤就查不回去了。
  const items = parseRewriteTable(BANK, {
    head: '## 題庫', tail: '## 教材原文瑕疵', sec: 'B', fallbackSrc: '教材 講義',
  });
  assert.equal(items.length, 2);
  assert.equal(items[0].src, '教材 OPPOSITION-課本 p.1');
  assert.equal(items[1].src, '教材 講義');
  assert.deepEqual(items[1].must, [['malgré']]);
});

test('parseRewriteTable：找不到區段回空陣列', () => {
  assert.deepEqual(parseRewriteTable(MD, { head: '## IX.', tail: '## X.', sec: 'IX' }), []);
});

test('gradeRewrite：要素齊全就過，不比對整句', () => {
  // 這一題的兩種寫法都對。整句比對會把其中一種判錯，那是假錯誤。
  const must = [['si agréable'], ['soit']];
  assert.equal(gradeRewrite("Si agréable qu'il soit, je ne le supporte pas.", must).correct, true);
  assert.equal(gradeRewrite('Si agréable soit-il, je ne le supporte pas.', must).correct, true);
});

test('gradeRewrite：組內是或，任一寫法即可', () => {
  const must = [['au cas où'], ['viendrait', 'viendra']];
  assert.equal(gradeRewrite('Au cas où il viendrait, préviens-moi.', must).correct, true);
  assert.equal(gradeRewrite('Au cas où il viendra, préviens-moi.', must).correct, true);
});

test('gradeRewrite：缺任一組就判錯，並指出缺的是哪一組', () => {
  // 少了語氣（soit）就是沒用到 si…que 的句型，意思再接近也不算改對。
  const r = gradeRewrite('Il est très agréable mais je ne le supporte pas.', [['si agréable'], ['soit']]);
  assert.equal(r.correct, false);
  assert.equal(r.reason, 'missing');
  assert.deepEqual(r.miss, [['si agréable'], ['soit']]);
});

test('gradeRewrite：只差重音不判錯，另外提示', () => {
  // 這一題考的是連接詞與語氣，拼寫另有 vocab 題型在管，一個錯不罰兩次。
  const r = gradeRewrite('Si agreable soit-il.', [['si agréable'], ['soit']]);
  assert.equal(r.correct, true);
  assert.equal(r.reason, 'accent');
  assert.deepEqual(r.accent, [['si agréable']]);
  assert.deepEqual(r.miss, []);
});

test('gradeRewrite：沒作答不算「零個要素都沒缺」', () => {
  // 空字串包含任何子字串的判斷是 false，但別讓它靠著空 must 混成 correct。
  const r = gradeRewrite('', [['alors que']]);
  assert.equal(r.correct, false);
  assert.equal(r.reason, 'empty');
});

test('makeRewriteCards：整句沒有唯一解，所以不給 accept', () => {
  const [card] = makeRewriteCards(parseRewriteTable(MD, {
    head: '## III.', tail: '## IV.', sec: 'III', fallbackSrc: '教材 111-2 III',
  }));
  assert.equal(card.kind, 'rw');
  assert.equal(card.mode, 'rewrite');
  assert.equal(card.accept, null);
  // must 放在頂層而不是 front：它含答案片段，出題時要跟 answer 一起拿掉。
  assert.deepEqual(card.must, [['eu beau'], ['faire']]);
  assert.equal(card.front.tool, 'avoir + beau');
});
