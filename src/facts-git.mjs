/**
 * 事實檔有幾行還沒進 git。
 *
 * data/reviews.jsonl、data/checkins.jsonl 與 data/attempts.jsonl 都不可重建，
 * 而 repo 是它們唯一的異地備份。App 只負責追加，不會替人 commit——
 * 所以作答了一個月、一次都沒 commit 的話，那一個月只存在這台電腦上，doctor 卻照樣全綠。
 * 這支讓 doctor 說得出「有幾行只在這台電腦上」。
 *
 * 只用 node:child_process 呼叫系統的 git，不引套件。查不了（沒裝 git、不是 repo、
 * 還沒有任何 commit）一律回 null，由呼叫端決定要不要提；查不了不等於有問題。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const FACT_FILES = ['data/reviews.jsonl', 'data/checkins.jsonl', 'data/attempts.jsonl'];

function gitAt(root) {
  return (...args) => execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/**
 * @param {string} root repo 根目錄
 * @param {string[]} [files] 相對於 root 的路徑
 * @returns {null | Array<{file:string, added:number, removed:number, untracked:boolean}>}
 *          只列有差異的檔；空陣列代表全都已 commit。
 */
export function uncommittedFacts(root, files = FACT_FILES) {
  const git = gitAt(root);
  try {
    git('rev-parse', '--verify', 'HEAD');
  } catch {
    return null;
  }

  const out = [];
  for (const file of files) {
    // checkins.jsonl 第一次打卡才會建立，建立之後在 commit 之前都是 untracked，
    // git diff 看不到它，要另外數行。
    if (git('ls-files', '--', file).trim() === '') {
      const abs = path.join(root, file);
      if (!existsSync(abs)) continue;
      const lines = readFileSync(abs, 'utf8').split('\n').filter((l) => l.trim()).length;
      if (lines) out.push({ file, added: lines, removed: 0, untracked: true });
      continue;
    }
    // 對 HEAD 比，暫存區與工作區一起算：git add 了但沒 commit 的行一樣還沒有備份。
    const stat = git('diff', '--numstat', 'HEAD', '--', file).trim();
    if (!stat) continue;
    const [added, removed] = stat.split('\t').map(Number);
    if (added || removed) out.push({ file, added, removed, untracked: false });
  }
  return out;
}

/**
 * 事實檔有幾行還沒出現在指定的 git ref。
 *
 * `origin/main` 是「另一台機器拿得到」的最低可驗證門檻；只看 HEAD 會把尚未 push 的
 * commit 誤稱為已備份。沒有遠端 ref 時回 null，不把未知狀態說成安全。
 * 這裡刻意不連網：比的是本機快取的 refs/remotes，別處推過而本機沒 fetch 時會多報（保守），
 * 但遠端 repo 被刪時快取還在、會少報。要確定遠端真的有，用 `git ls-remote`。
 */
export function factsSinceRef(root, ref = 'origin/main', files = FACT_FILES) {
  const git = gitAt(root);
  try {
    git('rev-parse', '--verify', ref);
  } catch {
    return null;
  }

  const out = [];
  for (const file of files) {
    const abs = path.join(root, file);
    if (!existsSync(abs)) continue;
    const trackedAtRef = git('ls-tree', '-r', '--name-only', ref, '--', file).trim() !== '';
    if (!trackedAtRef) {
      const lines = readFileSync(abs, 'utf8').split('\n').filter((line) => line.trim()).length;
      if (lines) out.push({ file, added: lines, removed: 0, newSinceRef: true });
      continue;
    }
    const stat = git('diff', '--numstat', ref, '--', file).trim();
    if (!stat) continue;
    const [added, removed] = stat.split('\t').map(Number);
    if (added || removed) out.push({ file, added, removed, newSinceRef: false });
  }
  return out;
}
