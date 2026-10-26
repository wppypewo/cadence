/**
 * 用 demo/sources/ 的自製範例跑一個本機示範站：npm run demo。
 *
 * 為什麼需要：真正的題庫由五個外部來源建成，其中兩個是私有 repo，
 * 外人 clone 下來 npm run build 只會列出缺漏後停下。demo/sources/ 是照同樣格式
 * 自己寫的小份範例（約 200 張卡、七種題型都有），讓沒有那些來源的人也能把整個 App 跑起來看。
 *
 * 作答紀錄寫進一個暫存目錄，結束時刪掉，不碰 repo 的 data/。
 * 要保留示範時的作答，自己設 CADENCE_DATA（目錄裡要先有 bank/），這支就不建也不刪。
 * 其餘參數原樣交給 cadence serve，例如 npm run demo -- --port 5000 --no-open。
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES = path.join(ROOT, 'demo', 'sources');

// 五個來源一律指向範例，不沿用外面設的值：示範要的是可重現，不是混進真的題庫。
const env = {
  ...process.env,
  CADENCE_FEXGEN: path.join(SOURCES, 'fexgen'),
  CADENCE_VERBISTE: path.join(SOURCES, 'verbiste'),
  CADENCE_VAULT: path.join(SOURCES, 'vault'),
  CADENCE_PACKS: path.join(SOURCES, 'packs'),
  CADENCE_FLELEX: path.join(SOURCES, 'flelex'),
};

// 暫存目錄名刻意不叫 data：doctor 只對「某個 repo 底下的 data/」查版控。
const ownDir = !process.env.CADENCE_DATA;
const dataDir = ownDir ? mkdtempSync(path.join(tmpdir(), 'cadence-demo-')) : path.resolve(process.env.CADENCE_DATA);
if (ownDir) mkdirSync(path.join(dataDir, 'bank'));
env.CADENCE_DATA = dataDir;

process.stdout.write(`示範模式：題庫來自 demo/sources/，作答寫進 ${dataDir}${ownDir ? '（結束時刪除）' : ''}\n`);

const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'cadence.mjs'), 'serve', ...process.argv.slice(2)], {
  env,
  stdio: 'inherit',
});

// 訊號轉給子行程，由 cadence serve 自己收尾；這裡等它結束再清目錄。
// 終端機的 Ctrl-C 本來就會送到整個行程群組，再轉一次無妨（serve 第一次收到就結束）。
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));

child.on('exit', (code, signal) => {
  if (ownDir) rmSync(dataDir, { recursive: true, force: true });
  process.exit(code ?? (signal ? 1 : 0));
});
