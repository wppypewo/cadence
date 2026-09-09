/**
 * 解析「用指定連接詞改寫整句」的題庫（考卷第 III 大題，18%）。
 *
 * 題源兩份，都在 vault 的 wiki/outputs/study-packs/：
 *   french-111-2-grammar-exam-pack.md   考卷 9 題，題幹是法文，練「認出原句結構再換掉」
 *   french-rewrite-drill-bank.md        講義擴充 79 題，題幹是中文，沒有原句可抄
 *
 * 兩者判分邏輯一樣，只有題幹語言不同。
 *
 * **整句不做字串比對。** `Si agréable qu'il soit` 與 `Si agréable soit-il` 都對，
 * 主詞位置、標點還有更多變體，比對整句只會製造假的錯。
 * 有定論的只有兩件事：指定的連接詞用了沒有、後面接的語氣對不對——
 * 那兩件寫在筆記的「必要要素」欄，程式照讀，不在這裡另存一份。
 *
 * 判定住在 src/engine/grade.mjs，本檔只負責解析。
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

const stripBold = (s) => s.replace(/\*\*/g, '').trim();

/**
 * 必要要素欄 → 要素組。
 *
 * 「A ＋ B」兩項都要（＝兩個組，各自都得中）；
 * 「A ／ B」其一即可（＝同一組裡的多個寫法）。
 * 全形的 ＋／ 是筆記裡實際用的符號，半形的加號會出現在要素本身
 * （`avoir + beau`），不能拿來當分隔符。
 */
export function parseMust(cell) {
  return String(cell ?? '')
    .replace(/`/g, '')
    .split('＋')
    .map((grp) => grp.split('／').map((x) => x.trim().toLowerCase()).filter(Boolean))
    .filter((alts) => alts.length);
}

/**
 * 抽一份改寫題庫。
 *
 * 表格欄位：`| # | 題目（工具） | 解答 | 理由 | 必要要素 | 出處? |`
 * 第六欄（出處）只有擴充題庫有；考卷表沒有，統一套 fallbackSrc。
 *
 * 找不到區段就回空陣列，讓 build 明白報 0 筆，不靜默產半套。
 *
 * @returns {Array<{id:string, sec:string, num:string, prompt:string, tool:string,
 *                  answer:string, why:string, must:string[][], src:string}>}
 */
export function parseRewriteTable(markdown, { head, tail, sec, fallbackSrc }) {
  const start = markdown.indexOf(head);
  if (start < 0) return [];
  const end = markdown.indexOf(tail, start + head.length);
  const block = markdown.slice(start, end > 0 ? end : markdown.length);

  const items = [];
  for (const line of block.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 7) continue;
    if (!/^\d+$/.test(cells[1])) continue;

    // 指定工具寫在題幹末尾的全形括號裡：「…（au cas où）」。
    // 它是題目的一部分（規定要用哪個連接詞），不是註記，不能連著括號印出來。
    let prompt = stripBold(cells[2]);
    let tool = '';
    if (prompt.endsWith('）')) {
      const i = prompt.lastIndexOf('（');
      if (i >= 0) {
        tool = prompt.slice(i + 1, -1).trim();
        prompt = prompt.slice(0, i).trim();
      }
    }

    items.push({
      id: `rw:${sec}|${cells[1]}`,
      sec,
      num: cells[1],
      prompt,
      tool,
      answer: stripBold(cells[3]),
      why: stripBold(cells[4] ?? ''),
      must: parseMust(cells[5]),
      // 逐題出處：擴充題庫每題的講義頁碼都不一樣，不能共用一個標籤
      src: cells.length > 7 && cells[6] ? stripBold(cells[6]) : fallbackSrc,
    });
  }
  return items;
}

export async function loadRewrites(packsDir) {
  const [exam, bank] = await Promise.all([
    readFile(path.join(packsDir, 'french-111-2-grammar-exam-pack.md'), 'utf8'),
    readFile(path.join(packsDir, 'french-rewrite-drill-bank.md'), 'utf8'),
  ]);
  return [
    ...parseRewriteTable(exam, {
      head: '## III.', tail: '## IV.', sec: 'III', fallbackSrc: '教材 111-2 III',
    }),
    ...parseRewriteTable(bank, {
      head: '## 題庫', tail: '## 教材原文瑕疵', sec: 'B', fallbackSrc: '教材 講義',
    }),
  ];
}
