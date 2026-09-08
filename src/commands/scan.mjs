import { buildIndex } from '../../src/indexer.mjs';
import { bytes, c, num } from '../../src/fmt.mjs';

export const spec = { flags: ['quiet'] };

export function help() {
  return `${c.bold('ccarchive scan')} — 掃描存檔建立／更新索引

用法  ccarchive scan [--full] [--root <路徑>] [--out <路徑>] [--json]

  --full    忽略增量判斷，重新解析每個檔案
  --quiet   只輸出結果摘要

預設為增量：檔案大小與 mtime 都沒變就直接沿用既有索引。
本指令對存檔目錄唯讀，只寫入 --out 指定的索引目錄。`;
}

export async function run(args) {
  const started = Date.now();
  let last = 0;
  const onProgress = args.quiet || args.json ? undefined : (e) => {
    const now = Date.now();
    if (now - last < 80) return;
    last = now;
    process.stderr.write(`\r${c.dim(`解析中 ${e.done} 檔  ${e.id.slice(0, 8)}  ${bytes(e.size)}`)}\x1b[K`);
  };

  const res = await buildIndex({ root: args.root, out: args.out, full: args.full, onProgress });
  if (onProgress) process.stderr.write('\r\x1b[K');

  if (args.json) {
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    return 0;
  }

  process.stdout.write([
    `${c.green('索引完成')}  ${((Date.now() - started) / 1000).toFixed(1)}s`,
    `  來源      ${res.root}`,
    `  索引      ${res.db}`,
    `  專案      ${res.projects} 個`,
    `  對話檔    ${num(res.scanned)} 新解析 · ${num(res.skipped)} 未變動 · ${num(res.removed)} 已移除`,
    `  總大小    ${bytes(res.bytes)}`,
    `  快取目錄  ${res.sidecars} 個`,
    res.badLines ? `  ${c.yellow(`損壞行    ${num(res.badLines)} 行（已跳過）`)}` : null,
  ].filter(Boolean).join('\n') + '\n');
  return 0;
}
