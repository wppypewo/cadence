/**
 * 從個人筆記解析「連接詞 → 後接語氣」的判斷表。
 *
 * 來源是 vault 的 wiki/concepts/french/french-connectors.md，那份筆記本身整理自
 * 老師的教材。這裡只讀不寫，且產物落在 gitignore 的 data/bank/，
 * 筆記內容不會被複製進本 repo。
 *
 * 解析對象是那張「快速判斷表」的 Markdown 表格。刻意寫得保守：
 * 表格結構一變就回傳空陣列，讓 build 明白報「連接詞 0 筆」，
 * 而不是靜默產出半套資料。
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** 表格「後接」欄的文字 → 語氣代碼。認不出來的整列跳過。 */
const MOOD_PATTERNS = [
  [/subjonctif/i, 'subjonctif'],
  [/conditionnel/i, 'conditionnel'],
  [/infinitif/i, 'infinitif'],
  [/\+\s*nom/i, 'nom'],
  [/indicatif/i, 'indicatif'],
];

export const MOOD_LABELS = {
  subjonctif: '虛擬式 subjonctif',
  indicatif: '直陳式 indicatif',
  conditionnel: '條件式 conditionnel',
  infinitif: '不定式 infinitif',
  nom: '名詞 nom',
};

const stripMarkdown = (s) => s.replace(/\*\*/g, '').replace(/`/g, '').trim();

/**
 * 解析判斷表。
 * @returns {Array<{connector:string, mood:string, ambiguous:boolean, fn:string, zh:string}>}
 */
export function parseConnectors(markdown) {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => l.includes('快速判斷表'));
  if (start === -1) return [];

  const rows = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith('## ')) break;
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map(stripMarkdown);
    if (cells.length < 4) continue;
    if (/^-+$/.test(cells[0]) || cells[0] === '連接詞 / 表達') continue;

    const [rawConnectors, fn, rawMood, zh] = cells;
    const moods = MOOD_PATTERNS.filter(([re]) => re.test(rawMood)).map(([, m]) => m);
    if (moods.length === 0) continue;

    // 「indicatif／conditionnel，視語氣」這類多解列記成 ambiguous：
    // 出題時不當單選題考，只作說明卡，免得把「兩種都對」教成「只有一種對」。
    // 只有語氣本身有兩種選擇才算多解。「依時態判斷」講的是時態不是語氣，
    // 那類仍然是明確的 indicatif，可以出題。
    const ambiguous = moods.length > 1 || /視語氣|可接/.test(rawMood);

    // 一列常收多個同性質連接詞，用 / 分開，拆成獨立條目。
    // 中文欄也用 / 對齊，數量對得上就逐一配對，對不上就整列共用同一段中文。
    const connectors = rawConnectors.split('/').map((s) => s.trim()).filter(Boolean);
    const zhParts = zh.split('/').map((s) => s.trim()).filter(Boolean);
    const pairZh = zhParts.length === connectors.length;

    connectors.forEach((raw, idx) => {
      // 表格末列的「au moment où …」帶了省略號，那是「還有其他」的意思，不是詞的一部分。
      // 「alors que（對立）」的括號是用法註記，留在題面等於先告訴你答案，拆出來另存。
      const trimmed = raw.replace(/\s*…\s*$/, '').trim();
      const senseMatch = /^(.*?)（(.+)）$/.exec(trimmed);
      const connector = (senseMatch ? senseMatch[1] : trimmed).trim();
      const sense = senseMatch ? senseMatch[2] : '';
      if (!connector) return;
      rows.push({
        connector,
        sense,
        mood: moods[0],
        moods,
        ambiguous,
        moodRaw: rawMood,
        fn,
        zh: pairZh ? zhParts[idx] : zh,
      });
    });
  }

  // alors que 在表裡出現兩次（對立用法接 indicatif、時間用法依時態判斷）。
  // 併成一條並記成 ambiguous——它本來就不是單一答案。
  const merged = new Map();
  for (const row of rows) {
    const prev = merged.get(row.connector);
    if (!prev) {
      merged.set(row.connector, row);
      continue;
    }
    prev.moods = [...new Set([...prev.moods, ...row.moods])];
    prev.ambiguous = prev.ambiguous || row.ambiguous || prev.moods.length > 1;
    prev.fn = prev.fn === row.fn ? prev.fn : `${prev.fn}／${row.fn}`;
  }
  return [...merged.values()];
}

export async function loadConnectors(vaultDir) {
  const file = path.join(vaultDir, 'french-connectors.md');
  return parseConnectors(await readFile(file, 'utf8'));
}
