// 路徑解析：Claude Code 的存檔位置、專案目錄名稱與真實 cwd 的對應。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Claude Code 存放對話的根目錄。可用 CCARCHIVE_ROOT 覆寫（測試用）。 */
export function claudeRoot(override) {
  if (override) return path.resolve(override);
  if (process.env.CCARCHIVE_ROOT) return path.resolve(process.env.CCARCHIVE_ROOT);
  return path.join(os.homedir(), '.claude', 'projects');
}

/** 工具自己的輸出目錄，預設在當前工作目錄下，不寫入家目錄。 */
export function outDir(override) {
  if (override) return path.resolve(override);
  if (process.env.CCARCHIVE_OUT) return path.resolve(process.env.CCARCHIVE_OUT);
  return path.resolve('.ccarchive');
}

export function dbPath(out) {
  return path.join(outDir(out), 'index.db');
}

/**
 * 專案目錄名是把絕對路徑的 `/` 換成 `-`，例如
 * `/Users/ricky/ClaudeCode/projects` → `-Users-ricky-ClaudeCode-projects`。
 * 這個轉換不可逆（原本就含 `-` 的路徑會混淆），所以只能還原成「最可能」的路徑，
 * 並以實際存在與否驗證；驗證不過就標記 exact=false。
 */
export function decodeProjectDir(dirName) {
  const naive = dirName.replace(/-/g, '/');
  if (safeIsDir(naive)) return { cwd: naive, exact: true };
  const segs = dirName.replace(/^-+/, '').split('-').filter(Boolean);
  const hit = segs.length ? walk('', segs, 0, { steps: 0 }) : null;
  if (hit) return { cwd: hit, exact: true };
  return { cwd: naive, exact: false };
}

/**
 * 從根目錄逐段往下試。目錄名原本就有的 `-` 被編碼成跟分隔符一樣，
 * 所以每一層都要試「吃掉 1..n 段」的每種可能，走不通就回溯。
 * 先試吃一段，讓最常見的無連字號路徑走最短路徑。
 */
function walk(base, segs, i, budget) {
  if (i >= segs.length) return base;
  for (let take = 1; i + take <= segs.length; take++) {
    if (budget.steps++ > 20000) return null;
    const next = `${base}/${segs.slice(i, i + take).join('-')}`;
    if (!safeIsDir(next)) continue;
    const done = walk(next, segs, i + take, budget);
    if (done) return done;
  }
  return null;
}

function safeIsDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/** 顯示用的短名稱：取還原路徑的最後兩段。 */
export function shortProject(dirName) {
  const { cwd } = decodeProjectDir(dirName);
  const parts = cwd.split('/').filter(Boolean);
  return parts.slice(-2).join('/') || cwd;
}

export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}
