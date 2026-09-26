/**
 * 題庫生成測試。
 *
 * 這一層決定「什麼會被出成題、答案認哪些」。它出錯的形狀跟別層不一樣：
 * 不會壞掉，只會讓人每天多背幾張不該背的、或是把答對的判成答錯。
 * 所以測試盯的是四個決定：
 *   1. 中文釋義撞號的字要互相認（「除非」同時是 sauf si 和 à moins que）
 *   2. 帶 ⚠ 的可疑釋義不出卡（作答過的那張照留，免得排程狀態被一起刪掉）
 *   3. 規則動詞（aim:er／fin:ir）進查詢用的變位表，但不出變位題
 *   4. 多解的連接詞不出單選題——把「兩種都對」教成「只有一種對」比不教還糟
 *
 * 全部用行內 fixture，不碰三個外部來源。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeVocabCards, makeConjCards, makeConnectorCards, mergeEntries, TENSES, POS_ZH } from '../src/build/bank.mjs';
import { parseConnectors, parseMoodTable, mergeConnectors, MOOD_LABELS, MOOD_ZH } from '../src/build/connectors.mjs';
import { CONNECTOR_GLOSS } from '../src/build/connector-gloss.mjs';
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

test('詞彙卡：帶 ⚠ 的釋義一張都不出', () => {
  const cards = makeVocabCards([entry('clair', { pos: 'ADJ' })], GLOSS_TABLES, {}, {});
  assert.deepEqual(cards, []);
});

test('詞彙卡：雜訊詞條作答過的那張照留，沒作答過的不出', () => {
  // est-à-dire 的「認」卡 2026-09-26 前就有作答紀錄；卡片消失，Store.loadBank() 會把排程狀態刪掉。
  const cards = makeVocabCards([entry('clair', { pos: 'ADJ' })], GLOSS_TABLES, {}, {},
    { reviewed: new Set(['v:clair|ADJ|r']) });
  assert.deepEqual(cards.map((c) => c.id), ['v:clair|ADJ|r']);
  assert.equal(cards[0].front.noisy, true);
});

test('詞彙卡：釋義中間的「(⚠ 亦為…)」是同形字註記，不算雜訊', () => {
  const cards = makeVocabCards([entry('livre')], GLOSS_TABLES, {}, {},
    { glosses: { 'livre|NOM': '書 (⚠ 亦為陰性名詞「磅」)' } });
  assert.deepEqual(cards.map((c) => c.kind), ['vocab-recall', 'vocab-produce']);
  assert.equal(cards[0].front.noisy, false);
});

test('詞彙卡：lexicon 的釋義優先於 fexgen，來源標 cadence', () => {
  const cards = makeVocabCards([entry('livre', { zh: ['書本', '磅'] })], GLOSS_TABLES, {}, {},
    { glosses: { 'livre|NOM': '書' } });
  assert.equal(cards[0].front.gloss, '書');
  assert.equal(cards[0].front.glossSource, 'cadence');
});

test('詞彙卡：例句放進題面資料，沒有例句就不帶這個欄位', () => {
  const ex = [{ id: 1, fr: 'Je lis un livre.', hit: 'livre', by: 'x' }];
  const [withEx] = makeVocabCards([entry('livre')], GLOSS_TABLES, {}, {}, { examples: { 'livre|NOM': ex } });
  assert.deepEqual(withEx.front.examples, ex);
  const [without] = makeVocabCards([entry('livre')], GLOSS_TABLES, {}, {});
  assert.equal('examples' in without.front, false);
});

test('合併詞表：拼法更正後去重，留等級低的那筆，src 記原拼法', () => {
  const fex = [{ word: 'coeur', pos: 'NOM', level: 'A1', freq: 900 }];
  const b2 = [
    { word: 'œuvre', pos: 'NOM', level: 'B2', freq: 50 },
    { word: 'oeuvre', pos: 'NOM', level: 'B2', freq: 40 },
    { word: 'coeur', pos: 'NOM', level: 'B2', freq: 10 },
  ];
  const out = mergeEntries(fex, b2, { coeur: 'cœur', oeuvre: 'œuvre' });
  assert.deepEqual(out.map((e) => [e.word, e.level, e.src]), [['cœur', 'A1', 'coeur'], ['œuvre', 'B2', 'œuvre']]);
  // 新 id 用更正後的拼法；查 fexgen 的英文定義與例句用原拼法。
  const cards = makeVocabCards(out.slice(0, 1), { ...GLOSS_TABLES, plain: new Map([['coeur', '心']]) },
    { coeur: { NOM: ['heart'] } }, {}, { examples: { 'coeur|NOM': [{ id: 2, fr: 'Mon cœur', hit: 'cœur', by: 'y' }] } });
  assert.equal(cards[0].id, 'v:cœur|NOM|r');
  assert.equal(cards[0].front.gloss, '心');
  assert.deepEqual(cards[0].front.en, ['heart']);
  assert.equal(cards[0].front.examples.length, 1);
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

test('連接詞卡：多解的不出題，選項是全部語氣', () => {
  const cards = makeConnectorCards(parsed);
  assert.equal(cards.length, parsed.filter((c) => !c.ambiguous).length);
  assert.equal(cards.some((c) => c.id === 'k:sinon'), false);

  const card = cards.find((c) => c.id === 'k:alors que');
  assert.equal(card.kind, 'connector');
  assert.equal(card.mode, 'choice');
  assert.equal(card.level, 'B1');
  assert.equal(card.answer, 'indicatif');
  assert.deepEqual(card.accept, ['indicatif']);
  // 選項放在 front 裡，與挑連接詞卡同一個位置——前端只從那裡讀。
  assert.deepEqual(card.front.options, Object.keys(MOOD_LABELS));
  assert.equal(card.options, undefined);
  // 2026-09-09 起多一個 imparfait：comme si 接的不是 conditionnel，
  // 那一步答「indicatif」等於沒答到，所以獨立成選項。
  assert.equal(card.front.options.length, 6);
  assert.equal(card.front.sense, '對立');
  // 每個選項都要有中文標籤，否則畫面上只有法文術語。
  for (const o of card.front.options) assert.ok(MOOD_LABELS[o]);
  // 中文標籤要跟著卡片走。只留在 build 端的話，畫面上就只剩法文術語，
  // 2026-09-10 之前正是這樣——那等於在考術語，不是考語感。
  for (const o of card.front.options) assert.ok(card.front.optionZh[o], `${o} 沒有中文`);
});

// ---------------------------------------------------------------------------
// 權威表（final-exam-grammar-core.md）：依語氣分列
// ---------------------------------------------------------------------------

const MOOD_MD = `# 期末文法核心

## 快速判斷表（考前 30 秒語氣總表，PDF §5）

| 語氣 | 連接詞 / 結構 |
| --- | --- |
| **Indicatif** | quand, après que, si(讓步), selon que…ou |
| **Subjonctif** | bien que, soit que…, si/quelque/pour + adj + que, quel(le)(s) que |
| **Conditionnel** | au cas où |
| **Imparfait / plus-que-parfait** | comme si |
| **Indicatif 或 subjonctif** | tout + adj + que |
| 這一列只有一欄 |

## 別的章節

| **Subjonctif** | 這張表不該被讀進來 |
`;

const core = parseMoodTable(MOOD_MD);
const coreBy = (name) => core.find((c) => c.connector === name);

test('權威表：連接詞欄只用逗號拆，帶斜線的結構不能被拆開', () => {
  // `si/quelque/pour + adj + que` 是一個條目，不是三個。
  assert.ok(coreBy('si/quelque/pour + adj + que'));
  assert.equal(coreBy('si/quelque/pour + adj + que').mood, 'subjonctif');
  assert.equal(coreBy('si').mood, 'indicatif');
  assert.equal(coreBy('si').sense, '讓步');
});

test('權威表：après que 接 indicatif（2026-09-09 使用者裁定，與權威表一致）', () => {
  assert.equal(coreBy('après que').mood, 'indicatif');
  assert.equal(coreBy('après que').ambiguous, false);
});

test('權威表：comme si 獨立成 imparfait，不併進 indicatif', () => {
  assert.equal(coreBy('comme si').mood, 'imparfait');
  assert.ok(MOOD_LABELS.imparfait);
});

test('權威表：詞尾省略號不算詞的一部分，句中的省略號要留著', () => {
  assert.ok(coreBy('soit que'));
  // selon que…ou 的省略號在中間，代表「兩個選項之間」，拆掉就不成句。
  assert.ok(coreBy('selon que…ou'));
});

test('權威表：多解記成 ambiguous，欄位不足的列跳過，讀到下一個 ## 就停', () => {
  assert.equal(coreBy('tout + adj + que').ambiguous, true);
  assert.deepEqual(coreBy('tout + adj + que').moods, ['subjonctif', 'indicatif']);
  assert.equal(coreBy('這一列只有一欄'), undefined);
  assert.equal(coreBy('這張表不該被讀進來'), undefined);
  assert.equal(core.length, 11);
});

test('權威表：找不到判斷表時回空陣列，不猜', () => {
  assert.deepEqual(parseMoodTable('# 筆記\n\n沒有那張表。'), []);
});

test('合併：語氣採權威表，中文與功能由輔助表補', () => {
  const merged = mergeConnectors(core, parsed);
  const byName2 = (n) => merged.find((c) => c.connector === n);
  // 輔助表把 tout + adj + que 記成「可接 indicatif」的單解，權威表記成兩種都行。
  // 語氣以權威表為準。
  assert.deepEqual(byName2('tout + adj + que').moods, ['subjonctif', 'indicatif']);
  assert.equal(byName2('quand').zh, '當 / 在…的時候');
  // 詞形標記寫法不同的同一個詞要對得上。
  assert.equal(byName2('quel(le)(s) que').mood, 'subjonctif');
});

test('合併：權威表沒收的條目從輔助表整條帶進來，不憑空補語氣', () => {
  const merged = mergeConnectors(core, parsed);
  const beau = merged.find((c) => c.connector === 'avoir beau');
  assert.equal(beau.mood, 'infinitif');
  assert.equal(beau.fromAux, true);
  assert.ok(merged.find((c) => c.connector === 'en cas de').fromAux);
});

test('合併：權威表解析失敗就整個回空，不退回只用輔助表', () => {
  // 半套資料比沒有資料更難發現，寧可讓 build 報「連接詞 0 筆」。
  assert.deepEqual(mergeConnectors([], parsed), []);
});

// ---------------------------------------------------------------------------
// 補釋義表（connector-gloss.mjs）：權威表獨有的那些條目，中文在 vault 裡不存在
// ---------------------------------------------------------------------------

test('補釋義：權威表獨有的條目補得到功能與中文，並標記來源', () => {
  const merged = mergeConnectors(core, parsed);
  const by = (n) => merged.find((c) => c.connector === n);
  // 這幾個只在權威表上，輔助表沒收，中文只能來自 connector-gloss.mjs。
  assert.equal(by('comme si').zh, '好像／彷彿');
  assert.equal(by('comme si').fn, '比較');
  assert.equal(by('comme si').glossedHere, true);
  assert.equal(by('après que').zh, '在…之後');
  assert.equal(by('si').fn, '對立讓步');
  // 權威表的 si 是讓步的那個，補的中文必須講明不是「如果」，
  // 否則這張卡等於在教錯的東西。
  assert.match(by('si').zh, /讓步/);
});

test('補釋義：輔助表有中文時不被蓋掉，只填空', () => {
  // 模擬「vault 之後補收了 comme si」：輔助表一旦有中文，補釋義表就該讓位。
  // 反過來的話，vault 改了中文這邊會靜靜地蓋回舊的。
  const auxMd = CONNECTOR_MD.replace(
    '| au cas où | 條件 | **conditionnel** | 萬一 |',
    // 這裡刻意寫 indicatif：輔助表的解析器沒有 imparfait 這個 pattern
    // （vault 那張表沒有這種列），而且語氣本來就該由權威表決定，正好一起驗。
    '| au cas où | 條件 | **conditionnel** | 萬一 |\n| comme si | 比較 | **indicatif** | 輔助表寫的中文 |',
  );
  const merged = mergeConnectors(core, parseConnectors(auxMd));
  const comme = merged.find((c) => c.connector === 'comme si');
  assert.equal(comme.zh, '輔助表寫的中文');
  assert.equal(comme.glossedHere, false);
  // 語氣仍然採權威表，不因為輔助表也收了就改。
  assert.equal(comme.mood, 'imparfait');
});

test('補釋義：每一列的功能與中文都不得是空的', () => {
  const rows = Object.entries(CONNECTOR_GLOSS);
  assert.ok(rows.length > 0);
  for (const [k, v] of rows) {
    assert.ok(v.fn && v.fn.trim(), `${k} 沒有功能`);
    assert.ok(v.zh && v.zh.trim(), `${k} 沒有中文`);
    assert.equal(k, k.trim(), `${k} 前後有空白，正規化之後會對不上`);
  }
});

test('補釋義：功能欄沿用輔助表那一套用詞，不自立新分類', () => {
  // 同一副牌裡一半寫「條件」一半寫「假設」會讀成兩回事。
  const known = new Set(['時間', '對立', '對立讓步', '條件', '條件·原因', '比較']);
  for (const [k, v] of Object.entries(CONNECTOR_GLOSS)) {
    assert.ok(known.has(v.fn), `${k} 的功能「${v.fn}」不在既有分類裡`);
  }
});

test('語氣標籤：中文與完整標籤同一份來源，不會各改一邊', () => {
  // MOOD_LABELS 由 MOOD_ZH 生成。兩份各寫一次的話，改了中文只有按鈕會變，
  // 別的地方仍是舊的。
  for (const [k, zh] of Object.entries(MOOD_ZH)) {
    assert.ok(MOOD_LABELS[k].startsWith(zh), `${k} 的標籤沒有以中文開頭`);
    assert.match(MOOD_LABELS[k], /[a-z]/, `${k} 的標籤沒有法文術語`);
  }
  assert.deepEqual(Object.keys(MOOD_ZH), Object.keys(MOOD_LABELS));
});
