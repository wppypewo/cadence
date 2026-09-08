import { openDb, allSessions } from '../store.mjs';
import { dbPath, shortProject } from '../paths.mjs';
import { parseSince, intOpt } from '../cliargs.mjs';
import { table, bytes, c, ago, truncate, num } from '../fmt.mjs';

export const spec = { flags: ['all', 'reverse'], alias: { n: 'limit', p: 'project', s: 'sort' } };

export function help() {
  return `${c.bold('ccarchive ls')} — 列出 session

用法  ccarchive ls [選項]

  -p, --project <關鍵字>   只列出專案路徑含此關鍵字者
      --since <時間>       只列出此時間後有活動者（2026-08-01 或 7d/3w/2m/1y）
      --min-size <位元組>  只列出大於此大小者（支援 5MB / 500KB）
  -s, --sort <欄位>        time | size | msgs | tokens（預設 time）
      --reverse            反向排序
  -n, --limit <數量>       最多列出幾筆（預設 30，--all 表示全部）
      --all                不限筆數
      --json               JSON 輸出

欄位說明
  ID    session 檔名前 8 碼，可直接餵給 show / export
  分岔  primary＝群組中最完整的一份，fork＝與他人重複，solo＝獨立`;
}

export function run(args) {
  const db = openDb(dbPath(args.out), { create: false });
  let rows = allSessions(db);

  if (args.project && args.project !== true) {
    const q = String(args.project).toLowerCase();
    rows = rows.filter((r) => (r.cwd || '').toLowerCase().includes(q) || (r.project || '').toLowerCase().includes(q));
  }
  if (args.since) {
    const since = parseSince(args.since);
    rows = rows.filter((r) => (r.last_ts || '') >= since);
  }
  if (args.minSize) {
    const min = parseSize(args.minSize);
    rows = rows.filter((r) => r.size >= min);
  }

  const lineage = new Map(db.prepare('SELECT session_id, role, group_id, redundant_bytes FROM lineage').all().map((r) => [r.session_id, r]));

  const sortKey = args.sort && args.sort !== true ? String(args.sort) : 'time';
  const cmp = {
    time: (a, b) => String(b.last_ts || '').localeCompare(String(a.last_ts || '')),
    size: (a, b) => b.size - a.size,
    msgs: (a, b) => b.msgs - a.msgs,
    tokens: (a, b) => totalTokens(b) - totalTokens(a),
  }[sortKey];
  if (!cmp) throw new Error(`未知排序欄位：${sortKey}（可用 time / size / msgs / tokens）`);
  rows.sort(cmp);
  if (args.reverse) rows.reverse();

  const limit = args.all ? rows.length : intOpt(args.limit, 30);
  const shown = rows.slice(0, limit);

  if (args.json) {
    process.stdout.write(`${JSON.stringify(shown.map((r) => ({
      id: r.id, project: r.cwd, title: r.title, lastTs: r.last_ts, size: r.size,
      msgs: r.msgs, userMsgs: r.user_msgs, tokens: totalTokens(r),
      lineage: lineage.get(r.id)?.role || 'solo',
    })), null, 2)}\n`);
    db.close();
    return 0;
  }

  process.stdout.write(`${table(shown, [
    { key: 'id', label: 'ID', value: (r) => c.cyan(r.id.slice(0, 8)) },
    { key: 'last_ts', label: '最後活動', value: (r) => ago(r.last_ts) },
    { key: 'project', label: '專案', value: (r) => shortProject(r.project), max: 26 },
    { key: 'msgs', label: '訊息', align: 'right', value: (r) => num(r.msgs) },
    { key: 'size', label: '大小', align: 'right', value: (r) => bytes(r.size) },
    { key: 'lineage', label: '分岔', value: (r) => roleLabel(lineage.get(r.id)?.role) },
    { key: 'title', label: '標題', value: (r) => truncate(r.title || c.dim('（無標題）'), 44) },
  ])}\n`);

  const hidden = rows.length - shown.length;
  const totalBytes = rows.reduce((s, r) => s + r.size, 0);
  process.stdout.write(c.dim(`\n${num(rows.length)} 個 session · ${bytes(totalBytes)}${hidden > 0 ? ` · 另有 ${num(hidden)} 筆未顯示（--all 看全部）` : ''}\n`));
  db.close();
  return 0;
}

function roleLabel(role) {
  switch (role) {
    case 'primary': return c.green('primary');
    case 'fork': return c.yellow('fork');
    case 'subsumed': return c.red('subsumed');
    default: return c.dim('solo');
  }
}

function totalTokens(r) {
  const t = r.tokens || {};
  return (t.input || 0) + (t.output || 0);
}

export function parseSize(v) {
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i.exec(String(v).trim());
  if (!m) throw new Error(`無法解析大小：${v}（可用 500KB / 5MB）`);
  const mult = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[(m[2] || 'b').toLowerCase()];
  return Math.round(Number(m[1]) * mult);
}
