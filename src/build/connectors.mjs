/**
 * 從個人筆記解析「連接詞 → 後接語氣」的判斷表。
 *
 * 來源是 vault 的兩份筆記，都整理自老師的教材。這裡只讀不寫，
 * 且產物落在 gitignore 的 data/bank/，筆記內容不會被複製進本 repo。
 *
 * 兩份筆記各有一張「快速判斷表」，2026-09-09 盤點時發現兩張的收錄範圍差很多，
 * 而且只有 french-connectors 那張被程式讀過。分工已定案：
 *
 *   final-exam-grammar-core.md  依語氣分列（PDF §5），49 筆 —— **語氣的權威**
 *   french-connectors.md        依連接詞分列，27 筆 —— 只供功能與中文，
 *                               以及權威表沒收的少數條目（avoir beau 等）
 *
 * 語氣衝突時一律以權威表為準。使用者 2026-09-09 裁定 `après que` 接 indicatif，
 * 與權威表一致，所以不需要額外的例外表。
 *
 * 解析刻意寫得保守：權威表的結構一變就回傳空陣列，讓 build 明白報
 * 「連接詞 0 筆」，而不是靜默產出半套資料。
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
  // comme si 只有這一個。它接的是直陳式的 imparfait／plus-que-parfait，
  // 但考的重點是「不能接 conditionnel」，答「indicatif」等於沒答到那一步，
  // 所以獨立成一個選項。
  imparfait: '未完成／愈過去 imparfait・plus-que-parfait',
};

const stripMarkdown = (s) => s.replace(/\*\*/g, '').replace(/`/g, '').trim();

/** 比對用的正規化：彎撇號與直撇號混用會把同一個連接詞當成兩個。 */
const normKey = (s) => s.toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();

/** 次要比對鍵：去掉括號內的詞形標記，讓 `quel(le)(s) que` 對得上 `quel que`。 */
const variantKey = (s) => normKey(s.replace(/[（(][^）)]*[）)]/g, ' '));

/** 拆出「詞（用法註記）」。註記留在題面等於先告訴你答案，要另存。 */
function splitSense(raw) {
  const trimmed = raw.replace(/\s*…\s*$/, '').trim();
  const m = /^(.*?)[（(](.+)[）)]$/.exec(trimmed);
  return m ? { connector: m[1].trim(), sense: m[2].trim() } : { connector: trimmed, sense: '' };
}

/**
 * 解析權威表：final-exam-grammar-core.md 的「快速判斷表」，依語氣分列。
 *
 * 一列長這樣：`| **Subjonctif** | avant que, bien que, quoi que |`
 * 連接詞欄只用逗號分隔——不能拿斜線再拆一次，
 * `si/quelque/pour + adj + que` 本身就帶斜線。
 *
 * @returns {Array<{connector:string, sense:string, mood:string, moods:string[],
 *                  ambiguous:boolean, moodRaw:string}>}
 */
export function parseMoodTable(markdown) {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => l.startsWith('## ') && l.includes('快速判斷表'));
  if (start === -1) return [];

  const rows = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith('## ')) break;
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map(stripMarkdown);
    if (cells.length !== 2) continue;
    if (/^-+$/.test(cells[0]) || cells[0] === '語氣') continue;

    const [rawMood, items] = cells;
    // 「Indicatif 或 subjonctif」要先認出多解，否則會被單一 pattern 先吃掉。
    const moods = MOOD_PATTERNS.filter(([re]) => re.test(rawMood)).map(([, m]) => m);
    if (/imparfait/i.test(rawMood)) moods.push('imparfait');
    if (moods.length === 0) continue;
    const ambiguous = moods.length > 1;

    for (const item of items.split(',')) {
      const { connector, sense } = splitSense(item);
      if (!connector) continue;
      rows.push({ connector, sense, mood: moods[0], moods, ambiguous, moodRaw: rawMood });
    }
  }
  return rows;
}

/**
 * 解析 french-connectors.md 的判斷表，依連接詞分列。
 *
 * 這份現在只是輔助來源：語氣以權威表為準，這裡取的是功能與中文，
 * 外加權威表漏收的條目。解析邏輯維持原樣沒動。
 *
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
      const { connector, sense } = splitSense(raw);
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

/**
 * 合併兩份表：語氣一律採權威表，功能與中文由輔助表補；
 * 權威表沒收的條目（avoir beau、en cas de、sinon）從輔助表整條帶進來。
 *
 * 權威表解析不出東西就整個回空陣列。半套資料比沒有資料更難發現。
 */
export function mergeConnectors(authoritative, aux) {
  if (authoritative.length === 0) return [];

  const byKey = new Map();
  const byVariant = new Map();
  for (const a of aux) {
    byKey.set(normKey(a.connector), a);
    const v = variantKey(a.connector);
    if (!byVariant.has(v)) byVariant.set(v, a);
  }

  const used = new Set();
  const out = authoritative.map((c) => {
    const key = normKey(c.connector);
    // `quel(le)(s) que` 與輔助表的 `quel que` 是同一個詞，只是詞形標記寫法不同。
    const extra = byKey.get(key) ?? byVariant.get(variantKey(c.connector));
    if (extra) used.add(normKey(extra.connector));
    return { ...c, fn: extra?.fn ?? '', zh: extra?.zh ?? '' };
  });

  for (const a of aux) {
    if (used.has(normKey(a.connector))) continue;
    out.push({ ...a, fromAux: true });
  }
  return out;
}

export async function loadConnectors(vaultDir) {
  const [core, aux] = await Promise.all([
    readFile(path.join(vaultDir, 'final-exam-grammar-core.md'), 'utf8'),
    readFile(path.join(vaultDir, 'french-connectors.md'), 'utf8'),
  ]);
  return mergeConnectors(parseMoodTable(core), parseConnectors(aux));
}
