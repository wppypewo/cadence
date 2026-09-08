// 終端輸出工具。表格必須對齊中文，所以需要東亞寬度計算。

const NO_COLOR = Boolean(process.env.NO_COLOR) || !process.stdout.isTTY;

const CODES = {
  reset: 0, bold: 1, dim: 2,
  red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, gray: 90,
};

function wrap(code) {
  return (s) => (NO_COLOR ? String(s) : `\x1b[${code}m${s}\x1b[0m`);
}
export const c = Object.fromEntries(Object.entries(CODES).map(([k, v]) => [k, wrap(v)]));

const ANSI = /\x1b\[[0-9;]*m/g;

/** 東亞全形字元占兩欄。範圍取自 Unicode East_Asian_Width = W/F。 */
export function displayWidth(str) {
  const s = String(str).replace(ANSI, '');
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp === 0x200b || (cp >= 0xfe00 && cp <= 0xfe0f)) continue;
    w += isWide(cp) ? 2 : 1;
  }
  return w;
}

function isWide(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/** 依顯示寬度截斷，超出補上省略號。 */
export function truncate(str, max) {
  const s = String(str ?? '');
  if (displayWidth(s) <= max) return s;
  let w = 0, out = '';
  for (const ch of s.replace(ANSI, '')) {
    const cw = isWide(ch.codePointAt(0)) ? 2 : 1;
    if (w + cw > max - 1) break;
    out += ch; w += cw;
  }
  return `${out}…`;
}

export function padEnd(str, width) {
  const pad = width - displayWidth(str);
  return pad > 0 ? str + ' '.repeat(pad) : str;
}

export function padStart(str, width) {
  const pad = width - displayWidth(str);
  return pad > 0 ? ' '.repeat(pad) + str : str;
}

/**
 * 畫表格。columns: [{ key, label, align, max }]
 */
export function table(rows, columns, { indent = '' } = {}) {
  if (rows.length === 0) return `${indent}${c.dim('（無資料）')}`;
  const cells = rows.map((r) => columns.map((col) => {
    const raw = col.value ? col.value(r) : String(r[col.key] ?? '');
    return col.max ? truncate(raw, col.max) : raw;
  }));
  const widths = columns.map((col, i) => Math.max(
    displayWidth(col.label || ''),
    ...cells.map((row) => displayWidth(row[i])),
  ));
  // 欄位全都沒有標題時就不要留一行空白表頭。
  const hasHead = columns.some((col) => col.label);
  const head = hasHead ? indent + columns
    .map((col, i) => c.dim(col.align === 'right' ? padStart(col.label, widths[i]) : padEnd(col.label, widths[i])))
    .join('  ').replace(/\s+$/, '') : null;
  const body = cells.map((row) => indent + row
    .map((s, i) => (columns[i].align === 'right' ? padStart(s, widths[i]) : padEnd(s, widths[i])))
    .join('  ').replace(/\s+$/, ''));
  return (hasHead ? [head, ...body] : body).join('\n');
}

export function bytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let x = v / 1024, i = 0;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
  return `${x < 10 ? x.toFixed(1) : Math.round(x)} ${units[i]}`;
}

export function num(n) {
  return Number(n || 0).toLocaleString('en-US');
}

export function pct(part, total) {
  if (!total) return '0%';
  const p = (part / total) * 100;
  return p < 0.1 && p > 0 ? '<0.1%' : `${p.toFixed(1)}%`;
}

/** 相對時間，中文。 */
export function ago(iso) {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const s = (Date.now() - t) / 1000;
  if (s < 60) return '剛剛';
  if (s < 3600) return `${Math.floor(s / 60)} 分鐘前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小時前`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} 天前`;
  if (s < 86400 * 365) return `${Math.floor(s / 86400 / 30)} 個月前`;
  return `${Math.floor(s / 86400 / 365)} 年前`;
}

export function date(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function day(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 純文字長條，供終端顯示占比。 */
export function bar(value, max, width = 24, ch = '█') {
  if (!max) return '';
  const n = Math.max(value > 0 ? 1 : 0, Math.round((value / max) * width));
  return ch.repeat(Math.min(n, width));
}

export function heading(text) {
  return `\n${c.bold(text)}\n${c.dim('─'.repeat(Math.min(displayWidth(text) + 2, 60)))}`;
}

/** 標籤／數值／註記三欄的摘要區塊，不畫表頭。 */
export function kv(rows, { indent = '  ', gap = '  ' } = {}) {
  const lw = Math.max(...rows.map((r) => displayWidth(String(r[0]))));
  // 只有帶註記的列需要對齊值欄；路徑之類的長值不該把註記推到天邊。
  const noted = rows.filter((r) => r[2]);
  const vw = noted.length ? Math.max(...noted.map((r) => displayWidth(String(r[1] ?? '')))) : 0;
  const right = vw <= 20;
  return rows.map(([label, value, note]) => {
    const v = String(value ?? '');
    const line = indent + c.dim(padEnd(String(label), lw)) + gap
      + (right ? padStart(v, vw) : padEnd(v, note ? vw : 0))
      + (note ? gap + c.dim(String(note)) : '');
    return line.replace(/\s+$/, '');
  }).join('\n');
}
