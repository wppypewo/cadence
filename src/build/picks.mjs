/**
 * 解析「從方框裡挑連接詞」的挖空題庫（考卷第 II 大題，28%）。
 *
 * 題源兩份，都在 vault 的 wiki/outputs/study-packs/：
 *   french-111-2-grammar-exam-pack.md   考卷本身三組方框（A–C），28 題
 *   french-connector-pick-bank.md       講義挖空擴充五組方框（D–H），47 題
 *
 * 只讀不寫，產物落在 gitignore 的 data/bank/，筆記內容不會被複製進本 repo。
 *
 * 方框選項不在程式裡另抄一份，一律讀各組的 `### <組名>. <選項> – <選項> …` 標題。
 * 抄第二份的下場是筆記改了、題目沒跟著改，而且不會有人發現。
 *
 * 三級批改的判定住在 src/engine/grade.mjs（前端也要用），本檔只負責解析。
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { familyOf } from '../engine/grade.mjs';

// 判定函式住在 src/engine/grade.mjs：前端也要用同一份，不能在建置端留第二份實作。
// 這裡 re-export，讓「pick 的規則」在同一個模組名下找得到。
export { expandOption, normPick, unelide, familyOf, gradePick } from '../engine/grade.mjs';

const stripBold = (s) => s.replace(/\*\*/g, '').trim();

/** 「A. x – y – z（13 題）」→ {group:'A', options:['x','y','z']} */
function parseGroupHeading(heading) {
  const idx = heading.indexOf('.');
  if (idx === -1) return null;
  const group = heading.slice(0, idx).trim();
  // 剝掉「（13 題）」這種註記，那不是選項。
  const rest = heading.slice(idx + 1).replace(/（[^）]*）/g, '');
  const options = rest
    .split(/[–—·]|(?<= )-(?= )/)
    .map((o) => stripBold(o))
    .filter(Boolean);
  if (!group || options.length < 2) return null;
  return { group, options };
}

/**
 * 抽一份挖空題庫。
 *
 * 表格欄位：`| # | 題目 | 解答 | 理由 | 出處? |`
 * 第五欄（出處）只有擴充題庫有；考卷表沒有，統一套 fallbackSrc。
 *
 * 找不到區段就回空陣列，讓 build 明白報 0 筆，不靜默產半套。
 *
 * @returns {Array<{id:string, group:string, num:string, prompt:string,
 *                  answer:string, why:string, options:string[], src:string}>}
 */
export function parsePickTable(markdown, { head, tail, sec, fallbackSrc }) {
  const start = markdown.indexOf(head);
  if (start < 0) return [];
  const end = markdown.indexOf(tail, start + head.length);
  const block = markdown.slice(start, end > 0 ? end : markdown.length);

  const items = [];
  let group = null;
  let options = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('### ')) {
      const parsed = parseGroupHeading(line.slice(4).trim());
      // 認不出方框的組整組跳過：沒有選項的挑選題不成題。
      group = parsed ? parsed.group : null;
      options = parsed ? parsed.options : [];
      continue;
    }
    if (!group || !line.startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 6) continue;
    if (!/^\d+$/.test(cells[1])) continue;

    items.push({
      id: `p:${sec}${group}|${cells[1]}`,
      sec,
      group,
      num: cells[1],
      prompt: stripBold(cells[2]),
      answer: stripBold(cells[3]),
      // 筆記的粗體標記不該印進畫面
      why: stripBold(cells[4] ?? ''),
      options,
      // 逐題出處：擴充題庫每題的講義頁碼都不一樣，不能共用一個標籤
      src: cells.length > 6 && cells[5] ? stripBold(cells[5]) : fallbackSrc,
    });
  }
  return items;
}

export async function loadPicks(packsDir) {
  const [exam, bank] = await Promise.all([
    readFile(path.join(packsDir, 'french-111-2-grammar-exam-pack.md'), 'utf8'),
    readFile(path.join(packsDir, 'french-connector-pick-bank.md'), 'utf8'),
  ]);
  return [
    ...parsePickTable(exam, {
      head: '## II.', tail: '## III.', sec: 'II', fallbackSrc: '教材 111-2 II',
    }),
    ...parsePickTable(bank, {
      head: '## 題庫', tail: '## 沒有做成題的', sec: '講義', fallbackSrc: '教材 講義',
    }),
  ];
}
