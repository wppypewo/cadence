/**
 * 建置題庫：把散在三個地方的資料，變成一份可以直接抽卡的 data/bank/。
 *
 * 來源與去向：
 *   french-exam-generator/data  A1–B1 詞彙、2 千多筆人工中文釋義、英文定義、陰陽性
 *   vault/raw/.../flelex        B2 詞彙（FLELex 原表，fexgen 沒抽 B2）
 *   vault/raw/.../verbiste      動詞變位（GPL-2.0，只讀不收，見 README）
 *   vault/wiki/concepts/french  連接詞後接語氣
 *   lexicon/                    本 repo 自有：拼法更正、名詞性別、中文釋義覆寫、Tatoeba 例句
 *
 * 產物 data/bank/ 在 .gitignore 裡。它隨時可以重建，而且不該把別人的授權資料
 * 帶進本 repo 的歷史。真正不可重建的是 data/reviews.jsonl，那個才進版控。
 */

import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { SOURCES, exists, readJson, loadGlosses, resolveGloss, sourceFingerprint, loadFlelex, loadLexicon } from './sources.mjs';
import { loadVerbiste, conjugate, compound, PRONOUNS, IMPERATIVE_PRONOUNS, AUX_DUAL_NOTE } from './verbiste.mjs';
import { loadConnectors, MOOD_LABELS, MOOD_ZH } from './connectors.mjs';
import { CONNECTOR_GLOSS } from './connector-gloss.mjs';
import { loadPicks } from './picks.mjs';
import { loadRewrites } from './rewrites.mjs';
import { buildNominals } from './nominals.mjs';

/** 要出題的時態。passé simple 是書面語、口語考不到，先不進題庫。 */
const TENSES = [
  { key: 'pres', name: 'présent', zh: '現在式', kind: 'simple' },
  { key: 'imp', name: 'imparfait', zh: '未完成過去式', kind: 'simple' },
  { key: 'fut', name: 'futur simple', zh: '簡單未來式', kind: 'simple' },
  { key: 'cond', name: 'conditionnel présent', zh: '條件式現在', kind: 'simple' },
  { key: 'subj', name: 'subjonctif présent', zh: '虛擬式現在', kind: 'simple' },
  { key: 'pc', name: 'passé composé', zh: '複合過去式', kind: 'compound' },
];

/**
 * 規則動詞的兩個模板。aimer／finir 這兩套推得出來的動詞不進變位題庫——
 * 494 + 35 個規則動詞灌進來只會稀釋掉真正該練的 255 個。
 */
const REGULAR_TEMPLATES = new Set(['aim:er', 'fin:ir']);

const POS_ZH = { NOM: '名詞', VER: '動詞', ADJ: '形容詞', ADV: '副詞' };

/**
 * FLELex 自動抽取的雜訊：釋義以 ⚠ 開頭（大寫誤標、詞性誤判、不成詞的片段）。
 * 只看開頭：「(⚠ 亦為…)」夾在釋義中間的是正常的同形異義註記（court 名詞），那種照常出卡。
 */
const isNoisy = (gloss) => gloss.trimStart().startsWith('⚠');

/**
 * 一個詞條的中文釋義。優先序：lexicon/glosses.json（cadence 逐筆重審過的）→
 * fexgen 抓到的 Wiktionnaire zh → fexgen 人工表。
 * 看字回想、名詞化、變位三處原本各寫一次，變位那處漏了 zh 這條，
 * 結果 aller／avoir／faire 等 67 個最常用的動詞、2,382 張變位卡沒有中文（2026-09-26 實測）。
 * 人工表要用 FLELex 原拼法查（e.src）：fexgen 的鍵是 coeur 不是 cœur。
 */
function glossOf(glossTables, e, lexGlosses = {}) {
  const own = lexGlosses[`${e.word}|${e.pos}`];
  if (own) return { gloss: own, source: 'cadence' };
  if (e.zh?.length) return { gloss: e.zh.join(' / '), source: 'Wiktionnaire-fr' };
  return { gloss: resolveGloss(glossTables, e.src ?? e.word, e.pos), source: 'manual' };
}

/**
 * @param {object} lex  glosses／examples 來自 lexicon/；reviewed 是作答紀錄裡出現過的卡片 id。
 *   雜訊詞條不出卡，但作答過的那張照留——卡片消失，Store.loadBank() 會把它的排程狀態一起刪掉。
 */
function makeVocabCards(entries, glossTables, enDefs, genders, { glosses = {}, examples = {}, reviewed = new Set() } = {}) {
  const cards = [];
  // 中文釋義撞號的字要一起收：「除非」同時是 sauf si 和 à moins que 的中文，
  // 反向出題時只認一個答案就會把對的判成錯的。
  const byGloss = new Map();
  const resolved = entries.map((e) => {
    return { ...e, ...glossOf(glossTables, e, glosses) };
  });
  for (const e of resolved) {
    if (!e.gloss || isNoisy(e.gloss)) continue;
    const key = `${e.gloss}|${e.pos}`;
    if (!byGloss.has(key)) byGloss.set(key, []);
    byGloss.get(key).push(e.word);
  }

  for (const e of resolved) {
    const src = e.src ?? e.word;
    const en = (enDefs[src] ?? {})[e.pos] ?? [];
    const ex = examples[`${src}|${e.pos}`] ?? [];
    const gender = e.pos === 'NOM' ? (genders[e.word] ?? null) : null;
    const base = {
      word: e.word,
      pos: e.pos,
      posZh: POS_ZH[e.pos] ?? e.pos,
      level: e.level,
      freq: e.freq,
      gloss: e.gloss,
      glossSource: e.source,
      en,
      gender: gender?.g ?? null,
      elide: gender?.elide ?? null,
      noisy: Boolean(e.gloss) && isNoisy(e.gloss),
    };
    // 例句只在有的時候放：一萬多張卡各帶一個空陣列，cards.json 白白多幾百 KB。
    if (ex.length) base.examples = ex;
    if (!e.gloss) continue;
    const rId = `v:${e.word}|${e.pos}|r`;
    const pId = `v:${e.word}|${e.pos}|p`;

    // 認：看到法文，說得出中文。自評，因為「意思對不對」機器判不了。
    // 雜訊詞條的釋義本身就在說「這條資料不可信」，拿來當答案等於背錯的東西。
    if (!base.noisy || reviewed.has(rId)) cards.push({
      id: rId,
      kind: 'vocab-recall',
      mode: 'self',
      level: e.level,
      freq: e.freq,
      tags: ['vocab', e.level, e.pos],
      front: base,
    });

    // 寫：看到中文，拼得出法文。打字批改，重音算數。
    // 帶 ⚠ 的釋義本身就是「這條資料可疑」的標記，不拿來當題面。
    if (!base.noisy || reviewed.has(pId)) {
      const accept = [...new Set(byGloss.get(`${e.gloss}|${e.pos}`) ?? [e.word])];
      cards.push({
        id: pId,
        kind: 'vocab-produce',
        mode: 'typed',
        level: e.level,
        freq: e.freq,
        tags: ['vocab', e.level, e.pos],
        answer: e.word,
        accept,
        front: base,
      });
    }
  }
  return cards;
}

function makeConjCards(verbEntries, verbs, templates) {
  const cards = [];
  const tables = {};
  const auxTables = {
    'avoir': conjugate('avoir', verbs, templates),
    'être': conjugate('être', verbs, templates),
  };

  for (const entry of verbEntries) {
    const data = conjugate(entry.word, verbs, templates);
    if (!data) continue;
    const comp = compound(data, auxTables);
    tables[entry.word] = {
      template: data.template,
      aux: data.aux,
      auxDual: data.auxDual,
      impersonal: data.impersonal,
      level: entry.level,
      freq: entry.freq,
      gloss: entry.gloss ?? '',
      simple: data.simple,
      compound: comp,
      pastParticiple: data.pastParticiple.find((f) => f) ?? '',
      presentParticiple: data.presentParticiple.find((f) => f) ?? '',
    };
    if (REGULAR_TEMPLATES.has(data.template)) continue;

    for (const tense of TENSES) {
      const forms = tense.kind === 'simple' ? data.simple[tense.name] : comp[tense.name];
      if (!forms) continue;
      for (let i = 0; i < PRONOUNS.length; i += 1) {
        // 無人稱動詞（falloir／pleuvoir）只有第三人稱單數，其餘人稱不出題。
        if (data.impersonal && i !== 2) continue;
        const form = forms[i];
        if (!form) continue;
        // 一格有兩套正規形式（paie ／ paye）時兩個都算對。
        const accept = form.split(' ／ ').map((s) => s.trim()).filter(Boolean);
        cards.push({
          id: `c:${entry.word}|${tense.key}|${i}`,
          kind: 'conj',
          mode: 'typed',
          level: entry.level,
          freq: entry.freq,
          tags: ['conj', entry.level, tense.key, data.template],
          answer: accept[0],
          accept,
          front: {
            verb: entry.word,
            gloss: entry.gloss ?? '',
            tense: tense.name,
            tenseZh: tense.zh,
            tenseKey: tense.key,
            pronoun: PRONOUNS[i],
            person: i,
            template: data.template,
            aux: tense.kind === 'compound' ? data.aux : null,
            note: tense.kind === 'compound' && data.auxDual ? AUX_DUAL_NOTE : '',
          },
        });
      }
    }
  }
  return { cards, tables };
}

function makeConnectorCards(connectors) {
  const options = Object.keys(MOOD_LABELS);
  return connectors
    .filter((c) => !c.ambiguous)
    .map((c) => ({
      id: `k:${c.connector}`,
      kind: 'connector',
      mode: 'choice',
      level: 'B1',
      freq: 0,
      tags: ['connector', c.mood],
      answer: c.mood,
      accept: [c.mood],
      front: {
        connector: c.connector,
        zh: c.zh,
        fn: c.fn,
        sense: c.sense,
        moodRaw: c.moodRaw,
        // 選項一定要放在 front 裡。前端的 choiceAnswer() 只讀 `card.front.options`，
        // 挑連接詞卡也是這樣放。2026-09-10 實測：這裡原本放在卡片頂層，
        // 結果 50 張連接詞卡在複習頁只有題面、一顆選項按鈕都沒有，等於不能作答。
        // 兩個位置各放一份不是解法——那只是把下一次分岔藏起來。
        options,
        // 選項的中文。按鈕上只有法文術語時，`imparfait` 與 `conditionnel`
        // 對還沒背熟術語的人是兩個看不懂的字，等於在考術語不是考語感。
        optionZh: MOOD_ZH,
      },
    }));
}

/**
 * 方框挑連接詞（考卷第 II 大題）。
 *
 * 打字作答而不是點選項：考卷是填進句子裡的，該省的音要跟著寫，
 * 性數也要配好。點按鈕會把這兩個考點整個抹掉。
 * 方框仍然印在題面上，那是這一大題的形式——考的是在六個選項裡認出哪一個。
 */
function makePickCards(items) {
  return items.map((it) => ({
    id: it.id,
    kind: 'pick',
    mode: 'typed',
    level: 'B1',
    freq: 0,
    tags: ['pick', `${it.sec}${it.group}`],
    answer: it.answer,
    // 省音與性數是考點，不收其他寫法當同義答案。
    accept: [it.answer],
    front: {
      prompt: it.prompt,
      options: it.options,
      group: it.group,
      sec: it.sec,
      src: it.src,
    },
    note: it.why,
  }));
}

/**
 * 用指定連接詞改寫整句（考卷第 III 大題，18%）。
 *
 * 沒有 accept：整句沒有唯一解，`Si agréable qu'il soit` 與 `Si agréable soit-il`
 * 都對。批改只查必要要素，其餘交給自評，所以不做字串比對。
 * `must` 放在卡片頂層而非 front，因為它含答案片段，出題時要跟 answer 一起拿掉。
 */
function makeRewriteCards(items) {
  return items.map((it) => ({
    id: it.id,
    kind: 'rw',
    mode: 'rewrite',
    level: 'B1',
    freq: 0,
    tags: ['rw', `rw${it.sec}`],
    answer: it.answer,
    accept: null,
    must: it.must,
    front: {
      prompt: it.prompt,
      tool: it.tool,
      sec: it.sec,
      num: it.num,
      src: it.src,
    },
    note: it.why,
  }));
}

/**
 * 名詞化（考卷第 IV 大題，14%）。
 *
 * 只問「哪個名詞、配哪個冠詞」，不問整句框架——後者沒有唯一解，留在 rw 的自評。
 * 打字作答而不是二選一點 le／la：考卷是寫出來的，名詞本身拼錯照樣沒分。
 * `noun` 放在卡片頂層而非 front，因為它就是答案的一半，出題時要跟 answer 一起拿掉。
 *
 * 題面帶基詞的中文釋義：規則挖出來的配對不保證語意貼合（見 nominals.mjs 的排除清單），
 * 釋義擺在眼前，配對有問題當場就看得出來，不必先相信建置腳本。
 */
function makeNomCards(items, entries, glossTables, lexGlosses = {}) {
  const byKey = new Map();
  for (const e of entries) byKey.set(`${e.word}|${e.pos}`, e);
  return items.map((it) => {
    const e = byKey.get(`${it.base}|${it.pos}`);
    const { gloss } = glossOf(glossTables, e ?? { word: it.base, pos: it.pos }, lexGlosses);
    return {
      id: `n:${it.base}|${it.pos}`,
      kind: 'nom',
      mode: 'typed',
      // 考卷組的基詞不一定在詞表裡（tomber en panne），沒查到就當 B1——這一大題本來就是 B1 的題。
      level: e?.level ?? 'B1',
      freq: e?.freq ?? 0,
      tags: ['nom', it.src === '[推論]' ? 'nomRule' : 'nomIV'],
      answer: it.answer,
      accept: it.answers,
      noun: it.noun,
      // 不放 gender：陰陽性正是這題要考的，送到前端等於把一半答案印在題面上。
      front: {
        base: it.base,
        pos: it.pos,
        posZh: POS_ZH[it.pos] ?? it.pos,
        gloss,
        src: it.src,
      },
    };
  });
}

/**
 * A1–B1 的 fexgen 詞表加上 FLELex 的 B2，再套 lexicon/spelling.json 的拼法更正。
 *
 * 拼法更正之後才去重：FLELex 同時收了 oeuvre 與 œuvre 的話，會變成兩個一樣的鍵。
 * 同鍵留先出現的那筆，也就是等級低的那筆——fexgen 在前、B2 在後。
 * `src` 留著 FLELex 原拼法，查 fexgen 的人工釋義、英文定義與例句都用它。
 */
function mergeEntries(fexEntries, b2, spelling = {}) {
  const out = [];
  const seen = new Set();
  for (const e of [...fexEntries, ...b2]) {
    const word = spelling[e.word] ?? e.word;
    const key = `${word}|${e.pos}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...e, src: e.word, word });
  }
  return out;
}

/** 作答紀錄裡出現過的卡片 id。檔案不存在（新機器）就是空集合；壞行略過，那不是建置該管的事。 */
async function reviewedCardIds(file) {
  const ids = new Set();
  if (!(await exists(file))) return ids;
  for (const line of (await readFile(file, 'utf8')).split('\n')) {
    if (!line.trim()) continue;
    try {
      const card = JSON.parse(line).card;
      if (card) ids.add(card);
    } catch { /* 略過 */ }
  }
  return ids;
}

function countBy(items, keyOf) {
  const out = {};
  for (const it of items) out[keyOf(it)] = (out[keyOf(it)] ?? 0) + 1;
  return out;
}

/**
 * 跑一次完整建置。
 * @param {string} outDir data/bank 的絕對路徑
 * @param {(msg:string)=>void} log
 */
export async function build(outDir, log = () => {}) {
  const report = { ok: true, missing: [], counts: {} };

  for (const [name, dir] of Object.entries(SOURCES)) {
    if (!(await exists(dir))) {
      report.ok = false;
      report.missing.push({ name, dir });
    }
  }
  if (!report.ok) return report;

  log('讀取詞彙與人工釋義…');
  const files = await readdir(SOURCES.fexgen);
  const glossTables = await loadGlosses(SOURCES.fexgen, files.filter((f) => /^gloss_.*\.json$/.test(f)));
  const [a1a2, b1, enDefs, fexGenders, b2, lex, reviewed] = await Promise.all([
    readJson(path.join(SOURCES.fexgen, 'vocab_a1a2.json')),
    readJson(path.join(SOURCES.fexgen, 'vocab_b1.json')),
    readJson(path.join(SOURCES.fexgen, 'en_defs.json')),
    readJson(path.join(SOURCES.fexgen, 'genders.json')),
    loadFlelex(SOURCES.flelex, ['B2']),
    loadLexicon(),
    reviewedCardIds(path.join(path.dirname(outDir), 'reviews.jsonl')),
  ]);
  const fexEntries = [...a1a2, ...b1];
  const entries = mergeEntries(fexEntries, b2, lex.spelling);
  // fexgen 那 92 筆與 lexicon 的 4,700 多筆都來自 Wiktionnaire，建 lexicon 時比對過 0 不一致；
  // 仍讓 fexgen 蓋過去，它是人看過的那一份。
  const genders = { ...lex.genders };
  for (const [w, g] of Object.entries(fexGenders)) genders[lex.spelling[w] ?? w] = g;
  const vocabCards = makeVocabCards(entries, glossTables, enDefs, genders, {
    glosses: lex.glosses, examples: lex.examples, reviewed,
  });

  log('讀取 Verbiste 變位資料…');
  const { verbs, templates } = await loadVerbiste(SOURCES.verbiste);
  const verbEntries = entries
    .filter((e) => e.pos === 'VER')
    .map((e) => ({ ...e, gloss: glossOf(glossTables, e, lex.glosses).gloss }));
  const { cards: conjCards, tables } = makeConjCards(verbEntries, verbs, templates);

  log('讀取連接詞判斷表…');
  const connectors = await loadConnectors(SOURCES.vault);
  const connCards = makeConnectorCards(connectors);
  // 兩件事各報一次。缺中文的張數應該是 0；補釋義表用到的列數少於它收的列數，
  // 代表 vault 那張表已經補了同一個連接詞——那一列在 connector-gloss.mjs 裡
  // 就是死的，該刪。這裡只講，不自動刪：刪哪一列是人的判斷。
  const noZh = connCards.filter((c) => !c.front.zh);
  if (noZh.length) log(`  ⚠ 連接詞缺中文 ${noZh.length} 張：${noZh.map((c) => c.front.connector).join('、')}`);
  const deadGloss = Object.keys(CONNECTOR_GLOSS).filter(
    (k) => !connectors.some((c) => c.connector === k && c.glossedHere),
  );
  if (deadGloss.length) log(`  ⚠ connector-gloss.mjs 有 ${deadGloss.length} 列沒被用到，可以刪：${deadGloss.join('、')}`);

  log('讀取方框挑連接詞題庫…');
  const picks = await loadPicks(SOURCES.packs);
  const pickCards = makePickCards(picks);

  log('讀取改寫題庫…');
  const rewrites = await loadRewrites(SOURCES.packs);
  const rwCards = makeRewriteCards(rewrites);

  log('推導名詞化配對…');
  // 名詞化只吃 fexgen 的詞表與 92 筆性別：nominals.mjs 是 fexgen nominalize.py 的副本，
  // 漂移測試拿同一份輸入比對兩邊，輸入換了就比不回去。
  // 2026-09-26 實測改吃 lexicon 的 4,706 筆性別，配對數一樣是 92、一組都沒多——fexgen 那份本來就是為這些名詞抓的。
  const nominals = buildNominals(fexEntries, fexGenders);
  const nomCards = makeNomCards(nominals, fexEntries, glossTables, lex.glosses);

  const cards = [...vocabCards, ...conjCards, ...connCards, ...pickCards, ...rwCards, ...nomCards];
  const seen = new Set();
  for (const c of cards) {
    if (seen.has(c.id)) throw new Error(`卡片 id 重複：${c.id}`);
    seen.add(c.id);
  }

  const meta = {
    builtAt: new Date().toISOString(),
    sources: SOURCES,
    sourceFingerprint: await sourceFingerprint(),
    counts: {
      cards: cards.length,
      vocabRecall: vocabCards.filter((c) => c.kind === 'vocab-recall').length,
      vocabProduce: vocabCards.filter((c) => c.kind === 'vocab-produce').length,
      conj: conjCards.length,
      connector: connCards.length,
      pick: pickCards.length,
      rw: rwCards.length,
      nom: nomCards.length,
      verbTables: Object.keys(tables).length,
      vocabEntries: entries.length,
      vocabByLevel: countBy(entries, (e) => e.level),
      withExamples: vocabCards.filter((c) => c.kind === 'vocab-recall' && c.front.examples).length,
      nounsWithGender: entries.filter((e) => e.pos === 'NOM' && genders[e.word]).length,
      nouns: entries.filter((e) => e.pos === 'NOM').length,
      noisyEntries: entries.filter((e) => isNoisy(glossOf(glossTables, e, lex.glosses).gloss)).length,
    },
    notice:
      '變位資料衍生自 Verbiste（Copyright 2003-2016 Pierre Sarrazin，GPL-2.0-or-later）。'
      + '本目錄由建置腳本生成，不進版控。',
  };

  await mkdir(outDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(outDir, 'cards.json'), JSON.stringify(cards)),
    writeFile(path.join(outDir, 'verbs.json'), JSON.stringify(tables)),
    writeFile(path.join(outDir, 'connectors.json'), JSON.stringify(connectors, null, 2)),
    writeFile(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 2)),
  ]);

  report.counts = meta.counts;
  return report;
}

// make* 三支只在建置與測試中使用；匯出是為了讓卡片生成規則可以被單獨測。
export { TENSES, POS_ZH, makeVocabCards, makeConjCards, makeConnectorCards, makePickCards, makeRewriteCards, makeNomCards, mergeEntries };
