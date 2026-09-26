/**
 * 從 lexicon/.cache/parsed.json（lexicon-wikt.mjs 的產物）整理出兩份進版控的事實檔：
 *
 *   lexicon/genders.json   { 名詞: { g: 'm'|'f'|'mf', elide: bool } }，A1–B2 全部名詞
 *   lexicon/spelling.json  { FLELex 拼法: 正確拼法 }：oe → œ，加上三條全大寫的誤標
 *
 * 性別與省音是事實，不是 Wiktionnaire 的文字，所以可以用自己的格式收進來；
 * 定義與翻譯原文（CC BY-SA）留在 .cache/ 不進版控。
 *
 *   node scripts/lexicon-genders.mjs
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SOURCES, LEXICON, loadFlelex, readJson } from '../src/build/sources.mjs';

const PARSED = path.join(LEXICON, '.cache', 'parsed.json');

/**
 * FLELex 把這三條存成全大寫（FAUX|ADJ、VRAI|ADJ、VRAI|NOM），小寫的 faux／vrai 反而不在表裡。
 * 大寫字抓不到 Wiktionnaire 頁面，fexgen 的人工釋義也只能寫「⚠ 大寫誤標」，
 * 結果 A1 最常用的兩個形容詞沒有「寫」的卡。2026-09-26 查過作答紀錄，三條都沒有作答過，改 id 不會丟進度。
 */
const CASE_FIXES = { FAUX: 'faux', VRAI: 'vrai' };

/** 上面改寫後的字 Wiktionnaire 快取裡沒有（抓的時候用的是大寫），性別直接寫。 */
const MANUAL_GENDERS = { vrai: { g: 'm', elide: false } };

/**
 * 依詞義變性別的同形字：parsed.json 只記頁面上第一個名詞段落的性別，常用詞義常在後面的段落。
 * 2026-09-26 掃過「名詞段落同時有 m 與 f」的 147 字，這 11 個的卡面釋義寫的是另一性的詞義
 * （crêpe 第一段是縐紗 m、可麗餅在第二段 f；vase 第一段是淤泥 f、花瓶在後面 m）。
 * 只改 g，省音照 Wiktionnaire。釋義裡另一性的次要詞義由 glosses.json 以「（陰性）…」標出。
 */
const SENSE_GENDERS = {
  couple: 'm', crêpe: 'f', cravate: 'f', dalle: 'f', faune: 'f', parallèle: 'm',
  plastique: 'm', solde: 'm', tour: 'm', vague: 'f', vase: 'm',
};

/**
 * Wiktionnaire 標 {{mf}}、但一般用法只有一性的字。解析沒錯（原文就是 mf），
 * 只是卡面寫 mf 會讓人以為兩性都能用：數字當名詞時是 le cinq（la cinq 只指頻道或巴士路線），
 * automne 的陰性 Wiktionnaire 自己注明罕用且屬文學用法，un espèce de 是口語的誤用。
 * 2026-09-27 B2 抽查時從 mf 的 183 字裡挑出；其餘多是 un／une 同形的人稱名詞，mf 正確。
 */
const USAGE_GENDERS = {
  amour: 'm', automne: 'm', chronique: 'f', cinq: 'm', cinquante: 'm', dix: 'm', espèce: 'f',
  génie: 'm', mammifère: 'm', pseudonyme: 'm', quatre: 'm', sept: 'm', trois: 'm',
};

/** 一個鍵一行：幾千筆的檔案 diff 時才看得出改了哪一個字。 */
function lines(obj) {
  const keys = Object.keys(obj).sort((a, b) => a.localeCompare(b, 'fr'));
  return `{\n${keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(obj[k])}`).join(',\n')}\n}\n`;
}

async function main() {
  const parsed = JSON.parse(await readFile(PARSED, 'utf8'));
  const rows = await loadFlelex(SOURCES.flelex, ['A1', 'A2', 'B1', 'B2']);

  const spelling = {};
  for (const w of new Set(rows.map((r) => r.word))) {
    if (!w.includes('oe')) continue;
    const v = w.replaceAll('oe', 'œ');
    // 撇號維持 FLELex 的直撇號，與其他詞條（aujourd'hui）一致；批改時 normalize() 會統一。
    if (parsed[v] || parsed[v.replaceAll("'", '’')]) spelling[w] = v;
  }
  Object.assign(spelling, CASE_FIXES);

  const genders = {};
  const miss = [];
  for (const r of rows) {
    if (r.pos !== 'NOM') continue;
    const word = spelling[r.word] ?? r.word;
    if (MANUAL_GENDERS[word]) { genders[word] = MANUAL_GENDERS[word]; continue; }
    const e = (parsed[word] ?? parsed[word.replaceAll("'", '’')])?.NOM;
    if (!e?.g) { miss.push(r); continue; }
    genders[word] = { g: SENSE_GENDERS[word] ?? USAGE_GENDERS[word] ?? e.g, elide: e.elide };
  }

  // 與 fexgen 那份 92 筆比對：兩邊都來自 Wiktionnaire，對不上代表解析有漏洞。
  const fex = await readJson(path.join(SOURCES.fexgen, 'genders.json'));
  const diff = Object.entries(fex).filter(([w, x]) => genders[w] && (genders[w].g !== x.g || genders[w].elide !== x.elide));

  await writeFile(path.join(LEXICON, 'genders.json'), lines(genders));
  await writeFile(path.join(LEXICON, 'spelling.json'), lines(spelling));

  const byLevel = {};
  for (const r of miss) (byLevel[r.level] ??= []).push(r.word);
  console.log(`性別 ${Object.keys(genders).length} 筆；拼法更正 ${Object.keys(spelling).length} 筆：${Object.entries(spelling).map(([a, b]) => `${a}→${b}`).join('、')}`);
  console.log(`查不到性別 ${miss.length} 筆：`, Object.fromEntries(Object.entries(byLevel).map(([k, v]) => [k, `${v.length}（${v.slice(0, 12).join('、')}…）`])));
  console.log(`與 fexgen genders.json 不一致 ${diff.length} 筆：`, diff.map(([w, x]) => `${w} fexgen=${JSON.stringify(x)} 本檔=${JSON.stringify(genders[w])}`));
}

main().catch((err) => { console.error(err); process.exit(1); });
