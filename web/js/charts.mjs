/**
 * 手寫 SVG 圖表。四種，都很小。
 *
 * 不引圖表函式庫的理由不是潔癖：這個 App 需要的圖只有「每天幾張」、
 *「未來到期量」、「推演曲線」三種形狀，任何一個函式庫都比這個檔案大幾十倍，
 * 而且會把零依賴這個前提整個推翻。圖表庫真正值錢的互動（縮放、十字準星）
 * 在這裡也用不到。
 *
 * 共同約定：viewBox 用固定座標系、寬度 100% 自適應，字級用 CSS 控制。
 */

import { h, s } from './dom.mjs';

const PAD = { top: 8, right: 8, bottom: 20, left: 30 };

/** 把資料座標換算成 viewBox 座標。 */
function scaler({ w, h: hh, maxY, count }) {
  const iw = w - PAD.left - PAD.right;
  const ih = hh - PAD.top - PAD.bottom;
  // 一格的寬度是 iw / 筆數，只有一兩筆資料時會變成半張圖寬的色塊——
  // 那看起來像出錯，不像長條圖。封頂在八分之一張圖寬，再置中放進自己那一格。
  const slot = iw / Math.max(count, 1);
  const bw = Math.max(1, Math.min(slot - 1, iw / 8));
  return {
    iw,
    ih,
    x: (i) => PAD.left + (count <= 1 ? iw / 2 : (i / (count - 1)) * iw),
    band: (i) => PAD.left + i * slot + (slot - bw) / 2,
    bw,
    y: (v) => PAD.top + ih - (maxY ? (v / maxY) * ih : 0),
  };
}

/**
 * 把上限抬到一個「除得盡」的數。
 * 資料全是整數張數，但 maxY=5 配三格刻度會標成 0／2／3／5——
 * 間距不等的刻度看起來像壞掉，讀的人會開始懷疑整張圖。
 */
function niceMax(maxY, ticks) {
  const raw = maxY / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((m) => raw <= m * mag) * mag;
  return Math.max(ticks, Math.ceil(step) * ticks);
}

function frame(w, hh, maxY, ticks = 3) {
  const g = s('g');
  const ih = hh - PAD.top - PAD.bottom;
  for (let i = 0; i <= ticks; i += 1) {
    const v = (maxY / ticks) * i;
    const y = PAD.top + ih - (maxY ? (v / maxY) * ih : 0);
    g.append(s('line.grid', { x1: PAD.left, x2: w - PAD.right, y1: y, y2: y }));
    g.append(s('text.tick', { x: PAD.left - 5, y: y + 3, 'text-anchor': 'end' }, String(Math.round(v))));
  }
  return g;
}

function svg(w, hh, label) {
  // 等比縮放（preserveAspectRatio 用預設值）。用 none 會把刻度文字橫向拉扁，
  // 為了幾個像素的高度精準度犧牲可讀性不划算。
  const node = s('svg.chart', { viewBox: `0 0 ${w} ${hh}`, role: 'img', 'aria-label': label });
  keepTicksLegible(node, w);
  return node;
}

/**
 * viewBox 固定 640 寬、元素卻是 width:100%，所以裡面的 font-size 會跟著等比縮放。
 * 手機上實測渲染寬度只有 309px，10px 的刻度字剩下 4.8px，等於沒有刻度。
 * 量出實際寬度反推一個補償字級，讓刻度在任何寬度都剛好是 10 CSS px。
 */
function keepTicksLegible(node, w) {
  if (typeof ResizeObserver !== 'function') return;
  new ResizeObserver(([entry]) => {
    const px = entry.contentRect.width;
    if (px > 0) node.style.setProperty('--tick', `${((10 * w) / px).toFixed(2)}px`);
  }).observe(node);
}

/**
 * 圖上方的一句說明。只有在同一個面板疊兩張圖、光看面板標題分不出誰是誰時才給。
 * 單圖面板的標題已經在 h2 上，再寫一次只是重複。
 */
function caption(text) {
  // aria-hidden：同樣的字已經在 svg 的 aria-label 裡，讀螢幕的人不需要聽兩次。
  return h('p.chart-cap', { text, 'aria-hidden': 'true' });
}

/**
 * 長條圖。可疊第二層（例如「複習」疊「新學」）。
 * @param {{label:string, x:string, a:number, b?:number}[]} data
 */
export function bars(data, { height = 150, aName = '', bName = '', title = '', cap = '' } = {}) {
  const w = 640;
  const maxY = niceMax(Math.max(1, ...data.map((d) => d.a + (d.b ?? 0))), 3);
  const sc = scaler({ w, h: height, maxY, count: data.length });
  const node = svg(w, height, title);
  node.append(frame(w, height, maxY));

  data.forEach((d, i) => {
    const x = sc.band(i);
    const bw = sc.bw;
    const hA = (d.a / maxY) * sc.ih;
    const hB = ((d.b ?? 0) / maxY) * sc.ih;
    const base = PAD.top + sc.ih;
    // 兩段疊著畫時中間留一道縫：accent 與 accent-mid 只差 1.9:1，貼在一起分不出界線。
    const seam = hA > 0 ? Math.min(1.5, hB / 2) : 0;
    if (hB > 0) node.append(s('rect.bar-2', { x, y: base - hA - hB, width: bw, height: hB - seam }));
    if (hA > 0) node.append(s('rect.bar', { x, y: base - hA, width: bw, height: hA }));
    node.append(s('title', {}, `${d.label}：${d.a}${d.b ? ` + ${d.b}` : ''}`));
  });

  node.append(s('line.axis', { x1: PAD.left, x2: w - PAD.right, y1: PAD.top + sc.ih, y2: PAD.top + sc.ih }));
  labelEnds(node, data, w, height);
  const box = h('div', {}, cap ? caption(cap) : null, node);
  if (aName) box.append(legend([[aName, 'var(--accent)'], bName && [bName, 'var(--accent-mid)']].filter(Boolean)));
  return box;
}

/** 折線圖 + 面積。用在推演曲線。 */
export function line(data, { height = 170, title = '', marks = [], cap = '' } = {}) {
  const w = 640;
  const maxY = niceMax(Math.max(1, ...data.map((d) => d.a)), 3);
  const sc = scaler({ w, h: height, maxY, count: data.length });
  const node = svg(w, height, title);
  node.append(frame(w, height, maxY));

  const pts = data.map((d, i) => `${sc.x(i).toFixed(1)},${sc.y(d.a).toFixed(1)}`);
  const base = PAD.top + sc.ih;
  node.append(s('path.area', { d: `M${sc.x(0)},${base} L${pts.join(' L')} L${sc.x(data.length - 1)},${base} Z` }));
  node.append(s('path.line', { d: `M${pts.join(' L')}` }));

  for (const m of marks) {
    const x = sc.x(m.at);
    node.append(s('line.marker', { x1: x, x2: x, y1: PAD.top, y2: base }));
    node.append(s('text.marker-t', {
      x: Math.min(x + 4, w - PAD.right - 40), y: PAD.top + 10,
    }, m.label));
  }

  node.append(s('line.axis', { x1: PAD.left, x2: w - PAD.right, y1: base, y2: base }));
  labelEnds(node, data, w, height);
  return h('div', {}, cap ? caption(cap) : null, node);
}

/** 只在兩端標日期。中間全標會糊成一片，而且沒人在讀。 */
function labelEnds(node, data, w, height) {
  if (!data.length) return;
  const y = height - 6;
  node.append(s('text.tick', { x: PAD.left, y, 'text-anchor': 'start' }, data[0].x ?? ''));
  if (data.length > 1) {
    node.append(s('text.tick', { x: w - PAD.right, y, 'text-anchor': 'end' }, data[data.length - 1].x ?? ''));
  }
}

function legend(pairs) {
  const box = h('div.legend');
  for (const [name, color] of pairs) {
    const dot = h(color === 'var(--sunken)' ? 'i.blank' : 'i');
    dot.style.background = color;
    box.append(h('span', {}, dot, name));
  }
  return box;
}

/**
 * 每日熱力圖。GitHub 那種格子，直向七格代表一週。
 * 分級用「相對於這段期間的最大值」而不是固定門檻，
 * 因為每個人的每日量差一個數量級，固定門檻對誰都不對。
 */
export function heatmap(daily, { weeks = 26, cap = '' } = {}) {
  const byDay = new Map(daily.map((d) => [d.day, d]));
  const max = Math.max(1, ...daily.map((d) => d.count));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  // 從「這週的週日」往回推 weeks 週，讓最後一欄永遠是本週。
  const end = new Date(today.getTime() + (6 - today.getDay()) * 86400000);
  const start = new Date(end.getTime() - (weeks * 7 - 1) * 86400000);

  const grid = h('div.heat', { role: 'img', 'aria-label': `最近 ${weeks} 週的每日作答量` });
  for (let t = start.getTime(); t <= end.getTime(); t += 86400000) {
    const d = new Date(t);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const row = byDay.get(key);
    const n = row?.count ?? 0;
    const cell = h('i', {
      title: n ? `${key}：${n} 張，答對 ${row.correct}` : `${key}：沒練`,
      dataset: { l: n === 0 ? '0' : String(Math.min(4, Math.ceil((n / max) * 4))) },
    });
    if (t > today.getTime()) cell.style.visibility = 'hidden';
    grid.append(cell);
  }
  return h('div', {}, cap ? caption(cap) : null, h('div.scroll-x', {}, grid));
}

/** 水平比例條，用在錯誤類型分布。 */
export function reasonBars(rows, labels, colors) {
  const total = rows.reduce((a, r) => a + r.count, 0) || 1;
  const box = h('div.reasons');
  for (const r of rows) {
    const fill = h('i');
    fill.style.width = `${(r.count / total) * 100}%`;
    fill.style.background = colors[r.reason] ?? 'var(--text-faint)';
    box.append(h('div.reason-row', {},
      h('span.lbl', { text: labels[r.reason] ?? r.reason }),
      h('div.track', {}, fill),
      h('span.n', { text: `${r.count}` }),
    ));
  }
  return box;
}
