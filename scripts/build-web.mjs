/**
 * Vercel 靜態建置。只複製瀏覽器需要的檔案，不把 data/ 或本機設定送進部署產物。
 */

import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT = path.join(ROOT, 'dist');

await rm(OUT, { recursive: true, force: true });
await cp(path.join(ROOT, 'web'), OUT, { recursive: true });
// 三份學習文件本來由本機 API 讀檔；雲端版改成同網域靜態資源，
// 仍只複製白名單需要的 study/，不把專案其餘檔案打包進網站。
await cp(path.join(ROOT, 'study'), path.join(OUT, 'study'), { recursive: true });
await mkdir(path.join(OUT, 'js', 'shared'), { recursive: true });
await cp(path.join(ROOT, 'src', 'engine', 'grade.mjs'), path.join(OUT, 'js', 'shared', 'grade.mjs'));
await writeFile(
  path.join(OUT, 'runtime-config.js'),
  "/** 由 scripts/build-web.mjs 產生；不含金鑰。 */\n"
    + "globalThis.CADENCE_RUNTIME = Object.freeze({ mode: 'cloud' });\n",
  'utf8',
);

console.log('cadence web build: dist/ ready');
