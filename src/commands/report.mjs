// 產生單一自足的 HTML 報表。只讀索引，寫入一律在 --out 目錄內。
import fs from 'node:fs';
import path from 'node:path';
import { collect } from '../report/data.mjs';
import { renderHtml } from '../report/html.mjs';
import { outDir, claudeRoot, ensureDir } from '../paths.mjs';
import { c, bytes, num, kv, heading } from '../fmt.mjs';

export const spec = { flags: ['open'], alias: { o: 'output' } };

export function help() {
  return `${c.bold('ccarchive report')} — 產生單一 HTML 總覽報表

用法  ccarchive report [選項]

  -o, --output <檔案>  輸出路徑（預設 <out>/report.html）
      --open           產生後用系統預設程式開啟
      --json           改輸出報表用的原始資料（不產生 HTML）

${c.dim('說明')}
  報表是一個不依賴網路的 .html 檔：沒有 CDN、沒有字型外連、沒有圖表函式庫，
  離線與封閉環境都能開。內容全部來自索引，不重讀原始對話檔，
  也不會把任何一句對話文字寫進 HTML——只有標題、ID、大小與統計數字。

  產生前請先跑過 ccarchive scan。`;
}

export async function run(args) {
  const data = collect({ out: args.out, root: claudeRoot(args.root) });

  if (args.json) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return 0;
  }

  const dest = args.output && args.output !== true
    ? path.resolve(String(args.output))
    : path.join(outDir(args.out), 'report.html');
  ensureDir(path.dirname(dest));

  const html = renderHtml(data);
  fs.writeFileSync(dest, html, 'utf8');

  const t = data.totals;
  process.stdout.write(`${heading('報表已產生')}\n`);
  process.stdout.write(`${kv([
    ['檔案', dest],
    ['大小', bytes(Buffer.byteLength(html))],
    ['涵蓋', `${num(t.sessions)} 個 session`, `${num(t.msgs)} 則訊息 · ${bytes(t.bytes)}`],
    ['資料來源', data.root],
  ])}\n`);

  if (!data.scannedAt) {
    process.stdout.write(`\n  ${c.yellow('!')} 索引沒有掃描時間戳，數字可能來自很舊的一次掃描。\n`);
  }

  if (args.open) {
    const { spawn } = await import('node:child_process');
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    spawn(opener, [dest], { stdio: 'ignore', detached: true }).unref();
  } else {
    process.stdout.write(`\n  ${c.dim('開啟：')} open ${dest}\n`);
  }
  return 0;
}
