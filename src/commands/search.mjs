import { openDb } from '../store.mjs';
import { dbPath, shortProject } from '../paths.mjs';
import { parseSince, intOpt } from '../cliargs.mjs';
import { c, date, num, truncate } from '../fmt.mjs';

export const spec = { flags: ['sidechain'], alias: { n: 'limit', p: 'project', r: 'role' } };

// 命中片段的標記字元。用控制字元，避免與對話內容碰撞。
const MARK_START = '\u0001';
const MARK_END = '\u0002';

export function help() {
  return `${c.bold('ccarchive search')} — 全文檢索所有對話

用法  ccarchive search <關鍵字...> [選項]

  -r, --role <user|assistant>  只搜尋某一方的發言
  -p, --project <關鍵字>       限定專案
      --session <ID 前綴>      限定單一 session
      --since <時間>           只搜尋此時間後的訊息
      --sidechain              也搜尋子代理（subagent）的訊息，預設排除
  -n, --limit <數量>           最多幾筆（預設 20）
      --json                   JSON 輸出

索引使用 SQLite FTS5 的 trigram 分詞器，中文與英文都能做子字串比對，
但關鍵字至少要 3 個字元（中文 3 字、英文 3 字母）。
多個關鍵字之間是 AND；要找片語就用引號包起來。`;
}

export function run(args) {
  const terms = args._.filter((s) => s && s !== true).map(String);
  if (terms.length === 0) throw new Error('請提供搜尋關鍵字。用法：ccarchive search <關鍵字>');

  const db = openDb(dbPath(args.out), { create: false });
  const limit = intOpt(args.limit, 20);

  const where = ['m.text_len > 0'];
  const params = [];
  if (!args.sidechain) where.push('m.sidechain = 0');
  if (args.role && args.role !== true) {
    const role = String(args.role).toLowerCase();
    if (!['user', 'assistant'].includes(role)) throw new Error('--role 只能是 user 或 assistant');
    where.push('m.role = ?'); params.push(role);
  }
  if (args.session && args.session !== true) {
    where.push('m.session_id LIKE ?'); params.push(`${args.session}%`);
  }
  if (args.project && args.project !== true) {
    where.push('(s.cwd LIKE ? OR s.project LIKE ?)');
    params.push(`%${args.project}%`, `%${args.project}%`);
  }
  if (args.since) { where.push('m.ts >= ?'); params.push(parseSince(args.since)); }

  // trigram 索引至少需要 3 個字元；1–2 字的詞（服役、英國）改用 LIKE 補掃。
  const longTerms = terms.filter((t) => [...t].length >= 3);
  const shortTerms = terms.filter((t) => [...t].length < 3);
  for (const t of shortTerms) { where.push('f.text LIKE ?'); params.push(`%${escapeLike(t)}%` ); }
  const filter = where.join(' AND ');

  let rows, total;
  if (longTerms.length > 0) {
    const match = longTerms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' AND ');
    rows = db.prepare(`
      SELECT m.session_id, m.role, m.ts, m.sidechain, s.title, s.project,
             snippet(msg_fts, 0, ?, ?, '…', 64) AS snip, bm25(msg_fts) AS score
      FROM msg_fts f
      JOIN messages m ON m.rowid = f.rowid
      JOIN sessions s ON s.id = m.session_id
      WHERE f.msg_fts MATCH ? AND ${filter}
      ORDER BY score
      LIMIT ?`).all(MARK_START, MARK_END, match, ...params, limit);
    total = db.prepare(`
      SELECT count(*) AS n FROM msg_fts f
      JOIN messages m ON m.rowid = f.rowid
      JOIN sessions s ON s.id = m.session_id
      WHERE f.msg_fts MATCH ? AND ${filter}`).get(match, ...params).n;
    if (shortTerms.length) {
      rows = rows.map((r) => ({ ...r, snip: remark(r.snip, shortTerms) }));
    }
  } else {
    // 全為短詞：退回 LIKE 掃描，並自行擷取片段。
    rows = db.prepare(`
      SELECT m.session_id, m.role, m.ts, m.sidechain, s.title, s.project, f.text AS full
      FROM msg_fts f
      JOIN messages m ON m.rowid = f.rowid
      JOIN sessions s ON s.id = m.session_id
      WHERE ${filter}
      ORDER BY m.ts DESC
      LIMIT ?`).all(...params, limit).map((r) => ({ ...r, snip: makeSnippet(r.full, terms) }));
    total = db.prepare(`
      SELECT count(*) AS n FROM msg_fts f
      JOIN messages m ON m.rowid = f.rowid
      JOIN sessions s ON s.id = m.session_id
      WHERE ${filter}`).get(...params).n;
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify({
      query: terms,
      total,
      hits: rows.map((r) => ({
        session: r.session_id,
        title: r.title,
        role: r.role,
        ts: r.ts,
        project: r.project,
        snippet: strip(r.snip),
      })),
    }, null, 2)}\n`);
    db.close();
    return 0;
  }

  if (rows.length === 0) {
    process.stdout.write(`${c.dim(`「${terms.join(' ')}」沒有結果。`)}\n`);
    db.close();
    // 沿用 grep 的慣例：沒命中回 1，讓 shell 的 && / || 判斷得出來。
    // --json 是給程式吃的，空陣列本身就是答案，那條路徑一律回 0。
    return 1;
  }

  process.stdout.write(`${c.dim(`「${terms.join(' ')}」命中 ${num(total)} 則，顯示前 ${rows.length} 則`)}\n\n`);
  for (const r of rows) {
    const who = r.role === 'user' ? c.magenta('你') : c.blue('Claude');
    const tag = r.sidechain ? c.dim(' ·子代理') : '';
    process.stdout.write(
      `${c.cyan(r.session_id.slice(0, 8))} ${who}${tag} ${c.dim(`${date(r.ts)} · ${shortProject(r.project)}`)}\n`
      + `  ${c.dim(truncate(r.title || '（無標題）', 60))}\n`
      + `  ${highlight(r.snip)}\n\n`,
    );
  }
  process.stdout.write(c.dim('用 ccarchive show <ID> 看完整對話，ccarchive export <ID> 匯出 Markdown\n'));
  db.close();
  return 0;
}

function strip(s) {
  return String(s).split(MARK_START).join('').split(MARK_END).join('');
}

function highlight(s) {
  return String(s)
    .replace(/\s+/g, ' ')
    .split(MARK_START).join('\u001b[33m')
    .split(MARK_END).join('\u001b[0m');
}

function escapeLike(t) {
  return t.replace(/[%_\\]/g, (ch) => `\\${ch}`);
}

/** 在既有片段上補標記短詞（FTS 的 snippet 不會標它們）。 */
function remark(snip, shortTerms) {
  let out = String(snip);
  for (const t of shortTerms) out = out.split(t).join(MARK_START + t + MARK_END);
  return out;
}

/** LIKE 路徑自行擷取片段：以第一個命中位置為中心取上下文。 */
function makeSnippet(text, terms, radius = 60) {
  const s = String(text || '').replace(/\s+/g, ' ');
  let at = -1, hit = '';
  for (const t of terms) {
    const i = s.indexOf(t);
    if (i !== -1 && (at === -1 || i < at)) { at = i; hit = t; }
  }
  if (at === -1) return s.slice(0, radius * 2);
  const start = Math.max(0, at - radius);
  const end = Math.min(s.length, at + hit.length + radius);
  const body = s.slice(start, end);
  return (start > 0 ? '…' : '') + remark(body, terms) + (end < s.length ? '…' : '');
}
