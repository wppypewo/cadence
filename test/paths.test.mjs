// 路徑：專案目錄名的還原是有損的，這裡測它在含連字號的真實路徑上能不能還原正確。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { decodeProjectDir, shortProject, outDir, dbPath, claudeRoot, ensureDir } from '../src/paths.mjs';
import { tmpRoot, rm } from './helpers.mjs';

/** 把絕對路徑編碼成 Claude Code 的專案目錄名。 */
function encode(p) { return p.replace(/\//g, '-'); }

test('沒有連字號的路徑直接還原', () => {
  const root = fs.realpathSync(tmpRoot('ccpaths'));
  const dir = ensureDir(path.join(root, 'plain', 'project'));
  try {
    const r = decodeProjectDir(encode(dir));
    assert.equal(r.exact, true);
    assert.equal(r.cwd, dir);
  } finally { rm(root); }
});

test('路徑中含連字號時，靠實際存在與否試出正確的合併點', () => {
  const root = fs.realpathSync(tmpRoot('ccpaths'));
  const dir = ensureDir(path.join(root, 'my-project'));
  try {
    const r = decodeProjectDir(encode(dir));
    assert.equal(r.exact, true, `應該還原成 ${dir}，實得 ${r.cwd}`);
    assert.equal(r.cwd, dir);
    assert.ok(fs.statSync(r.cwd).isDirectory());
  } finally { rm(root); }
});

test('多段都含連字號也要能還原', () => {
  const root = fs.realpathSync(tmpRoot('ccpaths'));
  const dir = ensureDir(path.join(root, 'a-b', 'c-d-e'));
  try {
    const r = decodeProjectDir(encode(dir));
    assert.equal(r.exact, true, `應該還原成 ${dir}，實得 ${r.cwd}`);
    assert.equal(r.cwd, dir);
  } finally { rm(root); }
});

test('目錄不存在時標記 exact=false，並回傳最直觀的猜測', () => {
  const r = decodeProjectDir('-nowhere-at-all-really-9f3c');
  assert.equal(r.exact, false);
  assert.equal(r.cwd, '/nowhere/at/all/really/9f3c');
});

test('shortProject 取末兩段，方便在表格裡顯示', () => {
  assert.equal(shortProject('-Users-ricky-ClaudeCode-projects'), 'ClaudeCode/projects');
  assert.equal(shortProject('-tmp'), 'tmp');
});

test('outDir 與 dbPath 以參數優先，不寫進家目錄', () => {
  const p = outDir('/tmp/cc-out-test');
  assert.equal(p, '/tmp/cc-out-test');
  assert.equal(dbPath('/tmp/cc-out-test'), '/tmp/cc-out-test/index.db');
  assert.ok(path.isAbsolute(outDir()), 'outDir() 必須回絕對路徑');
});

test('claudeRoot 可以被參數覆寫，預設落在 ~/.claude/projects', () => {
  assert.equal(claudeRoot('/tmp/fake-root'), '/tmp/fake-root');
  assert.match(claudeRoot(), /\.claude\/projects$/);
});
