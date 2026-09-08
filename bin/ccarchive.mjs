#!/usr/bin/env node
// ccarchive — Claude Code 對話存檔的索引、分岔分析、檢索與回收工具。
import process from 'node:process';
import { parseArgs } from '../src/cliargs.mjs';
import { c } from '../src/fmt.mjs';

const COMMANDS = {
  scan:    { mod: '../src/commands/scan.mjs',    desc: '掃描存檔建立／更新索引' },
  ls:      { mod: '../src/commands/ls.mjs',      desc: '列出 session（可依專案、時間、大小篩選）' },
  show:    { mod: '../src/commands/show.mjs',    desc: '顯示單一 session 的詳情與時間軸' },
  search:  { mod: '../src/commands/search.mjs',  desc: '全文檢索所有對話（中英文皆可）' },
  lineage: { mod: '../src/commands/lineage.mjs', desc: '分岔分析：哪些檔案是同一段對話的複本' },
  bloat:   { mod: '../src/commands/bloat.mjs',   desc: '空間分析：位元組去了哪裡' },
  orphans: { mod: '../src/commands/orphans.mjs', desc: '找出沒有對應對話檔的工具結果快取目錄' },
  reclaim: { mod: '../src/commands/reclaim.mjs', desc: '產生可回收清單（預設只計畫不動手）' },
  undo:    { mod: '../src/commands/undo.mjs',    desc: '還原先前 reclaim --apply 移走的檔案' },
  export:  { mod: '../src/commands/export.mjs',  desc: '把 session 匯出成 Markdown 或 JSON' },
  report:  { mod: '../src/commands/report.mjs',  desc: '產生單一 HTML 總覽報表' },
  stats:   { mod: '../src/commands/stats.mjs',   desc: '使用統計：活躍度、模型、工具、token' },
  doctor:  { mod: '../src/commands/doctor.mjs',  desc: '檢查環境與索引健康度' },
};

const USAGE = `${c.bold('ccarchive')} — Claude Code 對話存檔工具

${c.dim('用法')}  ccarchive <指令> [選項]

${c.dim('指令')}
${Object.entries(COMMANDS).map(([k, v]) => `  ${c.cyan(k.padEnd(9))} ${v.desc}`).join('\n')}

${c.dim('全域選項')}
  --root <路徑>   存檔根目錄（預設 ~/.claude/projects）
  --out <路徑>    索引與輸出目錄（預設 ./.ccarchive）
  --json          以 JSON 輸出，供其他工具串接
  --no-color      關閉顏色
  -h, --help      顯示說明

${c.dim('注意')}  除了 reclaim --apply 與 undo 之外，本工具對存檔目錄一律唯讀。

${c.dim('起步')}
  ccarchive scan          # 建索引
  ccarchive ls            # 看有哪些對話
  ccarchive search 北海道  # 找內容
  ccarchive report        # 產生 HTML 報表
`;

// 管線到 head/less 時對方會提早關閉 stdout，這不是錯誤，安靜結束就好。
process.stdout.on('error', (err) => { if (err.code === 'EPIPE') process.exit(0); });
process.stderr.on('error', (err) => { if (err.code === 'EPIPE') process.exit(0); });

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (cmd === '-v' || cmd === '--version') {
    const { version } = await readPkg();
    process.stdout.write(`${version}\n`);
    return 0;
  }
  const entry = COMMANDS[cmd];
  if (!entry) {
    process.stderr.write(`${c.red('未知指令')} ${cmd}\n\n${USAGE}\n`);
    return 2;
  }

  const rest = argv.slice(1);
  if (rest.includes('--help') || rest.includes('-h')) {
    const { help } = await import(entry.mod);
    process.stdout.write(`${help ? help() : entry.desc}\n`);
    return 0;
  }

  const { run, spec } = await import(entry.mod);
  const args = parseArgs(rest, mergeSpec(spec));
  return (await run(args)) ?? 0;
}

function mergeSpec(spec = {}) {
  return {
    ...spec,
    flags: ['json', 'color', 'full', ...(spec.flags || [])],
    alias: { h: 'help', ...(spec.alias || {}) },
  };
}

async function readPkg() {
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const p = fileURLToPath(new URL('../package.json', import.meta.url));
  return JSON.parse(await readFile(p, 'utf8'));
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    if (err?.code === 'ENOENT' && err.path) {
      process.stderr.write(`${c.red('找不到檔案')} ${err.path}\n`);
    } else {
      process.stderr.write(`${c.red('錯誤')} ${err?.message || err}\n`);
      if (process.env.CCARCHIVE_DEBUG) process.stderr.write(`${err?.stack}\n`);
    }
    process.exitCode = 1;
  });
