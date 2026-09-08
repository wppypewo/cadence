/**
 * Verbiste 展開測試。
 *
 * 這一層把 GPL 的原始 XML 變成題庫裡的變位表。它錯了不會當機，
 * 只會安靜地印出一個**看起來像法文、其實是錯的**形式——而使用者正是拿它來背的。
 * 所以測試盯的是三種安靜的錯：
 *   1. 詞幹切錯（模板名冒號後的長度決定切點，切錯就整張表歪掉）
 *   2. 同人稱的第二套形式被丟掉（payer 的 paye 系列，148 個模板裡有 32 個這樣）
 *   3. 該留空的地方被填上東西（缺格動詞、無人稱動詞、沒有過去分詞的複合時態）
 *
 * 主體用行內 XML，不依賴本機 vault；最後一段是對真實檔案的整合檢查，
 * 沒有 vault 就跳過（在別台機器上 clone 下來也要能跑 npm test）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  parseVerbs, parseTemplates, conjugate, compound,
  pronounFor, loadVerbiste,
  VARIANT_SEP, IMPERATIVE_PRONOUNS, PRONOUNS, IMPERSONAL, AUX_ETRE, AUX_DUAL_NOTE,
} from '../src/build/verbiste.mjs';
import { SOURCES } from '../src/build/sources.mjs';

const VERBS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<verbs-fr>
  <v><i>parler</i><t>aim:er</t></v>
  <v><i>payer</i><t>pa:yer</t></v>
  <v><i>abréger</i><t>abr:éger</t></v>
  <v><i>bruire</i><t>bru:ire</t></v>
  <v><i>aller</i><t>all:er</t></v>
  <v><i>monter</i><t>aim:er</t></v>
  <v><i>pleuvoir</i><t>aim:er</t></v>
  <v><i>être</i><t>:être</t></v>
  <v><i>fantôme</i><t>tpl:inexistant</t></v>
  <v><i>sans-modèle</i></v>
  <v><t>sans:verbe</t></v>
</verbs-fr>`;

/** 只放測試會問到的時態，其餘照 Verbiste 的巢狀結構原樣擺。 */
const TEMPLATES_XML = `<?xml version="1.0" encoding="UTF-8"?>
<conjugation-fr>
  <template name="aim:er">
    <infinitive><infinitive-present><p><i>er</i></p></infinitive-present></infinitive>
    <indicative>
      <present><p><i>e</i></p><p><i>es</i></p><p><i>e</i></p><p><i>ons</i></p><p><i>ez</i></p><p><i>ent</i></p></present>
      <imperfect><p><i>ais</i></p><p><i>ais</i></p><p><i>ait</i></p><p><i>ions</i></p><p><i>iez</i></p><p><i>aient</i></p></imperfect>
      <future><p><i>erai</i></p><p><i>eras</i></p><p><i>era</i></p><p><i>erons</i></p><p><i>erez</i></p><p><i>eront</i></p></future>
      <simple-past><p><i>ai</i></p><p><i>as</i></p><p><i>a</i></p><p><i>âmes</i></p><p><i>âtes</i></p><p><i>èrent</i></p></simple-past>
    </indicative>
    <conditional><present><p><i>erais</i></p><p><i>erais</i></p><p><i>erait</i></p><p><i>erions</i></p><p><i>eriez</i></p><p><i>eraient</i></p></present></conditional>
    <subjunctive><present><p><i>e</i></p><p><i>es</i></p><p><i>e</i></p><p><i>ions</i></p><p><i>iez</i></p><p><i>ent</i></p></present></subjunctive>
    <imperative><imperative-present><p><i>e</i></p><p><i>ons</i></p><p><i>ez</i></p></imperative-present></imperative>
    <participle>
      <present-participle><p><i>ant</i></p></present-participle>
      <past-participle><p><i>é</i></p><p><i>és</i></p><p><i>ée</i></p><p><i>ées</i></p></past-participle>
    </participle>
  </template>
  <template name="pa:yer">
    <indicative><present>
      <p><i>ie</i><i>ye</i></p><p><i>ies</i><i>yes</i></p><p><i>ie</i><i>ye</i></p>
      <p><i>yons</i></p><p><i>yez</i></p><p><i>ient</i><i>yent</i></p>
    </present></indicative>
    <participle><past-participle><p><i>yé</i></p></past-participle></participle>
  </template>
  <template name="abr:éger">
    <indicative><future>
      <p><i>ègerai</i></p><p><i>ègeras</i></p><p><i>ègera</i></p>
      <p><i>ègerons</i></p><p><i>ègerez</i></p><p><i>ègeront</i></p>
    </future></indicative>
    <conditional><present>
      <p><i>ègerais</i></p><p><i>ègerais</i></p><p><i>ègerait</i></p>
      <p><i>ègerions</i></p><p><i>ègeriez</i></p><p><i>ègeraient</i></p>
    </present></conditional>
    <subjunctive><present><p><i>ège</i></p></present></subjunctive>
  </template>
  <template name="bru:ire">
    <indicative><present>
      <p><i>is</i></p><p><i>is</i></p><p><i>it</i></p><p></p><p></p><p><i>ient</i></p>
    </present></indicative>
    <participle><past-participle><p></p></past-participle></participle>
  </template>
  <template name="all:er">
    <indicative><present><p><i>vais</i></p><p><i>vas</i></p><p><i>va</i></p><p><i>allons</i></p><p><i>allez</i></p><p><i>vont</i></p></present></indicative>
    <participle><past-participle><p><i>é</i></p></past-participle></participle>
  </template>
  <template name=":être">
    <indicative><present><p><i>suis</i></p><p><i>es</i></p><p><i>est</i></p><p><i>sommes</i></p><p><i>êtes</i></p><p><i>sont</i></p></present></indicative>
    <participle><past-participle><p><i>été</i></p></past-participle></participle>
  </template>
</conjugation-fr>`;

const verbs = parseVerbs(VERBS_XML);
const templates = parseTemplates(TEMPLATES_XML);
const conj = (v) => conjugate(v, verbs, templates);

test('parseVerbs：只收 <i> 與 <t> 都齊全的條目', () => {
  assert.equal(verbs.get('parler'), 'aim:er');
  assert.equal(verbs.get('être'), ':être');
  // 半筆資料一律不進表：寧可查不到，也不要拿 undefined 去切詞幹。
  assert.equal(verbs.has('sans-modèle'), false);
  assert.equal(verbs.size, 9);
});

test('parseTemplates：同一人稱的多套形式全部保留', () => {
  const t = templates.get('pa:yer');
  // 只取第一個 <i> 的話，這裡會是 [["ie"],["ies"],…]，變位表就會宣稱 paye 不存在。
  assert.deepEqual(t['indicative/present'], [
    ['ie', 'ye'], ['ies', 'yes'], ['ie', 'ye'], ['yons'], ['yez'], ['ient', 'yent'],
  ]);
});

test('parseTemplates：present 不會吃到 present-participle', () => {
  const t = templates.get('aim:er');
  // <present> 與 <present-participle> 開頭一樣，掃描器若用前綴比對就會混在一起。
  assert.deepEqual(t['indicative/present'].map((v) => v[0]), ['e', 'es', 'e', 'ons', 'ez', 'ent']);
  assert.deepEqual(t['participle/present-participle'], [['ant']]);
  assert.deepEqual(t['participle/past-participle'], [['é'], ['és'], ['ée'], ['ées']]);
  // imperative 群組與 imperative-present 葉節點同樣有前綴關係。
  assert.deepEqual(t['imperative/imperative-present'], [['e'], ['ons'], ['ez']]);
});

test('parseTemplates：沒有 name 屬性或標籤沒收尾的模板不會產出半套資料', () => {
  const broken = parseTemplates(`
    <template><indicative><present><p><i>x</i></p></present></indicative></template>
    <template name="cut:off"><indicative><present><p><i>y</i></p></present></indicative>
  `);
  // 沒有 name 的模板無從被引用，直接跳過；
  // 有 name 但 </template> 缺失的，掃描器掃不到收尾就整塊放棄，不會留下半套時態。
  assert.equal(broken.size, 0);
  assert.equal(broken.has('cut:off'), false);
});

test('conjugate：詞幹切點取自模板名冒號後的長度', () => {
  const parler = conj('parler');
  assert.equal(parler.stem, 'parl'); // parler 去掉 "er"
  assert.equal(parler.template, 'aim:er');
  assert.deepEqual(parler.simple['présent'], ['parle', 'parles', 'parle', 'parlons', 'parlez', 'parlent']);
  assert.deepEqual(parler.simple['passé simple'], ['parlai', 'parlas', 'parla', 'parlâmes', 'parlâtes', 'parlèrent']);
  assert.deepEqual(parler.simple['impératif'], ['parle', 'parlons', 'parlez']);
  assert.deepEqual(parler.presentParticiple, ['parlant']);
  assert.deepEqual(parler.pastParticiple, ['parlé', 'parlés', 'parlée', 'parlées']);
});

test('conjugate：模板名冒號在最前面時詞幹為空，整個形式由模板提供', () => {
  const etre = conj('être');
  assert.equal(etre.stem, '');
  assert.deepEqual(etre.simple['présent'], ['suis', 'es', 'est', 'sommes', 'êtes', 'sont']);
});

test('conjugate：查無動詞或查無模板都回 null', () => {
  assert.equal(conj('nexistepas'), null);
  // 動詞表指向一個不存在的模板——這種資料不一致要當作查無，不能半途組出東西。
  assert.equal(conj('fantôme'), null);
});

test('conjugate：多套形式用 VARIANT_SEP 併成一格', () => {
  const payer = conj('payer');
  assert.equal(VARIANT_SEP, ' ／ ');
  assert.deepEqual(payer.simple['présent'], [
    'paie ／ paye', 'paies ／ payes', 'paie ／ paye', 'payons', 'payez', 'paient ／ payent',
  ]);
});

test('conjugate：缺格的人稱留空字串，缺格的時態留空陣列', () => {
  const bruire = conj('bruire');
  // <p></p> 代表這個人稱沒有形式。填成 "bru" 或 "undefined" 都是憑空造字。
  assert.deepEqual(bruire.simple['présent'], ['bruis', 'bruis', 'bruit', '', '', 'bruient']);
  assert.deepEqual(bruire.simple['imparfait'], []);
  assert.deepEqual(bruire.pastParticiple, ['']);
});

test('conjugate：abr:éger 的傳統 é 形式被補回，且排在 1990 正字法的 è 之前', () => {
  const ab = conj('abréger');
  assert.deepEqual(ab.simple['futur simple'], [
    'abrégerai ／ abrègerai', 'abrégeras ／ abrègeras', 'abrégera ／ abrègera',
    'abrégerons ／ abrègerons', 'abrégerez ／ abrègerez', 'abrégeront ／ abrègeront',
  ]);
  assert.equal(ab.simple['conditionnel présent'][0], 'abrégerais ／ abrègerais');
  // 補正只掛在這兩個時態上，其餘時態不能被順手改掉。
  assert.deepEqual(ab.simple['subjonctif présent'], ['abrège']);
  // 別的模板同樣不受影響：payer 的 è 不存在，也不該被生出來。
  assert.equal(conj('payer').simple['présent'][0], 'paie ／ paye');
});

test('conjugate：助動詞、雙助動詞、無人稱三個旗標', () => {
  assert.equal(conj('aller').aux, 'être');
  assert.equal(conj('parler').aux, 'avoir');
  assert.equal(conj('aller').auxDual, false);
  // monter 兩種助動詞都對，卡片上要掛註記，不能讓人以為只有一種答案。
  assert.equal(conj('monter').aux, 'être');
  assert.equal(conj('monter').auxDual, true);
  assert.ok(AUX_DUAL_NOTE.includes('avoir') && AUX_DUAL_NOTE.includes('être'));
  assert.equal(conj('pleuvoir').impersonal, true);
  assert.equal(conj('parler').impersonal, false);
  assert.deepEqual([...IMPERSONAL], ['falloir', 'pleuvoir']);
  assert.equal(AUX_ETRE.has('naître'), true);
  assert.equal(AUX_ETRE.size, 15);
});

const AUX_TABLES = {
  avoir: { simple: {
    'présent': ['ai', 'as', 'a', 'avons', 'avez', 'ont'],
    'imparfait': ['avais', 'avais', 'avait', 'avions', 'aviez', 'avaient'],
    'futur simple': ['aurai', 'auras', 'aura', 'aurons', 'aurez', 'auront'],
    'conditionnel présent': ['aurais', 'aurais', 'aurait', 'aurions', 'auriez', 'auraient'],
    'subjonctif présent': ['aie', 'aies', 'ait', 'ayons', 'ayez', 'aient'],
  } },
  'être': { simple: {
    'présent': ['suis', 'es', 'est', 'sommes', 'êtes', 'sont'],
    'imparfait': ['étais', 'étais', 'était', 'étions', 'étiez', 'étaient'],
    'futur simple': ['serai', 'seras', 'sera', 'serons', 'serez', 'seront'],
    'conditionnel présent': ['serais', 'serais', 'serait', 'serions', 'seriez', 'seraient'],
    'subjonctif présent': ['sois', 'sois', 'soit', 'soyons', 'soyez', 'soient'],
  } },
};

test('compound：五個複合時態由助動詞加過去分詞組成', () => {
  const c = compound({ aux: 'avoir', pastParticiple: ['parlé', 'parlés'] }, AUX_TABLES);
  assert.deepEqual(Object.keys(c), [
    'passé composé', 'plus-que-parfait', 'futur antérieur', 'conditionnel passé', 'subjonctif passé',
  ]);
  assert.deepEqual(c['passé composé'], ['ai parlé', 'as parlé', 'a parlé', 'avons parlé', 'avez parlé', 'ont parlé']);
  assert.equal(c['plus-que-parfait'][3], 'avions parlé');
  assert.equal(c['subjonctif passé'][5], 'aient parlé');
  // 過去分詞取第一個非空的（陽性單數），不做主詞配合。
  assert.equal(c['futur antérieur'][0], 'aurai parlé');
});

test('compound：être 系動詞走另一張助動詞表', () => {
  const c = compound({ aux: 'être', pastParticiple: ['allé'] }, AUX_TABLES);
  assert.equal(c['passé composé'][0], 'suis allé');
  assert.equal(c['conditionnel passé'][2], 'serait allé');
});

test('compound：沒有過去分詞時整個複合時態留空，不生出「ai 」', () => {
  const c = compound({ aux: 'avoir', pastParticiple: [''] }, AUX_TABLES);
  for (const forms of Object.values(c)) {
    assert.deepEqual(forms, ['', '', '', '', '', '']);
  }
  // 過去分詞陣列本身是空的（缺格動詞）也一樣。
  const none = compound({ aux: 'avoir', pastParticiple: [] }, AUX_TABLES);
  assert.deepEqual(none['passé composé'], ['', '', '', '', '', '']);
});

test('compound：助動詞缺某個人稱時，那一格跟著留空', () => {
  const holed = { avoir: { simple: {
    'présent': ['ai', '', 'a', 'avons', 'avez', 'ont'],
    'imparfait': [],
    'futur simple': [], 'conditionnel présent': [], 'subjonctif présent': [],
  } } };
  const c = compound({ aux: 'avoir', pastParticiple: ['bu'] }, holed);
  assert.deepEqual(c['passé composé'], ['ai bu', '', 'a bu', 'avons bu', 'avez bu', 'ont bu']);
  assert.deepEqual(c['plus-que-parfait'], []);
});

test('人稱代名詞：六格陳述式、三格命令式', () => {
  assert.deepEqual(PRONOUNS, ['je', 'tu', 'il', 'nous', 'vous', 'ils']);
  assert.equal(pronounFor(0), 'je');
  assert.equal(pronounFor(5), 'ils');
  assert.equal(pronounFor(6), undefined);
  assert.deepEqual(IMPERATIVE_PRONOUNS, ['tu', 'nous', 'vous']);
});

// ---- 對真實 Verbiste 檔案的整合檢查 ----
// 這些檔案是 GPL-2.0，不在本 repo 內。沒有 vault 就跳過，clone 下來仍然 npm test 全綠。
const hasVault = existsSync(path.join(SOURCES.verbiste, 'verbs-fr.xml'))
  && existsSync(path.join(SOURCES.verbiste, 'conjugation-fr.xml'));

test('真實 Verbiste 資料：常見動詞展開後與字典一致', { skip: hasVault ? false : '本機沒有 Verbiste 原始檔' }, async () => {
  const real = await loadVerbiste(SOURCES.verbiste);
  assert.ok(real.verbs.size > 6000, `動詞數只有 ${real.verbs.size}，原始檔可能被截斷`);
  assert.ok(real.templates.size > 100, `模板數只有 ${real.templates.size}`);

  const c = (v) => conjugate(v, real.verbs, real.templates);
  assert.deepEqual(c('être').simple['présent'], ['suis', 'es', 'est', 'sommes', 'êtes', 'sont']);
  assert.deepEqual(c('avoir').simple['présent'], ['ai', 'as', 'a', 'avons', 'avez', 'ont']);
  assert.deepEqual(c('aller').simple['présent'], ['vais', 'vas', 'va', 'allons', 'allez', 'vont']);
  assert.equal(c('faire').simple['présent'][4], 'faites');
  assert.equal(c('prendre').simple['présent'][5], 'prennent');
  // 不規則簡單過去式最容易在詞幹切點上出錯。
  assert.equal(c('venir').simple['passé simple'][0], 'vins');
  // 虛擬式現在的 nous／vous 常被誤植成陳述式。
  assert.equal(c('savoir').simple['subjonctif présent'][3], 'sachions');

  // 兩套正規形式在真實資料裡確實存在，不是我在測試裡自己造的情形。
  assert.ok(c('payer').simple['présent'][0].includes(VARIANT_SEP));
  assert.equal(c('abréger').simple['futur simple'][0], 'abrégerai ／ abrègerai');

  // 無人稱動詞只有第三人稱單數有內容。
  const pleuvoir = c('pleuvoir');
  assert.equal(pleuvoir.impersonal, true);
  assert.equal(pleuvoir.simple['présent'][2], 'pleut');
  assert.equal(pleuvoir.simple['présent'][0], '');

  // 全表掃一遍：不該有任何形式含有 undefined 或前後空白。
  let checked = 0;
  for (const verb of real.verbs.keys()) {
    const data = c(verb);
    if (!data) continue;
    for (const forms of Object.values(data.simple)) {
      for (const f of forms) {
        assert.equal(typeof f, 'string');
        assert.ok(!f.includes('undefined'), `${verb} 產出含 undefined：${f}`);
        assert.equal(f, f.trim(), `${verb} 產出頭尾有空白：「${f}」`);
      }
    }
    checked += 1;
  }
  assert.ok(checked > 6000, `只成功展開 ${checked} 個動詞`);
});
