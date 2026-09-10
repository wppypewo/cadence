/**
 * 外部資料來源的位置與讀取。
 *
 * 這個檔案是本專案唯一知道「別的目錄長什麼樣」的地方。其餘模組只吃已整理好的
 * 結構，不再碰路徑，換機器或搬目錄時只需要改這裡（或設環境變數）。
 */

import { readFile, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const HOME = homedir();

export const SOURCES = {
  /** 詞彙、人工釋義、英文定義、陰陽性 */
  fexgen: process.env.CADENCE_FEXGEN
    ?? path.join(HOME, 'ClaudeCode/projects/french-exam-generator/data'),
  /** Verbiste 變位原始資料（GPL-2.0，僅在建置時讀取，不進本 repo） */
  verbiste: process.env.CADENCE_VERBISTE
    ?? path.join(HOME, 'ClaudeCode/KnowledgeBase/Ricky-KnowledgeBase/raw/sources/french/verbiste'),
  /** 個人筆記：連接詞後接語氣等文法規則 */
  vault: process.env.CADENCE_VAULT
    ?? path.join(HOME, 'ClaudeCode/KnowledgeBase/Ricky-KnowledgeBase/wiki/concepts/french'),
  /** 個人筆記：考卷與講義整理出來的現成題目 */
  packs: process.env.CADENCE_PACKS
    ?? path.join(HOME, 'ClaudeCode/KnowledgeBase/Ricky-KnowledgeBase/wiki/outputs/study-packs'),
};

/**
 * 名詞化那兩份清單（EXCLUDE／FROM_EXAM）與構詞規則的原生位置。
 *
 * cadence 自存了一份副本在 src/build/nominals.mjs——那邊沒有機器可讀的匯出格式，
 * 只能照抄。tests/nominals-drift.test.mjs 靠這個路徑把兩份比對回去，
 * 改一邊就會紅。**只有測試讀它，npm run build 不讀**：
 * 那個 repo 有別的 session 在改，不能讓「今天建不建得出題庫」綁在它的檔案格式上。
 */
export const NOMINALIZE_PY = path.join(SOURCES.fexgen, '..', 'tools', 'nominalize.py');

export async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(p) {
  return JSON.parse(await readFile(p, 'utf8'));
}

/** gloss 檔名裡的詞性標記 → FLELex 詞性。gloss_a1_adj_adv.json 同時負責兩種詞性。 */
const POS_TOKENS = { adj: 'ADJ', adv: 'ADV', nom: 'NOM', ver: 'VER' };

function filePos(basename) {
  return basename.split('_').filter((t) => POS_TOKENS[t]).map((t) => POS_TOKENS[t]);
}

/**
 * 讀入 2,000 多筆人工中文釋義，回傳三張查詢表。
 *
 * bypos 這層不能省：plain 只用單字當 key，而檔名排序讓 B1 的檔排在 A1／A2 之後，
 * 同名不同詞性的字會被後讀到的檔覆蓋。french-exam-generator 實測有 25 筆因此拿到
 * 別的詞性的釋義（pouvoir 動詞拿到名詞「權力」）。這裡沿用它修好後的做法。
 */
export async function loadGlosses(dir, filenames) {
  const plain = new Map();
  const bypos = new Map();
  const override = new Map();
  for (const name of [...filenames].sort()) {
    const base = name.replace(/\.json$/, '');
    const data = await readJson(path.join(dir, name));
    if (base.includes('overrides')) {
      for (const [k, v] of Object.entries(data)) override.set(k, v);
      continue;
    }
    for (const [word, gloss] of Object.entries(data)) {
      plain.set(word, gloss);
      for (const pos of filePos(base)) bypos.set(`${word}|${pos}`, gloss);
    }
  }
  return { plain, bypos, override };
}

/** 查詢優先序：人工指定 → 同詞性 → 單字（最後退路）。 */
export function resolveGloss({ plain, bypos, override }, word, pos) {
  const key = `${word}|${pos}`;
  return override.get(key) ?? bypos.get(key) ?? plain.get(word) ?? '';
}

/** 每個來源必須有的檔案。doctor 用這張表判斷「還能不能重建題庫」。 */
const REQUIRED = {
  fexgen: ['vocab_a1a2.json', 'vocab_b1.json', 'en_defs.json', 'genders.json'],
  verbiste: ['verbs-fr.xml', 'conjugation-fr.xml'],
  vault: ['final-exam-grammar-core.md', 'french-connectors.md'],
  packs: [
    'french-111-2-grammar-exam-pack.md',
    'french-connector-pick-bank.md',
    'french-rewrite-drill-bank.md',
  ],
};

/**
 * 檢查三個來源是否還在原地。
 * 這是這個專案唯一的外部依賴，來源搬走了就無法重建題庫——
 * 但已經累積的複習紀錄不受影響，那份在 data/reviews.jsonl。
 */
export async function checkSources() {
  const out = {};
  for (const [name, dir] of Object.entries(SOURCES)) {
    if (!(await exists(dir))) {
      out[name] = { ok: false, dir, detail: `目錄不存在：${dir}` };
      continue;
    }
    const missing = [];
    for (const f of REQUIRED[name] ?? []) {
      if (!(await exists(path.join(dir, f)))) missing.push(f);
    }
    out[name] = missing.length
      ? { ok: false, dir, detail: `缺 ${missing.join('、')}` }
      : { ok: true, dir, detail: dir.replace(HOME, '~') };
  }
  return out;
}
