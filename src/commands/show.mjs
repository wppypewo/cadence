import { openDb, getSession, resolveSessionId } from '../store.mjs';
import { dbPath } from '../paths.mjs';
import { readTranscript } from '../transcript.mjs';
import { CATEGORY_LABELS } from '../normalize.mjs';
import { intOpt } from '../cliargs.mjs';
import { c, bytes, num, date, ago, pct, truncate } from '../fmt.mjs';

export const spec = { flags: ['thinking', 'sidechain', 'meta', 'full'], alias: { n: 'limit' } };

export function help() {
  return `${c.bold('ccarchive show')} — 顯示單一 session

用法  ccarchive show <ID 前綴> [選項]

      --thinking    一併顯示思考內容
      --sidechain   一併顯示子代理訊息
      --meta        保留系統提醒等雜訊
  -n, --limit <n>   最多顯示幾則對話（預設 40，--full 表示全部）
      --json        JSON 輸出

ID 只要打前幾碼即可，例如 ccarchive show c17808`;
}

export async function run(args) {
  const prefix = args._[0];
  if (!prefix) throw new Error('請提供 session ID。用法：ccarchive show <ID 前綴>');

  const db = openDb(dbPath(args.out), { create: false });
  const id = resolveSessionId(db, String(prefix));
  if (!id) { db.close(); throw new Error(`找不到 session：${prefix}`); }
  const s = getSession(db, id);
  const lin = db.prepare('SELECT * FROM lineage WHERE session_id = ?').get(id);
  db.close();

  const { turns } = await readTranscript(s.file, {
    thinking: Boolean(args.thinking),
    sidechain: Boolean(args.sidechain),
    meta: Boolean(args.meta),
  });

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ session: s, lineage: lin, turns }, null, 2)}\n`);
    return 0;
  }

  const totalBytes = Object.values(s.bytesBy).reduce((a, b) => a + b, 0);
  const topCats = Object.entries(s.bytesBy).sort((a, b) => b[1] - a[1]).slice(0, 4)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${CATEGORY_LABELS[k] || k} ${pct(v, totalBytes)}`)
    .join(' · ');

  const head = [
    c.bold(s.title || '（無標題）'),
    `${c.dim('ID')}      ${s.id}`,
    `${c.dim('專案')}    ${s.cwd}`,
    `${c.dim('期間')}    ${date(s.first_ts)} → ${date(s.last_ts)}  ${c.dim(`(${ago(s.last_ts)})`)}`,
    `${c.dim('規模')}    ${num(s.msgs)} 則訊息（你 ${num(s.user_msgs)} · Claude ${num(s.asst_msgs)}${s.sidechain_msgs ? ` · 子代理 ${num(s.sidechain_msgs)}` : ''}） · ${bytes(s.size)}`,
    `${c.dim('組成')}    ${topCats}`,
  ];
  const models = Object.keys(s.models);
  if (models.length) head.push(`${c.dim('模型')}    ${models.join(', ')}`);
  const tk = s.tokens || {};
  if (tk.input || tk.output) {
    head.push(`${c.dim('token')}   輸入 ${num(tk.input)} · 輸出 ${num(tk.output)} · 快取讀 ${num(tk.cacheRead)}`);
  }
  const tools = Object.entries(s.tools).sort((a, b) => b[1] - a[1]).slice(0, 6);
  if (tools.length) head.push(`${c.dim('工具')}    ${tools.map(([k, v]) => `${k}×${v}`).join(' · ')}`);
  if (s.bad_lines) head.push(c.yellow(`損壞行  ${num(s.bad_lines)} 行已跳過`));
  if (lin && lin.role !== 'solo') {
    const rel = JSON.parse(lin.relatives || '[]');
    head.push(`${c.dim('分岔')}    ${lin.role} · 與 ${rel.length} 個 session 共用 ${num(lin.shared_msgs)} 則訊息`
      + (rel.length ? `\n        ${rel.slice(0, 4).map((r) => `${c.cyan(r.id.slice(0, 8))}(${r.shared})`).join(' ')}` : ''));
  }
  process.stdout.write(`${head.join('\n')}\n`);

  const limit = args.full ? turns.length : intOpt(args.limit, 40);
  const shown = turns.slice(0, limit);
  process.stdout.write(`\n${c.dim('─'.repeat(60))}\n`);
  for (const t of shown) {
    const who = t.role === 'user' ? c.magenta('▍你') : c.blue('▍Claude');
    process.stdout.write(`\n${who} ${c.dim(date(t.ts))}${t.sidechain ? c.dim(' ·子代理') : ''}\n`);
    for (const b of t.blocks) {
      switch (b.type) {
        case 'text':
          process.stdout.write(`${indent(b.text)}\n`);
          break;
        case 'thinking':
          process.stdout.write(`${c.dim(indent(b.text, '  ┆ '))}\n`);
          break;
        case 'tool_use':
          process.stdout.write(`  ${c.cyan(`⚒ ${b.name}`)} ${c.dim(truncate(oneLine(b.input), 70))}\n`);
          break;
        case 'tool_result':
          process.stdout.write(`  ${b.isError ? c.red('✗') : c.dim('↳')} ${c.dim(truncate(oneLine(b.text), 70))}\n`);
          break;
        case 'image':
          process.stdout.write(`  ${c.dim('[影像]')}\n`);
          break;
        default:
          break;
      }
    }
  }
  if (turns.length > shown.length) {
    process.stdout.write(c.dim(`\n… 另有 ${num(turns.length - shown.length)} 則未顯示（--full 看全部）\n`));
  }

  return 0;
}

function indent(text, prefix = '  ') {
  return String(text).split('\n').map((l) => prefix + l).join('\n');
}

function oneLine(v) {
  if (v === undefined || v === null) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.replace(/\s+/g, ' ').trim();
}
