import fs from 'node:fs';
import path from 'node:path';
import { openDb, getSession, resolveSessionId, allSessions } from '../store.mjs';
import { dbPath, outDir, ensureDir } from '../paths.mjs';
import { readTranscript } from '../transcript.mjs';
import { parseSince } from '../cliargs.mjs';
import { c, date, num, bytes } from '../fmt.mjs';

export const spec = { flags: ['thinking', 'sidechain', 'meta', 'stdout', 'all'], alias: { o: 'output', f: 'format', p: 'project' } };

export function help() {
  return `${c.bold('ccarchive export')} — 匯出對話

用法  ccarchive export <ID 前綴> [選項]
      ccarchive export --all [--project <關鍵字>] [--since <時間>]

  -f, --format <md|json>   輸出格式（預設 md）
  -o, --output <路徑>      輸出檔案或目錄（預設 <out>/export/）
      --stdout             直接印到標準輸出，不寫檔
      --thinking           包含思考內容
      --sidechain          包含子代理訊息
      --meta               包含系統提醒等雜訊
      --all                批次匯出所有（可搭配 --project / --since）

Markdown 會帶 YAML frontmatter，可直接丟進 Obsidian。`;
}

export async function run(args) {
  const db = openDb(dbPath(args.out), { create: false });
  const format = (args.format && args.format !== true ? String(args.format) : 'md').toLowerCase();
  if (!['md', 'markdown', 'json'].includes(format)) throw new Error('--format 只能是 md 或 json');
  const isJson = format === 'json';

  let targets;
  if (args.all) {
    targets = allSessions(db);
    if (args.project && args.project !== true) {
      const q = String(args.project).toLowerCase();
      targets = targets.filter((s) => (s.cwd || '').toLowerCase().includes(q));
    }
    if (args.since) {
      const since = parseSince(args.since);
      targets = targets.filter((s) => (s.last_ts || '') >= since);
    }
  } else {
    const prefix = args._[0];
    if (!prefix) { db.close(); throw new Error('請提供 session ID，或用 --all 批次匯出'); }
    const id = resolveSessionId(db, String(prefix));
    if (!id) { db.close(); throw new Error(`找不到 session：${prefix}`); }
    targets = [getSession(db, id)];
  }
  db.close();

  if (targets.length === 0) { process.stdout.write(`${c.dim('沒有符合條件的 session。')}\n`); return 1; }

  const opts = {
    thinking: Boolean(args.thinking),
    sidechain: Boolean(args.sidechain),
    meta: Boolean(args.meta),
    toolChars: 4000,
  };

  if (args.stdout) {
    for (const s of targets) {
      const { turns } = await readTranscript(s.file, opts);
      process.stdout.write(isJson ? `${JSON.stringify(toJson(s, turns), null, 2)}\n` : toMarkdown(s, turns));
    }
    return 0;
  }

  const explicitFile = args.output && args.output !== true && !args.all && /\.(md|json)$/i.test(String(args.output));
  const dir = explicitFile
    ? path.dirname(path.resolve(String(args.output)))
    : ensureDir(args.output && args.output !== true ? path.resolve(String(args.output)) : path.join(outDir(args.out), 'export'));
  ensureDir(dir);

  let written = 0, totalBytes = 0;
  for (const s of targets) {
    const { turns } = await readTranscript(s.file, opts);
    const body = isJson ? `${JSON.stringify(toJson(s, turns), null, 2)}\n` : toMarkdown(s, turns);
    const file = explicitFile
      ? path.resolve(String(args.output))
      : path.join(dir, `${fileStem(s)}.${isJson ? 'json' : 'md'}`);
    fs.writeFileSync(file, body, 'utf8');
    written++; totalBytes += Buffer.byteLength(body);
    if (!args.all) process.stdout.write(`${c.green('已匯出')} ${file}\n`);
  }
  if (args.all) {
    process.stdout.write(`${c.green('已匯出')} ${num(written)} 個 session · ${bytes(totalBytes)} → ${dir}\n`);
  }
  return 0;
}

function fileStem(s) {
  const d = (s.first_ts || '').slice(0, 10) || 'undated';
  const slug = String(s.title || 'untitled')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 50) || 'untitled';
  return `${d}-${slug}-${s.id.slice(0, 8)}`;
}

function toJson(s, turns) {
  return {
    id: s.id,
    title: s.title,
    project: s.cwd,
    firstTs: s.first_ts,
    lastTs: s.last_ts,
    messages: s.msgs,
    tokens: s.tokens,
    tools: s.tools,
    turns,
  };
}

function toMarkdown(s, turns) {
  const fm = [
    '---',
    `title: ${yamlStr(s.title || '未命名對話')}`,
    `session: ${s.id}`,
    `project: ${yamlStr(s.cwd || '')}`,
    `started: ${s.first_ts || ''}`,
    `ended: ${s.last_ts || ''}`,
    `messages: ${s.msgs}`,
    `source: claude-code`,
    `exported: ${new Date().toISOString()}`,
    '---',
    '',
    `# ${s.title || '未命名對話'}`,
    '',
    `> ${date(s.first_ts)} – ${date(s.last_ts)} · ${s.msgs} 則訊息 · \`${s.id}\``,
    '',
  ];
  const body = [];
  for (const t of turns) {
    body.push(`## ${t.role === 'user' ? '你' : 'Claude'} · ${date(t.ts)}${t.sidechain ? ' · 子代理' : ''}`, '');
    for (const b of t.blocks) {
      switch (b.type) {
        case 'text': body.push(b.text.trimEnd(), ''); break;
        case 'thinking': body.push('> [!note] 思考', ...b.text.split('\n').map((l) => `> ${l}`), ''); break;
        case 'tool_use': body.push(`\`\`\`json title="⚒ ${b.name}"`, JSON.stringify(b.input ?? {}, null, 2), '```', ''); break;
        case 'tool_result': body.push(`\`\`\`text title="${b.isError ? '✗ 錯誤' : '↳ 結果'}"`, b.text, '```', ''); break;
        case 'image': body.push('*（影像）*', ''); break;
        default: break;
      }
    }
  }
  return `${fm.join('\n')}${body.join('\n')}\n`;
}

function yamlStr(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
