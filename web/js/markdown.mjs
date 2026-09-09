/**
 * 最小的 Markdown 渲染器。只認這兩份 study 文件真的用到的語法。
 *
 * 為什麼要寫這個：CO／PO 兩份文件原本是原樣印在 <pre> 裡的。那個決定當時的理由
 * 是「渲染器要處理的邊界比它省下的閱讀力氣多」，但那句話低估了文件的內容——
 * 兩份加起來有 11 張表格，其中評分格是 PO 那份最該被讀懂的東西。
 * 表格在 <pre> 裡是一堆對不齊的直線，等於沒有。
 *
 * 邊界問題用「只支援用得到的語法」解決，不是用完整實作解決：
 *   # ## ###　標題
 *   |…|…|　　表格（第二列是分隔線）
 *   -　　　　 無序清單（含巢狀一層）
 *   1.　　　　有序清單
 *   >　　　　 引言
 *   ---　　　 分隔線
 *   ```　　　 程式碼區塊，區塊內一律原樣，不解析行內語法
 *   **粗體**、`行內碼`　行內只認這兩種
 *
 * 沒支援的東西（連結、圖片、斜體、刪除線、巢狀引言）在這兩份文件裡不存在。
 * 真的出現時會原樣印出來，不會壞掉也不會被誤判成別的東西。
 *
 * 解析與建 DOM 拆成兩半：parseBlocks／parseInline 是純函式，測得起來；
 * render() 才碰 document。
 */

import { h } from './dom.mjs';

/**
 * 把 Markdown 切成區塊。
 * @returns {Array<{type:string, …}>}
 */
export function parseBlocks(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i += 1; continue; }

    // 程式碼區塊要最先判，否則區塊裡的 # 與 | 會被當成標題與表格。
    const fence = /^\s*```(\w*)\s*$/.exec(line);
    if (fence) {
      const body = [];
      i += 1;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { body.push(lines[i]); i += 1; }
      i += 1; // 收尾的 ```；沒收尾就是讀到檔尾，一樣結束
      out.push({ type: 'code', lang: fence[1] || '', text: body.join('\n') });
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push({ type: 'hr' }); i += 1; continue; }

    const head = /^(#{1,6})\s+(.*)$/.exec(line);
    if (head) {
      out.push({ type: 'heading', level: head[1].length, text: head[2].trim() });
      i += 1;
      continue;
    }

    // 表格：本行是 |…|，下一行是 |---|---| 這種分隔列。
    if (line.trim().startsWith('|') && i + 1 < lines.length && isDivider(lines[i + 1])) {
      const header = splitRow(line);
      const align = splitRow(lines[i + 1]).map(alignOf);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) { rows.push(splitRow(lines[i])); i += 1; }
      out.push({ type: 'table', header, align, rows });
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { body.push(lines[i].replace(/^\s*>\s?/, '')); i += 1; }
      out.push({ type: 'quote', text: body.join('\n') });
      continue;
    }

    if (itemOf(line)) {
      const ordered = itemOf(line).ordered;
      const items = [];
      while (i < lines.length && itemOf(lines[i]) && itemOf(lines[i]).ordered === ordered) {
        const it = itemOf(lines[i]);
        i += 1;
        // 續行：比項目符號更深的縮排，或沒有符號的接續行。清單項目常常寫成兩三行。
        const cont = [];
        while (i < lines.length && lines[i].trim() && !itemOf(lines[i]) && /^\s{2,}/.test(lines[i])) {
          cont.push(lines[i].trim()); i += 1;
        }
        items.push({ text: [it.text, ...cont].join(' '), depth: it.depth });
      }
      out.push({ type: 'list', ordered, items });
      continue;
    }

    // 其餘都是段落，讀到空行為止。
    const body = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) { body.push(lines[i].trim()); i += 1; }
    if (!body.length) { body.push(lines[i].trim()); i += 1; }
    out.push({ type: 'para', text: body.join(' ') });
  }

  return out;
}

/** 這一行是不是別種區塊的開頭。段落靠它決定要不要在此打住。 */
function isBlockStart(line) {
  return /^\s*```/.test(line)
    || /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)
    || /^#{1,6}\s/.test(line)
    || /^\s*>\s?/.test(line)
    || line.trim().startsWith('|')
    || Boolean(itemOf(line));
}

/** `- x` 或 `1. x`；回傳縮排深度（每兩個空白算一層，封在兩層）。 */
function itemOf(line) {
  const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
  if (!m) return null;
  return {
    ordered: /\d/.test(m[2]),
    depth: Math.min(2, Math.floor(m[1].length / 2)),
    text: m[3].trim(),
  };
}

function isDivider(line) {
  return /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes('-') && line.includes('|');
}

/** 拆一列表格。前後的 | 去掉，中間用未跳脫的 | 分。 */
function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

function alignOf(cell) {
  const l = cell.startsWith(':');
  const r = cell.endsWith(':');
  if (l && r) return 'center';
  if (r) return 'right';
  return 'left';
}

/**
 * 行內語法。只切 **粗體** 與 `行內碼`，其餘原樣。
 * @returns {Array<{type:'text'|'strong'|'code', text:string}>}
 */
export function parseInline(text) {
  const out = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  let m = re.exec(text);
  while (m) {
    if (m.index > last) out.push({ type: 'text', text: text.slice(last, m.index) });
    out.push(m[1] !== undefined ? { type: 'strong', text: m[1] } : { type: 'code', text: m[2] });
    last = m.index + m[0].length;
    m = re.exec(text);
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) });
  return out;
}

/** 行內節點。文字一律走 textContent，沒有任何一條路徑會把字串當 HTML 解析。 */
function inline(text) {
  return parseInline(text).map((t) => {
    if (t.type === 'strong') return h('strong', { text: t.text });
    if (t.type === 'code') return h('code', { text: t.text });
    return document.createTextNode(t.text);
  });
}

/** 把 Markdown 渲染成一個 .md 容器節點。 */
export function render(text) {
  const root = h('div.md');
  for (const b of parseBlocks(text)) root.append(block(b));
  return root;
}

function block(b) {
  switch (b.type) {
    case 'heading':
      // h1 只會出現在文件開頭那一行，這裡降成 h3 起跳——
      // 它是嵌在「今天」頁一列任務裡的內容，不該蓋過頁面本身的標題階層。
      return h(`h${Math.min(6, b.level + 2)}.md-h`, { dataset: { l: String(b.level) } }, ...inline(b.text));
    case 'hr':
      return h('hr.md-hr');
    case 'code':
      return h('pre.md-code', {}, h('code', { text: b.text }));
    case 'quote':
      return h('blockquote.md-quote', {}, ...parseBlocks(b.text).map(block));
    case 'list':
      return list(b);
    case 'table':
      return table(b);
    default:
      return h('p.md-p', {}, ...inline(b.text));
  }
}

function list(b) {
  const box = h(b.ordered ? 'ol.md-list' : 'ul.md-list');
  for (const it of b.items) box.append(h('li', { dataset: { d: String(it.depth) } }, ...inline(it.text)));
  return box;
}

function table(b) {
  const head = h('tr');
  b.header.forEach((c, i) => head.append(h('th', { style: `text-align:${b.align[i] ?? 'left'}` }, ...inline(c))));
  const body = h('tbody');
  for (const row of b.rows) {
    const tr = h('tr');
    row.forEach((c, i) => tr.append(h('td', { style: `text-align:${b.align[i] ?? 'left'}` }, ...inline(c))));
    body.append(tr);
  }
  // 表格是這兩份文件裡最寬的東西，窄一點的視窗放不下。橫捲的容器包在外面，
  // 讓它自己捲，而不是把整頁撐寬。
  return h('div.md-tablewrap', {}, h('table.md-table', {}, h('thead', {}, head), body));
}
