/**
 * 挑連接詞題（考卷第 II 大題）的解析與三級批改測試。
 *
 * 這個檔案守的是一個教學決定：**省音錯、性數錯、選錯格是三種不同的錯**，
 * 但三種都是錯。分級是為了講得出你該補什麼，不是為了放水——
 * 哪天有人把 elision 改成「算對」，這裡會先紅。
 *
 * 表格用行內字串當樣本，不讀 vault：測的是解析規則，
 * 不是「今天筆記裡剛好有幾題」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  expandOption, normPick, unelide, familyOf, gradePick, parsePickTable,
} from '../src/build/picks.mjs';
import { makePickCards } from '../src/build/bank.mjs';

const A_OPTIONS = ['sans que', 'à moins que', 'à moins de', 'sinon', 'même si', 'comme si'];

test('expandOption：括號展開成所有詞形', () => {
  // 方框印的是詞形族。quel(le)(s) que 一格涵蓋四種寫法，
  // 「選對格子」與「配對性數」是兩個獨立的考點，不能混成一個。
  const forms = expandOption('quel(le)(s) que');
  assert.deepEqual([...forms].sort(), ['quel que', 'quelle que', 'quelles que', 'quels que']);
});

test('expandOption：「…que」是插入位置的標記，不是要寫的字', () => {
  // Quelque(s)…que 的中間要填名詞或形容詞，字面照抄「…que」是錯的。
  const forms = expandOption('Quelque(s)…que');
  assert.deepEqual([...forms].sort(), ['quelque', 'quelques']);
});

test('normPick 不還原省音，unelide 才還原', () => {
  // 省音本身是考點，正規化階段抹掉它就沒得批了。
  assert.equal(normPick("À MOINS D’"), "à moins d'");
  // 還原後要壓掉多出來的空白，否則 `à moins de ` 與 `à moins de` 比不相等，
  // 省音錯會被誤判成選錯格。
  assert.equal(unelide("à moins d'"), 'à moins de');
  assert.equal(unelide("qu'il"), 'que il');
});

test('familyOf：取最長匹配，才分得出 à moins que 與 à moins de', () => {
  assert.equal(familyOf("à moins d'avoir", A_OPTIONS), 'à moins de');
  assert.equal(familyOf("à moins qu'il", A_OPTIONS), 'à moins que');
  assert.equal(familyOf('pourvu que', A_OPTIONS), null);
});

test('gradePick：完全正確', () => {
  const r = gradePick('à moins que', 'à moins que', A_OPTIONS);
  assert.deepEqual({ correct: r.correct, reason: r.reason }, { correct: true, reason: 'exact' });
});

test('gradePick：省音是第一級，算錯但講得出錯在哪', () => {
  const r = gradePick('à moins que', "à moins qu'", A_OPTIONS);
  assert.equal(r.reason, 'elision');
  assert.equal(r.correct, false);
});

test('gradePick：性數／形式是第二級', () => {
  const opts = ['quel(le)(s) que', 'quoi que', 'où que'];
  const r = gradePick('Quel que', 'Quelles que', opts);
  assert.equal(r.reason, 'family');
  assert.equal(r.correct, false);
});

test('gradePick：quoique 與 quoi que 是兩格，不是同一族', () => {
  // 一個字是「雖然」，兩個字是「無論什麼」。意思不同，答錯就是選錯格，
  // 不能因為長得像就降級成 family。
  const opts = ['quoique', 'quoi que'];
  const r = gradePick('quoique', 'quoi que', opts);
  assert.equal(r.reason, 'wrong');
});

test('gradePick：沒作答與選錯格分開記', () => {
  assert.equal(gradePick('', 'sinon', A_OPTIONS).reason, 'empty');
  assert.equal(gradePick('même si', 'sinon', A_OPTIONS).reason, 'wrong');
});

const MD = `
## 題庫

### D. si – au cas où – comme si（2 題）

| # | 題目 | 解答 | 理由 | 出處 |
|---|---|---|---|---|
| 1 | ___ tu venais, préviens-moi. | **Si** | 直陳式 | 課本 p.2 |
| 2 | Il parle ___ il savait tout. | **comme si** | 未完成 | 課本 p.3 |

### E. sans – avec（1 題）

| # | 題目 | 解答 | 理由 | 出處 |
|---|---|---|---|---|
| 1 | ___ toi, je n'y arrive pas. | **Sans** | ＋名詞 | 課本 p.4 |

## 沒有做成題的講義句子

| # | 句子 |
|---|---|
| 1 | 這一列不該被讀進來。 |
`;

test('parsePickTable：組標題就是方框，不在程式裡另抄一份', () => {
  const items = parsePickTable(MD, { head: '## 題庫', tail: '## 沒有做成題的', sec: '講義', fallbackSrc: '教材 講義' });
  assert.equal(items.length, 3);
  assert.deepEqual(items[0].options, ['si', 'au cas où', 'comme si']);
  assert.equal(items[0].answer, 'Si');
  assert.equal(items[2].group, 'E');
  // tail 之後的表格不算題目。
  assert.ok(items.every((it) => it.sec === '講義'));
});

test('parsePickTable：每一題的答案都對得上自己那個方框', () => {
  // 解析對了但答案落在方框外，代表標題拆錯或答案抄錯，兩種都要當場發現。
  const items = parsePickTable(MD, { head: '## 題庫', tail: '## 沒有做成題的', sec: '講義', fallbackSrc: '教材 講義' });
  for (const it of items) assert.ok(familyOf(it.answer, it.options), `${it.id} 的答案不在方框裡`);
});

test('parsePickTable：找不到區段就回空陣列，不是拋錯', () => {
  assert.deepEqual(parsePickTable(MD, { head: '## 不存在', tail: '## 也不存在', sec: 'X', fallbackSrc: 'x' }), []);
});

test('makePickCards：方框留在題面，但作答方式是打字', () => {
  // 點按鈕會把省音與性數這兩個考點整個抹掉，所以 mode 一定是 typed。
  const items = parsePickTable(MD, { head: '## 題庫', tail: '## 沒有做成題的', sec: '講義', fallbackSrc: '教材 講義' });
  const [card] = makePickCards(items);
  assert.equal(card.kind, 'pick');
  assert.equal(card.mode, 'typed');
  assert.deepEqual(card.accept, ['Si']);
  assert.deepEqual(card.front.options, ['si', 'au cas où', 'comme si']);
  assert.ok(card.front.prompt.includes('___'));
});
