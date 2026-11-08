// scripts/scheduled-backup.sh 的行為測試。
// 跑的是真的腳本，只把三個外部依賴換成假的：
//   security  → 印一個假密碼（不碰鑰匙圈）
//   osascript → 把收到的參數寫進檔案（不跳通知）
//   node      → CADENCE_NODE 指向假程式，往 --out 目錄追加一行事件（不連雲端）
// git 的全域與系統設定都隔離掉，避免使用者的簽章、hook 設定影響結果。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'scheduled-backup.sh');

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
};

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: { ...process.env, ...GIT_ENV }, encoding: 'utf8' }).trim();
}

function setup() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'cadence-sched-'));
  const bin = path.join(tmp, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'security'), '#!/bin/sh\necho fake-pass\n', { mode: 0o755 });
  // 每個參數一行，方便核對訊息是不是獨立的一個參數
  writeFileSync(path.join(bin, 'osascript'), '#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a"; done > "$OSA_LOG"\n', { mode: 0o755 });
  const fakeNode = path.join(bin, 'fake-node');
  writeFileSync(fakeNode, [
    '#!/bin/sh',
    'out=""',
    'while [ $# -gt 0 ]; do [ "$1" = "--out" ] && out="$2"; shift; done',
    'mkdir -p "$out" && echo \'{"id":"new"}\' >> "$out/review_events.jsonl"',
    '',
  ].join('\n'), { mode: 0o755 });

  // 資料 repo：已有一行事件
  const data = path.join(tmp, 'cadence-data');
  mkdirSync(path.join(data, 'data', 'cloud-backup'), { recursive: true });
  writeFileSync(path.join(data, 'data', 'cloud-backup', 'review_events.jsonl'), '{"id":"old"}\n');
  git(data, 'init', '-q');
  git(data, 'add', '.');
  git(data, 'commit', '-q', '-m', 'init');

  const osaLog = path.join(tmp, 'osa.log');
  const run = (dataRepo) => spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: {
      ...process.env, ...GIT_ENV,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      CADENCE_DATA_REPO: dataRepo,
      CADENCE_NODE: fakeNode,
      OSA_LOG: osaLog,
    },
  });
  return { tmp, data, osaLog, run, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
}

test('一般 clone：追加事件後 commit', () => {
  const t = setup();
  try {
    const r = t.run(t.data);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(git(t.data, 'log', '-1', '--format=%s'), /雲端備份/);
  } finally { t.cleanup(); }
});

test('cadence-data 是 git worktree（.git 是檔案）時照常備份', () => {
  const t = setup();
  try {
    const wt = path.join(t.tmp, 'data-wt');
    git(t.data, 'worktree', 'add', '-q', '-b', 'wt', wt);
    const r = t.run(wt);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(git(wt, 'log', '-1', '--format=%s'), /雲端備份/);
  } finally { t.cleanup(); }
});

test('指到某個 repo 底下的普通資料夾：拒絕，不 commit 進那個 repo', () => {
  const t = setup();
  try {
    const before = git(t.data, 'rev-parse', 'HEAD');
    const r = t.run(path.join(t.data, 'data'));
    assert.equal(r.status, 1);
    assert.match(r.stdout, /找不到 cadence-data/);
    assert.equal(git(t.data, 'rev-parse', 'HEAD'), before);
  } finally { t.cleanup(); }
});

test('worktree 的 index.lock 存在時不搶 index', () => {
  const t = setup();
  try {
    const wt = path.join(t.tmp, 'data-wt');
    git(t.data, 'worktree', 'add', '-q', '-b', 'wt', wt);
    const lock = path.resolve(wt, git(wt, 'rev-parse', '--git-path', 'index.lock'));
    writeFileSync(lock, '');
    const before = git(wt, 'rev-parse', 'HEAD');
    const r = t.run(wt);
    rmSync(lock);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /git 正在被使用/);
    assert.equal(git(wt, 'rev-parse', 'HEAD'), before);
  } finally { t.cleanup(); }
});

test('失敗訊息含雙引號時，整段以獨立參數交給 osascript，不嵌進 AppleScript 原始碼', () => {
  const t = setup();
  try {
    const missing = path.join(t.tmp, 'no"such');
    const r = t.run(missing);
    assert.equal(r.status, 1);
    assert.ok(existsSync(t.osaLog), '沒有呼叫 osascript');
    const args = readFileSync(t.osaLog, 'utf8').split('\n').filter(Boolean);
    const msg = args.at(-1);
    assert.match(msg, /找不到 cadence-data/);
    assert.ok(msg.includes('no"such'), msg);
    // -e 後面的 AppleScript 原始碼都不能含訊息內容
    const scripts = args.filter((a, i) => args[i - 1] === '-e');
    assert.ok(scripts.length > 0);
    for (const s of scripts) assert.ok(!s.includes('no"such'), s);
  } finally { t.cleanup(); }
});
