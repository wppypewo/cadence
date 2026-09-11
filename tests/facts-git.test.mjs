/**
 * doctor 的事實檔版控檢查。
 *
 * 在 os.tmpdir() 底下開一個一次性的 git repo 來測，不碰這個 repo 自己的 data/。
 * 機器上沒有 git 就跳過——那支函式本來就會在沒有 git 時回 null。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { uncommittedFacts } from '../src/facts-git.mjs';

let hasGit = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  hasGit = false;
}

/** 使用者的全域 git 設定可能要求簽章或跑 hook，這裡一律關掉，只留測試需要的東西。 */
function git(dir, ...args) {
  execFileSync('git', [
    '-C', dir, '-c', 'user.name=cadence-test', '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args,
  ], { stdio: 'ignore' });
}

test('沒有任何 commit 的目錄回 null：查不了不等於有問題', { skip: !hasGit }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cadence-git-'));
  try {
    assert.equal(uncommittedFacts(dir), null);
    git(dir, 'init', '-q');
    assert.equal(uncommittedFacts(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('數得出追加了幾行、少了幾行，還沒進版控的打卡與練習檔也算', { skip: !hasGit }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cadence-git-'));
  try {
    git(dir, 'init', '-q');
    mkdirSync(path.join(dir, 'data'));
    const reviews = path.join(dir, 'data', 'reviews.jsonl');
    writeFileSync(reviews, '{"a":1}\n{"a":2}\n');
    git(dir, 'add', 'data/reviews.jsonl');
    git(dir, 'commit', '-q', '-m', 'init');
    assert.deepEqual(uncommittedFacts(dir), []);

    appendFileSync(reviews, '{"a":3}\n');
    writeFileSync(path.join(dir, 'data', 'checkins.jsonl'), '{"skill":"CO"}\n{"skill":"PO"}\n');
    writeFileSync(path.join(dir, 'data', 'attempts.jsonl'), '{"type":"practice"}\n');
    assert.deepEqual(uncommittedFacts(dir), [
      { file: 'data/reviews.jsonl', added: 1, removed: 0, untracked: false },
      { file: 'data/checkins.jsonl', added: 2, removed: 0, untracked: true },
      { file: 'data/attempts.jsonl', added: 1, removed: 0, untracked: true },
    ]);

    // git add 了但沒 commit，一樣還沒備份。
    git(dir, 'add', 'data/reviews.jsonl');
    assert.equal(uncommittedFacts(dir)[0].added, 1);

    // 只增不改的檔少了行，要被看見。
    writeFileSync(reviews, '{"a":1}\n');
    assert.deepEqual(uncommittedFacts(dir)[0], { file: 'data/reviews.jsonl', added: 0, removed: 1, untracked: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
