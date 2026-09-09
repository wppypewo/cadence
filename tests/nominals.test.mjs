/**
 * 名詞化（考卷第 IV 大題）的推導與批改測試。
 *
 * 這個檔案守兩件事：
 *  1. **性別絕不用猜的。** genders.json 查不到，或查不到 h 的省音性質，就不出題。
 *     冠詞是這一題型的一半分數，寧可少一張卡也不要出一張答案可能是錯的卡。
 *  2. **判定順序：重音在冠詞之前。** 否則 `la timidite` 會被說成「冠詞錯」，
 *     而使用者的冠詞其實是對的，只是沒打重音。
 *
 * 詞表用行內樣本，不讀 french-exam-generator：測的是規則，
 * 不是「今天那兩張詞表裡剛好有幾組」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { derive, mineNominals, article, buildNominals, EXCLUDE, FROM_EXAM } from '../src/build/nominals.mjs';
import { gradeNom } from '../src/engine/grade.mjs';
import { makeNomCards } from '../src/build/bank.mjs';

/** 一份最小詞表：夠測「兩端都要在表裡」與排除規則，不多不少。 */
const ENTRIES = [
  { word: 'expliquer', pos: 'VER', level: 'A2', freq: 30 },
  { word: 'explication', pos: 'NOM', level: 'B1', freq: 12 },
  { word: 'changer', pos: 'VER', level: 'A1', freq: 50 },
  { word: 'changement', pos: 'NOM', level: 'A2', freq: 20 },
  { word: 'grandir', pos: 'VER', level: 'B1', freq: 8 },
  { word: 'grandissement', pos: 'NOM', level: 'B1', freq: 2 },
  { word: 'différent', pos: 'ADJ', level: 'A2', freq: 40 },
  { word: 'différence', pos: 'NOM', level: 'A2', freq: 35 },
  { word: 'garer', pos: 'VER', level: 'B1', freq: 5 },
  { word: 'garage', pos: 'NOM', level: 'A2', freq: 9 },
  // 派生名詞不在詞表裡：規則推得出 marchement／marchage，但沒有這個詞。
  { word: 'marcher', pos: 'VER', level: 'A1', freq: 60 },
  // 名詞在表裡但等級超出 A1–B1，兩端都要在範圍內才收。
  { word: 'nager', pos: 'VER', level: 'A1', freq: 10 },
  { word: 'nagement', pos: 'NOM', level: 'C1', freq: 1 },
];

const GENDERS = {
  explication: { g: 'f', elide: true },
  changement: { g: 'm', elide: false },
  grandissement: { g: 'm', elide: false },
  différence: { g: 'f', elide: false },
  absence: { g: 'f', elide: true },
  chaleur: { g: 'f', elide: false },
  pluie: { g: 'f', elide: false },
  panne: { g: 'f', elide: false },
  aide: { g: 'f', elide: true },
  timidité: { g: 'f', elide: false },
};

const NO_GLOSS = { plain: new Map(), bypos: new Map(), override: new Map() };

test('derive：構詞規則只產候選，成不成立由詞表決定', () => {
  // quer→cation 要排在 er→ation 前面，不然 expliquer 只會生出 explication 以外的東西。
  assert.deepEqual(derive('expliquer', 'VER'), ['explication', 'expliquation', 'expliquement', 'expliquage']);
  assert.deepEqual(derive('grandir', 'VER'), ['grandissement']);
  assert.deepEqual(derive('différent', 'ADJ'), ['différence', 'différentité', 'différentesse', 'différenteur']);
});

test('mineNominals：兩端都要在詞表裡、都要在 A1–B1', () => {
  const pairs = mineNominals(ENTRIES);
  const keys = pairs.map((p) => `${p.base}→${p.noun}`);
  assert.ok(keys.includes('expliquer→explication'));
  assert.ok(keys.includes('changer→changement'));
  assert.ok(keys.includes('grandir→grandissement'));
  assert.ok(keys.includes('différent→différence'));
  // marcher 的候選名詞根本不存在；nagement 存在但是 C1。
  assert.ok(!keys.some((k) => k.startsWith('marcher→')));
  assert.ok(!keys.some((k) => k.startsWith('nager→')));
});

test('mineNominals：EXCLUDE 的語意漂移配對挖不出來', () => {
  // garage 是車庫不是停車這個動作。規則挖得到，但出成題目是錯的。
  assert.ok(EXCLUDE.has('garer|garage'));
  assert.ok(!mineNominals(ENTRIES).some((p) => p.noun === 'garage'));
});

test('article：省音優先於陰陽性', () => {
  // l'absence 看不出陰陽性，這正是它不能拿來當「冠詞提示」的原因。
  assert.equal(article('absence', 'f', true), "l'absence");
  assert.equal(article('changement', 'm', false), 'le changement');
  assert.equal(article('différence', 'f', false), 'la différence');
});

test('buildNominals：性別或省音查不到就不出題', () => {
  // 這一題型的一半分數在冠詞上，猜一個等於出一張答案可能是錯的卡。
  const items = buildNominals(ENTRIES, { ...GENDERS, changement: { g: 'm', elide: null } });
  assert.ok(!items.some((it) => it.noun === 'changement'));
  const none = buildNominals(ENTRIES, {});
  assert.ok(!none.some((it) => it.src === '[推論]'));
});

test('buildNominals：考卷組的所有格與定冠詞兩種都算對', () => {
  const items = buildNominals(ENTRIES, GENDERS);
  const absence = items.find((it) => it.noun === 'absence');
  assert.equal(absence.src, '[教材 111-2 IV]');
  assert.deepEqual(absence.answers, ['son absence', "l'absence"]);
  // 考卷寫 la chaleur，定冠詞形一樣，不重複收。
  assert.deepEqual(items.find((it) => it.noun === 'chaleur').answers, ['la chaleur']);
});

test('buildNominals：同一個名詞只出一張，規則組贏', () => {
  // explication 兩邊都有。規則組帶得出基詞的等級與釋義，所以留規則組那筆。
  const items = buildNominals(ENTRIES, GENDERS);
  const hits = items.filter((it) => it.noun === 'explication');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].src, '[推論]');
  assert.equal(hits[0].answer, "l'explication");
});

test('FROM_EXAM：七題原封不動，這是考卷的內容不是推導結果', () => {
  assert.equal(FROM_EXAM.length, 7);
  assert.ok(FROM_EXAM.every(([, pos]) => pos === 'VER' || pos === 'ADJ'));
});

test('makeNomCards：性別不進 front，那是答案的一半', () => {
  const items = buildNominals(ENTRIES, GENDERS);
  const cards = makeNomCards(items, ENTRIES, NO_GLOSS);
  const card = cards.find((c) => c.noun === 'changement');
  assert.equal(card.kind, 'nom');
  assert.equal(card.mode, 'typed');
  assert.equal(card.front.base, 'changer');
  assert.equal(card.front.gender, undefined);
  assert.ok(!JSON.stringify(card.front).includes('"m"'));
  // noun 放頂層而不是 front：它是答案片段，出題時要跟 answer 一起被剝掉。
  assert.equal(card.noun, 'changement');
  assert.deepEqual(card.accept, ['le changement']);
});

test('makeNomCards：考卷組的基詞不在詞表裡也要能出卡', () => {
  const cards = makeNomCards(buildNominals(ENTRIES, GENDERS), ENTRIES, NO_GLOSS);
  const panne = cards.find((c) => c.noun === 'panne');
  // tomber en panne 是片語，詞表裡沒有。這一大題本來就是 B1 的題，查不到就當 B1。
  assert.equal(panne.level, 'B1');
  assert.ok(panne.tags.includes('nomIV'));
});

test('gradeNom：冠詞算分', () => {
  // 考卷上寫錯 le／la 就沒分，這裡也一樣判錯。
  assert.equal(gradeNom('le changement', ['le changement'], 'changement').correct, true);
  const r = gradeNom('la changement', ['le changement'], 'changement');
  assert.equal(r.correct, false);
  assert.equal(r.reason, 'article');
});

test('gradeNom：只寫名詞不寫冠詞，也是冠詞錯', () => {
  // 「不知道要用哪個名詞」跟「名詞對了但沒配冠詞」不是同一種錯，統計上要分得開。
  assert.equal(gradeNom('changement', ['le changement'], 'changement').reason, 'article');
});

test('gradeNom：重音排在冠詞之前', () => {
  // la timidite 的冠詞其實是對的，報成「冠詞錯」會把使用者引去改對的東西。
  const r = gradeNom('la timidite', ['la timidité'], 'timidité');
  assert.equal(r.correct, false);
  assert.equal(r.reason, 'accent');
});

test('gradeNom：省音形的最後一段要切得出名詞', () => {
  // l'absence 沒有空白，不補一個就切不出 absence，會誤報成「完全不會」。
  assert.equal(gradeNom("l'absence", ['son absence', "l'absence"], 'absence').correct, true);
  assert.equal(gradeNom("l'absence", ['son absence'], 'absence').reason, 'article');
});

test('gradeNom：名詞用錯就是 wrong，沒作答是 empty', () => {
  assert.equal(gradeNom('la construction', ['le changement'], 'changement').reason, 'wrong');
  assert.equal(gradeNom('   ', ['le changement'], 'changement').reason, 'empty');
});
