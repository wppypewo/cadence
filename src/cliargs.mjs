// 極簡參數解析。只支援本工具需要的形式，不引入第三方套件。
export function parseArgs(argv, spec = {}) {
  const flags = new Set(spec.flags || []);
  const aliases = spec.alias || {};
  const out = { _: [], ...(spec.defaults || {}) };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (a === '--') { out._.push(...argv.slice(i + 1)); break; }
    if (!a.startsWith('-') || a === '-') { out._.push(a); continue; }
    let key, value = null;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) { key = a.slice(2, eq); value = a.slice(eq + 1); }
      else key = a.slice(2);
    } else {
      key = a.slice(1);
    }
    let negated = false;
    if (key.startsWith('no-')) { negated = true; key = key.slice(3); }
    key = aliases[key] || key;
    if (flags.has(key)) { out[camel(key)] = !negated; continue; }
    if (value === null) {
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith('-') && next !== '-' && Number.isNaN(Number(next)))) {
        out[camel(key)] = true;
        continue;
      }
      value = next; i++;
    }
    const ck = camel(key);
    if (ck in out && Array.isArray(out[ck])) out[ck].push(value);
    else out[ck] = value;
  }
  return out;
}

function camel(s) {
  return s.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
}

export function intOpt(v, fallback) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** 解析 --since 這類時間參數：ISO 日期、或 7d / 3w / 2m / 1y。 */
export function parseSince(v) {
  if (!v || v === true) return null;
  const rel = /^(\d+)\s*([dwmy])$/i.exec(String(v).trim());
  if (rel) {
    const n = Number(rel[1]);
    const days = { d: 1, w: 7, m: 30, y: 365 }[rel[2].toLowerCase()];
    return new Date(Date.now() - n * days * 86400000).toISOString();
  }
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new Error(`無法解析時間：${v}（可用 2026-08-01 或 7d / 3w / 2m / 1y）`);
  return new Date(t).toISOString();
}
