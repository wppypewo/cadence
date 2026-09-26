/**
 * 從 Tatoeba 替 A1–B2 每個實詞挑例句，寫進 lexicon/examples.json（進版控）。
 *
 *   node scripts/lexicon-tatoeba.mjs
 *
 * 需要先把五個匯出檔解壓到 lexicon/.cache/tatoeba/（下載網址見 lexicon/README.md）：
 *   fra_sentences_detailed.tsv  fra-cmn_links.tsv  fra_user_languages.tsv
 *   cmn_sentences_detailed.tsv  cmn_transcriptions.tsv
 *
 * 授權：Tatoeba 句子是 CC BY 2.0 FR，每一句都記下句號與作者，前端照著標出處。
 *
 * 比對靠詞形：名詞加複數、形容詞加陰性與複數、動詞用 Verbiste 展開全部變位。
 * Verbiste 是 GPL-2.0，但這裡只拿變位形去「找」句子，句子本身是 Tatoeba 的，
 * 寫出去的檔裡沒有任何一格變位表——跟 data/bank/ 的隔離原則不衝突。
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SOURCES, LEXICON, loadFlelex } from '../src/build/sources.mjs';
import { loadVerbiste, conjugate, VARIANT_SEP } from '../src/build/verbiste.mjs';

const DIR = path.join(LEXICON, '.cache', 'tatoeba');
const OUT = path.join(LEXICON, 'examples.json');
const PER_ENTRY = 2;

async function tsv(name) {
  const text = await readFile(path.join(DIR, name), 'utf8');
  return text.split('\n').filter(Boolean).map((l) => l.split('\t'));
}

/** 沒有認領人的孤兒句，匯出檔寫 \N。 */
const owner = (by) => (by && by !== '\\N' ? by : null);

const norm = (s) => s.toLowerCase().replace(/[’ʼ]/g, "'");
/** FLELex 把 œ 寫成 oe（coeur、boeuf），句子裡是 cœur。查表時兩邊都攤平成 oe。 */
const flat = (s) => s.replace(/œ/g, 'oe').replace(/æ/g, 'ae');

/** 形容詞陰性／複數的常見規則。多生出幾個不存在的字無害——它們只是找不到句子。 */
function adjForms(w) {
  const f = new Set([w, `${w}s`, `${w}e`, `${w}es`]);
  const add = (...xs) => xs.forEach((x) => { f.add(x); f.add(`${x}s`); });
  const rules = [
    [/eux$/, 'euse'], [/if$/, 'ive'], [/el$/, 'elle'], [/eil$/, 'eille'], [/en$/, 'enne'],
    [/on$/, 'onne'], [/et$/, 'ette'], [/er$/, 'ère'], [/eau$/, 'elle'], [/c$/, 'che'], [/c$/, 'que'],
    [/g$/, 'gue'], [/eur$/, 'euse'], [/teur$/, 'trice'], [/ou$/, 'olle'], [/eux$/, 'eille'],
  ];
  for (const [re, rep] of rules) if (re.test(w)) add(w.replace(re, rep));
  if (/al$/.test(w)) f.add(w.replace(/al$/, 'aux'));
  if (/eau$/.test(w)) f.add(`${w}x`);
  return f;
}

function nounForms(w) {
  const f = new Set([w, `${w}s`, `${w}x`]);
  if (/a[il]l?$/.test(w)) f.add(w.replace(/a(i?)l$/, 'aux'));
  return f;
}

function verbForms(w, verbs, templates) {
  const f = new Set([w]);
  // 代動詞（s'abstenir）用不帶 se 的原形查變位，比對時也只比動詞本體。
  const bare = w.replace(/^s(e |')/, '');
  f.add(bare);
  const d = conjugate(bare, verbs, templates);
  if (!d) return f;
  const all = [...Object.values(d.simple).flat(), ...d.pastParticiple, ...d.presentParticiple];
  for (const cell of all) for (const x of (cell ?? '').split(VARIANT_SEP)) if (x.trim()) f.add(x.trim());
  return f;
}

/** 句子 → 依序的詞元。l'homme 拆成 l'、homme；dit-il 拆成 dit、il，另外保留整串 dit-il 供連字號詞查詢。 */
function tokens(s) {
  const seq = [];
  const whole = [];
  for (const m of norm(s).matchAll(/[a-zà-ÿœæ]+(?:-[a-zà-ÿœæ]+)*'?/g)) {
    const parts = m[0].split('-').filter(Boolean);
    if (parts.length > 1) whole.push({ t: m[0], i: seq.length });
    seq.push(...parts);
  }
  // aujourd'hui、presqu'île：撇號在字中間的詞，拆開後要能再黏回去查。
  for (let i = 0; i + 1 < seq.length; i += 1) {
    if (seq[i].endsWith("'")) whole.push({ t: seq[i] + seq[i + 1], i });
  }
  return { seq, whole };
}

const DET = new Set(['le', 'la', "l'", 'les', 'un', 'une', 'des', 'du', 'de', "d'", 'au', 'aux', 'mon', 'ton', 'son',
  'ma', 'ta', 'sa', 'mes', 'tes', 'ses', 'notre', 'votre', 'nos', 'vos', 'leur', 'leurs', 'ce', 'cet', 'cette', 'ces',
  'quel', 'quelle', 'quels', 'quelles', 'chaque', 'plusieurs', 'aucun', 'aucune', 'quelques', 'certains', 'certaines']);
const SUBJ = new Set(['je', "j'", 'tu', 'il', 'elle', 'on', 'nous', 'vous', 'ils', 'elles', "n'", 'ne', 'se', "s'",
  'me', "m'", 'te', "t'", 'lui', 'y', 'en', 'qui', 'à', 'pour', 'sans', 'pas', 'jamais', 'rien', 'plus', 'va', 'vais',
  'peux', 'peut', 'pouvez', 'veux', 'veut', 'voulez', 'dois', 'doit', 'devez', 'faut',
  'ai', 'as', 'a', 'avons', 'avez', 'ont', 'avait', 'suis', 'es', 'est', 'sommes', 'êtes', 'sont', 'était', 'été']);
const ADJ_CTX = new Set(['est', 'sont', 'suis', 'es', 'sommes', 'êtes', 'était', 'être', 'très', 'trop', 'si', 'plus',
  'moins', 'assez', 'aussi', 'semble', 'devient', 'reste', 'bien', 'vraiment', 'tellement']);
// 介系詞另列：FLELex 只收實詞，« dans » 會被當成名詞 dan（段位）的複數，只看詞類擋不住。
const PREP = new Set(['à', 'de', 'dans', 'sur', 'sous', 'avec', 'chez', 'par', 'en', 'pour', 'sans', 'entre', 'vers',
  'près', 'après', 'avant', 'depuis', 'pendant', 'contre', 'comme', 'et', 'ou', 'mais', 'que', 'qui']);

/**
 * 詞形同時屬於好幾個詞類時（marche 名詞／marcher 變位、ferme 形容詞／fermer 變位），
 * 看前一兩個字決定這句用的是哪一個。規則粗，但錯殺只是少一句例句，
 * 放過去卻會在「名詞 la marche」的卡背印出「Un garçon marche」——那是在教錯的東西。
 */
function fits(pos, seq, i, posOf, formPos) {
  const [p2, p1, n1] = [seq[i - 2], seq[i - 1], seq[i + 1]];
  const is = (t, want) => t !== undefined && posOf(t).has(want);
  // 限定詞＋形容詞＋名詞（la petite marche）要中間那個字真的可能是形容詞；
  // 否則「Un garçon marche」會因為 un 在兩格前而被當成名詞。
  if (pos === 'NOM') return DET.has(p1) || (DET.has(p2) && is(p1, 'ADJ') && !SUBJ.has(p1));
  if (pos === 'VER') return SUBJ.has(p1);
  // 形容詞：系動詞／程度副詞之後、名詞之後、或限定詞與名詞之間。
  // 後面緊接冠詞多半是及物動詞（« ferme la porte »）；限定詞後的字若接的是系動詞，
  // 它自己才是名詞（« sa ferme est »——est 也是 FLELex 的名詞「東方」，不能只看詞類）。
  if (pos === 'ADJ') {
    if (DET.has(n1)) return false;
    // 「名詞＋形容詞」在詞形也是變位時不採信：« la boutique ferme à 7 heures » 的 ferme 是動詞。
    return ADJ_CTX.has(p1) || (is(p1, 'NOM') && DET.has(p2) && !formPos.has('VER'))
      || (DET.has(p1) && is(n1, 'NOM') && !PREP.has(n1) && !ADJ_CTX.has(n1) && !SUBJ.has(n1));
  }
  return !DET.has(p1);
}

async function main() {
  const rows = await loadFlelex(SOURCES.flelex, ['A1', 'A2', 'B1', 'B2']);
  const { verbs, templates } = await loadVerbiste(SOURCES.verbiste);

  // 詞形 → 條目。FLELex 沒有多字條目（2026-09-26 實測 0 筆），只處理單字與連字號詞。
  const byForm = new Map();
  for (const r of rows) {
    const key = `${r.word}|${r.pos}`;
    const w = flat(norm(r.word));
    const forms = r.pos === 'NOM' ? nounForms(w)
      : r.pos === 'ADJ' ? adjForms(w)
        : r.pos === 'VER' ? verbForms(w, verbs, templates)
          : new Set([w]);
    for (const f of forms) {
      if (!byForm.has(f)) byForm.set(f, new Set());
      byForm.get(f).add(key);
    }
  }
  const posSets = new Map([...byForm].map(([f, keys]) => [f, new Set([...keys].map((k) => k.split('|')[1]))]));
  const none = new Set();
  const posOf = (t) => posSets.get(flat(t)) ?? none;

  const native = new Set((await tsv('fra_user_languages.tsv')).filter((c) => c[1] === '5').map((c) => c[2]));
  const cmn = new Map((await tsv('cmn_sentences_detailed.tsv')).map((c) => [c[0], { text: c[2], by: c[3] }]));
  // 簡體句子 Tatoeba 自動生了一份繁體轉寫（Hant）；原本就是繁體的句子沒有這份，用原文。
  const hant = new Map((await tsv('cmn_transcriptions.tsv')).filter((c) => c[2] === 'Hant').map((c) => [c[0], c[4]]));
  const links = new Map();
  for (const [fr, zh] of await tsv('fra-cmn_links.tsv')) {
    if (!cmn.has(zh)) continue;
    if (!links.has(fr)) links.set(fr, []);
    links.get(fr).push(zh);
  }

  const cands = new Map();
  let scanned = 0;
  for (const [id, , text, by] of await tsv('fra_sentences_detailed.tsv')) {
    const words = text.split(/\s+/).length;
    // 太短沒有上下文，太長在卡背上讀不完。
    if (words < 4 || words > 14 || text.length > 110) continue;
    if (!/[.!?…]$/.test(text.trim())) continue;
    scanned += 1;
    const { seq, whole } = tokens(text);
    const hits = new Map();
    const look = (surface, i) => {
      const f = flat(surface);
      const keys = byForm.get(f);
      if (!keys) return;
      const ambiguous = posSets.get(f).size > 1;
      for (const key of keys) {
        if (hits.has(key)) continue;
        if (ambiguous && !fits(key.split('|')[1], seq, i, posOf, posSets.get(f))) continue;
        hits.set(key, { hit: surface, ambiguous });
      }
    };
    whole.forEach(({ t, i }) => look(t, i));
    seq.forEach((t, i) => look(t, i));
    if (!hits.size) continue;
    const zhIds = links.get(id) ?? [];
    let score = 0;
    if (zhIds.length) score += 4;
    if (native.has(by)) score += 2;
    score -= Math.abs(words - 8) * 0.25;
    for (const [key, { hit, ambiguous }] of hits) {
      const s = score - (ambiguous ? 1 : 0);
      if (!cands.has(key)) cands.set(key, []);
      const list = cands.get(key);
      list.push({ s, id, text, by, zhIds, hit });
      // 只留前 12 名，避免 être／avoir 這種高頻字把記憶體撐爆。
      if (list.length > 24) { list.sort((a, b) => b.s - a.s); list.length = 12; }
    }
  }

  const out = {};
  const stat = {};
  for (const r of rows) {
    const key = `${r.word}|${r.pos}`;
    const st = (stat[r.level] ??= { entries: 0, withExample: 0, withZh: 0 });
    st.entries += 1;
    const list = (cands.get(key) ?? []).sort((a, b) => b.s - a.s || a.text.length - b.text.length);
    const picked = [];
    const seen = new Set();
    for (const c of list) {
      if (picked.length >= PER_ENTRY) break;
      if (seen.has(c.text)) continue;
      seen.add(c.text);
      const ex = { id: Number(c.id), fr: c.text, hit: c.hit, by: owner(c.by) };
      const zid = c.zhIds[0];
      if (zid) Object.assign(ex, { zh: hant.get(zid) ?? cmn.get(zid).text, zhId: Number(zid), zhBy: owner(cmn.get(zid).by) });
      picked.push(ex);
    }
    if (!picked.length) continue;
    out[key] = picked;
    st.withExample += 1;
    if (picked.some((p) => p.zh)) st.withZh += 1;
  }

  const sorted = Object.fromEntries(Object.keys(out).sort().map((k) => [k, out[k]]));
  await writeFile(OUT, `${JSON.stringify(sorted, null, 0).replace(/\],"/g, '],\n"')}\n`);
  console.log(`掃過 ${scanned} 句；寫入 ${Object.keys(out).length} 條`);
  console.log(stat);
}

main().catch((err) => { console.error(err); process.exit(1); });
