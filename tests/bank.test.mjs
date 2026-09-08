/**
 * 題庫生成測試。
 *
 * 這一層決定「什麼會被出成題、答案認哪些」。它出錯的形狀跟別層不一樣：
 * 不會壞掉，只會讓人每天多背幾張不該背的、或是把答對的判成答錯。
 * 所以測試盯的是四個決定：
 *   1. 中文釋義撞號的字要互相認（「除非」同時是 sauf si 和 à moins que）
 *   2. 帶 ⚠ 的可疑釋義不拿來當中翻法的題面
 *   3. 規則動詞（aim:er／fin:ir）進查詢用的變位表，但不出變位題
 *   4. 多解的連接詞不出單選題——把「兩種都對」教成「只有一種對」比不教還糟
 *
 * 全部用行內 fixture，不碰三個外部來源。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeVocabCards, makeConjCards, makeConnectorCards, TENSES, POS_ZH } from '../src/build/bank.mjs';
import { parseConnectors, MOOD_LABELS } from '../src/build/connectors.mjs';
import { parseVerbs, parseTemplates, AUX_DUAL_NOTE } from '../src/build/verbiste.mjs';

// ---- 詞彙卡 ----

const GLOSS_TABLES = {
  plain: new Map([['livre', '書'], ['sauf si', '除非'], ['à moins que', '除非'], ['clair', '⚠ 大寫誤標']]),
  bypos: new Map([['livre|NOM', '書'], ['pouvoir|VER', '能夠'], ['pouvoir|NOM', '權力']]),
  override: new Map(),
};

const EN_DEFS = { livre: { NOM: ['book'] }, pouvoir: { VER: ['to be able to'] } };
const GENDERS = { livre: { g: 'm', elide: false }, pouvoir: { g: 'm', elide: false } };

const entry = (word, over = {}) => ({ word, pos: 'NOM', level: 'A1', freq: 100, ...over });

test('詞彙卡：一個字產生「認」與「寫」兩張，模式不同', () => {
  const cards = makeVocabCards([entry('livre')], GLOSS_TABLES, EN_DEFS, GENDERS);
  assert.equal(cards.length, 2);

  const [recall, produce] = cards;
  assert.equal(recall.id, 'v:livre|NOM|r');
  assert.equal(recall.kind, 'vocab-recall');
  // 「意思對不對」機器判不了，只能自評。
  assert.equal(recall.mode, 'self');
  assert.equal(recall.answer, undefined);

  assert.equal(produce.id, 'v:livre|NOM|p');
  assert.equal(produce.kind, 'vocab-produce');
  assert.equal(produce.mode, 'typed');
  assert.equal(produce.answer, 'livre');
  assert.deepEqual(produce.accept, ['livre']);
  assert.deepEqual(produce.tags, ['vocab', 'A1', 'NOM']);
  assert.deepEqual(produce.front.en, ['book']);
  assert.equal(produce.front.gender, 'm');
  assert.equal(produce.front.posZh, POS_ZH.NOM);
});

test('詞彙卡：中文撞號的同詞性字互相認', () => {
  const cards = makeVocabCards(
    [entry('sauf si', { pos: 'ADV' }), entry('à moins que', { pos: 'ADV' })],
    { ...GLOSS_TABLES, bypos: new Map() },
    {}, {},
  );
  const produce = cards.filter((c) => c.kind === 'vocab-produce');
  assert.equal(produce.length, 2);
  // 兩張卡的題面都是「除非」。只認自己那個字的話，答另一個會被判錯。
  for (const c of produce) {
    assert.deepEqual(c.accept, ['sauf si', 'à moins que']);
    assert.equal(c.front.gloss, '除非');
  }
  // answer 仍然是各自的字：提示要顯示的是這張卡問的那個。
  assert.deepEqual(produce.map((c) => c.answer), ['sauf si', 'à moins que']);
});

test('詞彙卡：帶 ⚠ 的釋義只出「認」不出「寫」', () => {
  const cards = makeVocabCards([entry('clair', { pos: 'ADJ' })], GLOSS_TABLES, {}, {});
  assert.deepEqual(cards.map((c) => c.kind), ['vocab-recall']);
  assert.equal(cards[0].front.noisy, true);
});

test('詞彙卡：查不到釋義的字一張都不出', () => {
  const cards = makeVocabCards([entry('zzz')], GLOSS_TABLES, {}, {});
  assert.deepEqual(cards, []);
});

test('詞彙卡：釋義依詞性歸戶，動詞不會拿到名詞的解釋', () => {
  const cards = makeVocabCards([entry('pouvoir', { pos: 'VER' })], GLOSS_TABLES, EN_DEFS, GENDERS);
  assert.equal(cards[0].front.gloss, '能夠');
  // 陰陽性只對名詞有意義。
  assert.equal(cards[0].front.gender, null);
});

test('詞彙卡：條目自帶的 zh 優先於釋義表，且標明來源', () => {
  const cards = makeVocabCards([entry('livre', { zh: ['書本', '磅'] })], GLOSS_TABLES, {}, {});
  assert.equal(cards[0].front.gloss, '書本 / 磅');
  assert.equal(cards[0].front.glossSource, 'Wiktionnaire-fr');
  const fallback = makeVocabCards([entry('livre')], GLOSS_TABLES, {}, {});
  assert.equal(fallback[0].front.glossSource, 'manual');
});

// ---- 變位卡 ----

const VERBS_XML = `
<v><i>avoir</i><t>av:oir</t></v>
<v><i>être</i><t>:être</t></v>
<v><i>parler</i><t>aim:er</t></v>
<v><i>monter</i><t>aim:er</t></v>
<v><i>venir</i><t>v:enir</t></v>
<v><i>payer</i><t>pa:yer</t></v>
<v><i>pleuvoir</i><t>pl:euvoir</t></v>
<v><i>fantôme</i><t>tpl:inexistant</t></v>`;

/** 只鋪出題會用到的六個時態，其餘留空以縮短 fixture。 */
function tmpl(name, forms) {
  const six = (list) => list.map((f) => `<p>${f ? `<i>${f}</i>` : ''}</p>`).join('');
  return `<template name="${name}">
    <indicative>
      <present>${six(forms.pres ?? [])}</present>
      <imperfect>${six(forms.imp ?? [])}</imperfect>
      <future>${six(forms.fut ?? [])}</future>
    </indicative>
    <conditional><present>${six(forms.cond ?? [])}</present></conditional>
    <subjunctive><present>${six(forms.subj ?? [])}</present></subjunctive>
    <participle><past-participle><p><i>${forms.pp ?? ''}</i></p></past-participle></participle>
  </template>`;
}

const TEMPLATES_XML = [
  tmpl('av:oir', { pres: ['ai', 'as', 'a', 'avons', 'avez', 'ont'], pp: 'eu' }),
  tmpl(':être', { pres: ['suis', 'es', 'est', 'sommes', 'êtes', 'sont'], pp: 'été' }),
  tmpl('aim:er', { pres: ['e', 'es', 'e', 'ons', 'ez', 'ent'], pp: 'é' }),
  tmpl('v:enir', { pres: ['iens', 'iens', 'ient', 'enons', 'enez', 'iennent'], pp: 'enu' }),
  tmpl('pl:euvoir', { pres: ['', '', 'eut', '', '', 'euvent'], pp: 'u' }),
].join('\n');

// payer 的多套形式要手寫，tmpl() 只鋪單一形式。
const PAYER_XML = `<template name="pa:yer">
  <indicative><present>
    <p><i>ie</i><i>ye</i></p><p><i>ies</i><i>yes</i></p><p><i>ie</i><i>ye</i></p>
    <p><i>yons</i></p><p><i>yez</i></p><p><i>ient</i><i>yent</i></p>
  </present></indicative>
  <participle><past-participle><p><i>yé</i></p></past-participle></participle>
</template>`;

const verbs = parseVerbs(VERBS_XML);
const templates = parseTemplates(`${TEMPLATES_XML}\n${PAYER_XML}`);

const verbEntry = (word, over = {}) => ({ word, pos: 'VER', level: 'A2', freq: 50, gloss: '', ...over });

test('變位卡：規則動詞進變位表但不出題', () => {
  const { cards, tables } = makeConjCards([verbEntry('parler'), verbEntry('venir')], verbs, templates);
  // parler 走 aim:er，推得出來，不值得背。
  assert.ok(tables.parler, 'parler 仍應該查得到變位表');
  assert.equal(tables.parler.template, 'aim:er');
  assert.equal(cards.some((c) => c.front.verb === 'parler'), false);
  // venir 不規則，要出題。
  assert.ok(cards.some((c) => c.front.verb === 'venir'));
});

test('變位卡：查無變位資料的動詞既不進表也不出題', () => {
  const { cards, tables } = makeConjCards([verbEntry('fantôme')], verbs, templates);
  assert.deepEqual(cards, []);
  assert.deepEqual(Object.keys(tables), []);
});

test('變位卡：id、標籤與題面欄位', () => {
  const { cards } = makeConjCards([verbEntry('venir', { gloss: '來' })], verbs, templates);
  const je = cards.find((c) => c.id === 'c:venir|pres|0');
  assert.equal(je.kind, 'conj');
  assert.equal(je.mode, 'typed');
  assert.equal(je.answer, 'viens');
  assert.deepEqual(je.accept, ['viens']);
  assert.deepEqual(je.tags, ['conj', 'A2', 'pres', 'v:enir']);
  assert.equal(je.front.pronoun, 'je');
  assert.equal(je.front.person, 0);
  assert.equal(je.front.tense, 'présent');
  assert.equal(je.front.tenseZh, '現在式');
  assert.equal(je.front.gloss, '來');
  // 簡單時態沒有助動詞可講。
  assert.equal(je.front.aux, null);
  assert.equal(je.front.note, '');
});

test('變位卡：複合過去式掛上助動詞，雙助動詞另掛註記', () => {
  const { cards } = makeConjCards([verbEntry('venir'), verbEntry('monter')], verbs, templates);
  const venirPc = cards.find((c) => c.id === 'c:venir|pc|0');
  assert.equal(venirPc.answer, 'suis venu');
  assert.equal(venirPc.front.aux, 'être');
  assert.equal(venirPc.front.note, '');
  // monter 走規則模板所以不出題，但助動詞註記的判斷仍要驗——改用一張表確認。
  const { tables } = makeConjCards([verbEntry('monter')], verbs, templates);
  assert.equal(tables.monter.auxDual, true);
  assert.equal(tables.monter.aux, 'être');
  assert.ok(AUX_DUAL_NOTE.length > 0);
});

test('變位卡：一格兩套正規形式時兩個都算對，answer 取第一個', () => {
  const { cards } = makeConjCards([verbEntry('payer')], verbs, templates);
  const je = cards.find((c) => c.id === 'c:payer|pres|0');
  assert.deepEqual(je.accept, ['paie', 'paye']);
  assert.equal(je.answer, 'paie');
  // 分隔符號本身不能留在答案裡。
  assert.equal(je.accept.some((a) => a.includes('／')), false);
});

test('變位卡：無人稱動詞只出第三人稱單數', () => {
  const { cards } = makeConjCards([verbEntry('pleuvoir')], verbs, templates);
  assert.ok(cards.length > 0);
  for (const c of cards) {
    assert.equal(c.front.person, 2, `${c.id} 不該出題`);
    assert.equal(c.front.pronoun, 'il');
  }
  // 第三人稱複數 pleuvent 在變位表裡有，但「它們下雨」不是句子。
  assert.equal(cards.some((c) => c.answer === 'pleuvent'), false);
});

test('變位卡：空的人稱格不出題，id 不重複', () => {
  const { cards } = makeConjCards(
    [verbEntry('venir'), verbEntry('payer'), verbEntry('pleuvoir')], verbs, templates,
  );
  const ids = cards.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const c of cards) {
    assert.ok(c.answer && c.answer.trim() === c.answer, `${c.id} 的答案是空的或含空白`);
  }
  // fixture 只鋪了 présent，其餘時態空著，所以只會有 présent 與 passé composé 兩種。
  assert.deepEqual([...new Set(cards.map((c) => c.front.tenseKey))].sort(), ['pc', 'pres']);
  assert.deepEqual(TENSES.map((t) => t.key), ['pres', 'imp', 'fut', 'cond', 'subj', 'pc']);
});

// ---- 連接詞 ----

const CONNECTOR_MD = `# 連接詞

## 快速判斷表（後接語氣）

| 連接詞 / 表達 | 功能 | 後接 | 中文 |
| --- | --- | --- | --- |
| avant que / jusqu’à ce que | 時間 | **subjonctif** | 在…之前 / 直到 |
| alors que（對立）/ même si | 對立·條件 | **indicatif** | 然而 / 即使 |
| tout + adj + que | 對立讓步 | **可接 indicatif** | 儘管很… |
| au cas où | 條件 | **conditionnel** | 萬一 |
| avoir beau | 對立讓步 | **+ infinitif** | 儘管…也（白費） |
| en cas de | 條件 | **+ nom** | 萬一發生… |
| **sinon** | 條件（否定） | **indicatif／conditionnel，視語氣** | 否則 / 不然 |
| 表格結構變了 | 沒有後接欄 |
| quand / alors que / au moment où … | 時間 | indicatif（依時態判斷） | 當 / 在…的時候 |

## 時間 L’expression du temps

| 這張表不該被讀進來 | 時間 | **subjonctif** | 不是連接詞 |
`;

const parsed = parseConnectors(CONNECTOR_MD);
const byName = (name) => parsed.find((c) => c.connector === name);

test('連接詞：拆開同一列的多個詞，中文數量對得上就逐一配對', () => {
  assert.equal(byName('avant que').zh, '在…之前');
  assert.equal(byName('jusqu’à ce que').zh, '直到');
  assert.equal(byName('avant que').mood, 'subjonctif');
  // 數量對不上時整列共用同一段中文，不硬配。
  assert.equal(byName('quand').zh, '當 / 在…的時候');
});

test('連接詞：括號註記拆成 sense，省略號不算詞的一部分', () => {
  // 「alors que（對立）」的括號是用法說明；留在題面等於先告訴你答案。
  assert.equal(byName('alors que').sense, '對立');
  assert.ok(byName('au moment où'));
  assert.equal(byName('au moment où …'), undefined);
});

test('連接詞：同名的兩列併成一條，功能欄合併', () => {
  const alors = parsed.filter((c) => c.connector === 'alors que');
  assert.equal(alors.length, 1);
  assert.equal(alors[0].fn, '對立·條件／時間');
});

test('連接詞：多解的記成 ambiguous', () => {
  assert.equal(byName('sinon').ambiguous, true);
  assert.deepEqual(byName('sinon').moods, ['conditionnel', 'indicatif']);
  // 「可接」也是多解的說法。
  assert.equal(byName('tout + adj + que').ambiguous, true);
  // 「依時態判斷」講的是時態不是語氣，仍然是明確的 indicatif。
  assert.equal(byName('quand').ambiguous, false);
});

test('連接詞：認不出後接語氣或欄位不足的列直接跳過，讀到下一個 ## 就停', () => {
  assert.equal(byName('表格結構變了'), undefined);
  assert.equal(byName('這張表不該被讀進來'), undefined);
  assert.equal(parsed.length, 11);
});

test('連接詞：找不到判斷表時回空陣列，不猜', () => {
  // 寧可讓 build 報「連接詞 0 筆」，也不要靜默產出半套資料。
  assert.deepEqual(parseConnectors('# 筆記\n\n沒有那張表。'), []);
});

test('連接詞卡：多解的不出題，選項是五種語氣', () => {
  const cards = makeConnectorCards(parsed);
  assert.equal(cards.length, parsed.filter((c) => !c.ambiguous).length);
  assert.equal(cards.some((c) => c.id === 'k:sinon'), false);

  const card = cards.find((c) => c.id === 'k:alors que');
  assert.equal(card.kind, 'connector');
  assert.equal(card.mode, 'choice');
  assert.equal(card.level, 'B1');
  assert.equal(card.answer, 'indicatif');
  assert.deepEqual(card.accept, ['indicatif']);
  assert.deepEqual(card.options, Object.keys(MOOD_LABELS));
  assert.equal(card.options.length, 5);
  assert.equal(card.front.sense, '對立');
  // 每個選項都要有中文標籤，否則畫面上只有法文術語。
  for (const o of card.options) assert.ok(MOOD_LABELS[o]);
});
