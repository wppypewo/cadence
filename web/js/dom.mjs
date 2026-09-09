/**
 * 建 DOM 的小工具。沒有框架，也沒有樣板字串拼 HTML。
 *
 * 全程用 document.createElement 與 textContent，任何來自題庫或使用者輸入的
 * 字串都不會被當成 HTML 解析。這比在每個地方記得跳脫可靠。
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * h('div.card', { onclick }, child, child…)
 * 第一個參數支援 tag、.class、#id 的簡寫。
 */
export function h(spec, props = null, ...kids) {
  const [tag, ...rest] = String(spec).split(/(?=[.#])/);
  const node = document.createElement(tag || 'div');
  for (const token of rest) {
    if (token[0] === '.') node.classList.add(token.slice(1));
    else node.id = token.slice(1);
  }
  apply(node, props);
  add(node, kids);
  return node;
}

/** SVG 版本。SVG 元素必須用 createElementNS，否則不會被渲染。 */
export function s(spec, props = null, ...kids) {
  const [tag, ...rest] = String(spec).split(/(?=[.#])/);
  const node = document.createElementNS(SVG_NS, tag);
  for (const token of rest) if (token[0] === '.') node.classList.add(token.slice(1));
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    node.setAttribute(k, String(v));
  }
  add(node, kids);
  return node;
}

function apply(node, props) {
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = String(v);
    else if (k === 'html') throw new Error('不提供 innerHTML，請用 text 或子節點');
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k in node && k !== 'list') node[k] = v;
    else node.setAttribute(k, v === true ? '' : String(v));
  }
}

function add(node, kids) {
  for (const kid of kids.flat(4)) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
}

export function clear(node) {
  node.replaceChildren();
  return node;
}

/**
 * 圖示。手寫 path 而不是載圖示庫——這裡只需要十個，
 * 為了十個圖示引一個套件會破壞零依賴這件事。
 * 全部是 24×24、stroke 1.75、圓端點，視覺上是同一套。
 */
const PATHS = {
  today: 'M4 5h16a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z M3 10h18 M8 3v4 M16 3v4 M9 15l2 2 4-4',
  cards: 'M4 7h11a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z M8 4h11a2 2 0 0 1 2 2v9',
  chart: 'M4 20V10 M10 20V4 M16 20v-6 M22 20H2',
  route: 'M3 18c6 0 4-12 10-12s8 0 8 0 M18 3l3 3-3 3',
  find: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Z M16.5 16.5 21 21',
  check: 'M4 12.5 9.5 18 20 6',
  cross: 'M6 6l12 12 M18 6 6 18',
  alert: 'M12 4v10 M12 19v.01',
  sun: 'M12 6.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11Z M12 1v2 M12 21v2 M4.2 4.2l1.4 1.4 M18.4 18.4l1.4 1.4 M1 12h2 M21 12h2 M4.2 19.8l1.4-1.4 M18.4 5.6l1.4-1.4',
  moon: 'M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z',
};

export function icon(name) {
  const svg = s('svg', {
    viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    'stroke-width': '1.75', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    'aria-hidden': 'true', focusable: 'false',
  });
  for (const d of (PATHS[name] ?? '').split(' M').map((p, i) => (i ? `M${p}` : p))) {
    svg.append(s('path', { d }));
  }
  return svg;
}

/** 一句話的相對時間。「3 天後」比 2026-09-12 好讀。 */
export function relDays(n) {
  if (n <= 0) return '現在';
  if (n === 1) return '明天';
  if (n < 30) return `${n} 天後`;
  if (n < 365) return `${Math.round(n / 30)} 個月後`;
  return `${(n / 365).toFixed(1)} 年後`;
}

/** 千分位。題庫是萬張等級，不分節就讀不出來一眼是幾千還是幾萬。 */
export function num(n) {
  return Number(n).toLocaleString('zh-Hant');
}

export function pct(x, digits = 0) {
  return `${(x * 100).toFixed(digits)}%`;
}

/** 螢幕閱讀器的即時播報。批改結果不只有顏色，也要念得出來。 */
export function announce(text) {
  const live = document.getElementById('live');
  if (live) live.textContent = text;
}
