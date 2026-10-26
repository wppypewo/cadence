/**
 * 從 fr.wiktionary 抓 A1–B2 全部實詞的法文段落，存進 lexicon/.cache/。
 *
 *   node scripts/lexicon-wikt.mjs          抓缺的（可中斷，重跑會續抓）
 *   node scripts/lexicon-wikt.mjs --parse  只重新解析快取，不連網
 *
 * 產物兩份，都在 .cache/（不進版控）：
 *   frwikt.json   { 字: 法文段落 wikitext | null }——原文是 CC BY-SA，只當工作材料
 *   parsed.json   { 字: { NOM: { g, elide, zh[], defs[] }, ... } }
 * 真正進版控的是從 parsed.json 整理出來的 lexicon/genders.json，那一步在 lexicon-genders.mjs。
 *
 * fexgen 的 .wikt_cache.json 只存了 traductions 那一節，沒有詞首行（性別）也沒有定義，
 * 所以這裡重抓整頁的法文段落，不借用它。
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { SOURCES, LEXICON, loadFlelex, exists } from '../src/build/sources.mjs';

const CACHE = path.join(LEXICON, '.cache');
const RAW = path.join(CACHE, 'frwikt.json');
const PARSED = path.join(CACHE, 'parsed.json');
// Wikimedia 要求 User-Agent 附聯絡方式，放 repo 網址（可開 issue），不放個人信箱。
const UA = 'cadence/1.0 (personal French study tool; https://github.com/wppypewo/cadence)';
// MediaWiki 未登入時一次最多 50 個標題；間隔照 fexgen 實測不會被 429 的值。
const BATCH = 50;
const DELAY_MS = 1500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(titles) {
  const params = new URLSearchParams({
    action: 'query', format: 'json', formatversion: '2', prop: 'revisions',
    rvprop: 'content', rvslots: 'main', maxlag: '5', titles: titles.join('|'),
  });
  let wait = 5000;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const res = await fetch(`https://fr.wiktionary.org/w/api.php?${params}`, { headers: { 'User-Agent': UA } });
    if (res.ok) {
      const body = await res.json();
      // maxlag 超標時回 200 但帶 error，一樣要等。
      if (!body.error) return body;
    }
    const retry = Number(res.headers.get('retry-after'));
    await sleep(retry > 0 ? retry * 1000 : wait);
    wait = Math.min(wait * 2, 120000);
  }
  throw new Error(`連續 6 次失敗：${titles[0]}…`);
}

/** 只留 == {{langue|fr}} == 那一段；同一頁的其他語言（例如英文同形詞）不要。 */
function frenchSection(text) {
  const start = text.search(/^==\s*\{\{langue\|fr\}\}\s*==/m);
  if (start < 0) return null;
  const rest = text.slice(start);
  const next = rest.slice(2).search(/^==\s*\{\{langue\|/m);
  return next < 0 ? rest : rest.slice(0, next + 2);
}

async function fetchAll(words) {
  const raw = (await exists(RAW)) ? JSON.parse(await readFile(RAW, 'utf8')) : {};
  const todo = words.filter((w) => !(w in raw));
  console.log(`共 ${words.length} 字，快取已有 ${words.length - todo.length}，待抓 ${todo.length}`);
  for (let i = 0; i < todo.length; i += BATCH) {
    const chunk = todo.slice(i, i + BATCH);
    const body = await api(chunk);
    // API 會把標題正規化（首字大寫之類）；fr.wiktionary 對大小寫敏感，通常不會動，但還是對回去。
    const back = new Map(chunk.map((w) => [w, w]));
    for (const n of body.query?.normalized ?? []) back.set(n.to, n.from);
    for (const w of chunk) raw[w] = null;
    for (const page of body.query?.pages ?? []) {
      const word = back.get(page.title) ?? page.title;
      const text = page.revisions?.[0]?.slots?.main?.content;
      raw[word] = text ? frenchSection(text) : null;
    }
    await writeFile(RAW, JSON.stringify(raw));
    process.stdout.write(`\r  ${Math.min(i + BATCH, todo.length)}/${todo.length}`);
    await sleep(DELAY_MS);
  }
  if (todo.length) process.stdout.write('\n');
  return raw;
}

/** Wiktionnaire 的詞類標題 → FLELex 詞性。locution 類也收，FLELex 裡有 « tout à fait » 這種多字條目。 */
const SECTION_POS = [
  [/^(nom|nom commun|locution nominale)$/, 'NOM'],
  [/^(verbe|locution verbale)$/, 'VER'],
  [/^(adjectif|locution adjectivale)$/, 'ADJ'],
  [/^(adverbe|locution adverbiale)$/, 'ADV'],
];

function posOf(header) {
  // === {{S|nom|fr}} ===、{{S|adjectif|fr|num=2}}；帶 flexion 的是變化形頁段（例如 « belles »），不是詞條本身。
  const m = header.match(/\{\{S\|([^|}]+)\|fr([^}]*)\}\}/);
  if (!m || /flexion/.test(m[2])) return null;
  const name = m[1].trim();
  for (const [re, pos] of SECTION_POS) if (re.test(name)) return pos;
  return null;
}

/** wikitext 粗略轉純文字，只給人（與寫釋義的 agent）讀，不求完美。 */
function plain(s) {
  return s
    .replace(/\{\{(lexique|term|registre)\|([^|}]+)[^}]*\}\}/g, '($2)')
    .replace(/\{\{(figuré|familier|vieilli|littéraire|soutenu|péjoratif|populaire|argot|rare|désuet|ironique|par extension|analogie|sens figuré|métonymie)(\|[^}]*)?\}\}/g, '($1)')
    .replace(/\{\{[^{}]*\}\}/g, '')
    .replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, '$1')
    .replace(/'''?/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const VOWEL = /^[aeiouyàâäéèêëîïôöùûüœæ]/i;

function parseSection(word, text) {
  const out = {};
  // 以三個等號的標題切詞類；traductions 是四個等號，會留在所屬詞類的區塊裡。
  const blocks = text.split(/^(?====\s*\{\{S\|)/m);
  for (const block of blocks) {
    const header = block.split('\n', 1)[0];
    if (!/^===\s*\{\{S\|/.test(header) || /^====/.test(header)) continue;
    const pos = posOf(header);
    if (!pos) continue;
    const entry = out[pos] ?? { g: null, elide: null, zh: [], defs: [] };
    const lines = block.split('\n');
    const head = lines.find((l) => /^'''/.test(l)) ?? '';
    if (pos === 'NOM' && !entry.g) {
      const g = head.match(/\{\{(mf|m|f)(?:\s*\?)?(?:\|[^}]*)?\}\}/);
      if (g) entry.g = g[1];
      // 詞首 h 預設當啞音（會省音），詞首行有 « h aspiré » 才不省。
      const aspire = /h aspiré|\{\{h\}\}/.test(head);
      entry.elide = VOWEL.test(word) || (/^h/i.test(word) && !aspire);
    }
    for (const l of lines) {
      if (/^#\s/.test(l) && entry.defs.length < 4) {
        const d = plain(l.slice(1));
        if (d) entry.defs.push(d.length > 160 ? `${d.slice(0, 157)}…` : d);
      }
      if (/\{\{T\|(zh|cmn)\}\}/.test(l)) {
        for (const m of l.matchAll(/\{\{trad[+-]*\|(?:zh|cmn)\|([^|}]+)((?:\|[^}]*)?)\}\}/g)) {
          // 中文翻譯多半寫簡體，繁體放在 tradi= 參數裡；有就用繁體。
          const tradi = m[2].match(/\|tradi=([^|}]+)/)?.[1];
          const zh = (tradi ?? m[1]).trim();
          if (zh && !entry.zh.includes(zh)) entry.zh.push(zh);
        }
      }
    }
    out[pos] = entry;
  }
  return out;
}

async function main() {
  await mkdir(CACHE, { recursive: true });
  const rows = await loadFlelex(SOURCES.flelex, ['A1', 'A2', 'B1', 'B2']);
  // FLELex 把 œ 寫成 oe（coeur、soeur）。改寫成 œ 的那一頁有法文段落，才算找到正確拼法；
  // coexister、coefficient 的 oe 本來就是兩個字母，改寫後查不到頁面，自然不會被換掉。
  const flWords = [...new Set(rows.map((r) => r.word))];
  // 頁面標題用排版撇號（main-d’œuvre），FLELex 用直撇號，兩種都查。
  const variants = flWords.filter((w) => w.includes('oe'))
    .flatMap((w) => { const v = w.replaceAll('oe', 'œ'); return [v, v.replaceAll("'", '’')]; });
  const words = [...new Set([...flWords, ...variants])].sort();
  const raw = process.argv.includes('--parse')
    ? JSON.parse(await readFile(RAW, 'utf8'))
    : await fetchAll(words);

  const parsed = {};
  for (const w of words) parsed[w] = raw[w] ? parseSection(w, raw[w]) : null;
  await writeFile(PARSED, JSON.stringify(parsed, null, 1));

  // 覆蓋率：以 FLELex 的（字, 詞性）為單位，不是以頁面為單位。
  const stat = { rows: rows.length, noPage: 0, noPos: 0, nom: 0, nomGender: 0, zh: 0 };
  for (const r of rows) {
    const p = parsed[r.word];
    if (!p) { stat.noPage += 1; continue; }
    const e = p[r.pos];
    if (!e) { stat.noPos += 1; continue; }
    if (e.zh.length) stat.zh += 1;
    if (r.pos === 'NOM') { stat.nom += 1; if (e.g) stat.nomGender += 1; }
  }
  console.log(stat);
}

main().catch((err) => { console.error(err); process.exit(1); });
