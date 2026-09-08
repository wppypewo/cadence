// CLI 冒煙測試：每個指令都真的跑一次。
// 這是唯一會抓到「指令改了但接線沒改」的測試，所以走子行程、用真的 bin。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { tmpRoot, rm, conversation, writeSession, writeSidecar } from './helpers.mjs';

const run = promisify(execFile);
const BIN = fileURLToPath(new URL('../bin/ccarchive.mjs', import.meta.url));
const PROJ = '-tmp-demo';

/** 跑一次 CLI，回傳 { code, stdout, stderr }。不讓非零退出直接拋錯。 */
async function cli(args, env) {
  try {
    const r = await run(process.execPath, [BIN, ...args], { env: { ...process.env, NO_COLOR: '1', ...env }, maxBuffer: 32 * 1024 * 1024 });
    return { code: 0, ...r };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

let root, out, env;

test('準備假存檔並建索引', async () => {
  root = tmpRoot('cccli');
  out = tmpRoot('ccout');
  env = { CCARCHIVE_ROOT: root, CCARCHIVE_OUT: out };
  const base = conversation({ session: 'S1', from: 0, turns: 5, prefix: '北海道行程' });
  writeSession(root, PROJ, 'S1', base);
  writeSession(root, PROJ, 'S2', [...base.slice(0, 6), ...conversation({ session: 'S2', from: 100, turns: 2, prefix: '分岔' })]);
  writeSidecar(root, PROJ, 'orphan-1', 2, 256);

  const r = await cli(['scan'], env);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(out, 'index.db')));
});

test('沒有參數時印出說明，退出碼 0', async () => {
  const r = await cli([], env);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /ccarchive/);
  assert.match(r.stdout, /唯讀/);
});

test('未知指令退出碼 2，並提示可用指令', async () => {
  const r = await cli(['nonsense'], env);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /未知指令/);
});

test('每個指令的 --help 都印得出來', async () => {
  const cmds = ['scan', 'ls', 'show', 'search', 'lineage', 'bloat', 'orphans', 'reclaim', 'undo', 'export', 'report', 'stats', 'doctor'];
  for (const cmd of cmds) {
    const r = await cli([cmd, '--help'], env);
    assert.equal(r.code, 0, `${cmd} --help 失敗：${r.stderr}`);
    assert.ok(r.stdout.trim().length > 20, `${cmd} --help 內容太短`);
  }
});

test('唯讀類指令跑得起來且輸出 JSON', async () => {
  for (const args of [['ls'], ['lineage'], ['bloat'], ['orphans'], ['stats'], ['doctor'], ['reclaim']]) {
    const r = await cli([...args, '--json'], env);
    assert.equal(r.code, 0, `${args.join(' ')} 失敗：${r.stderr}`);
    JSON.parse(r.stdout); // 解不開就會拋
  }
});

test('人類可讀輸出不含未替換的樣板或 undefined', async () => {
  for (const args of [['ls'], ['lineage'], ['bloat'], ['orphans'], ['stats'], ['doctor'], ['reclaim']]) {
    const r = await cli(args, env);
    assert.equal(r.code, 0, `${args.join(' ')} 失敗：${r.stderr}`);
    assert.ok(!/undefined|NaN|\[object Object\]/.test(r.stdout), `${args.join(' ')} 輸出有壞值：\n${r.stdout}`);
  }
});

test('search 找得到中文，也接受 --json', async () => {
  const r = await cli(['search', '北海道', '--json'], env);
  assert.equal(r.code, 0, r.stderr);
  const hits = JSON.parse(r.stdout);
  assert.ok((hits.hits ?? hits).length > 0, '應該搜得到北海道');
  // 沿用 grep 慣例：人類模式下沒命中回 1，--json 一律回 0。
  const empty = await cli(['search', '不存在的關鍵字zzz'], env);
  assert.equal(empty.code, 1);
  assert.match(empty.stdout, /沒有結果/);
  const emptyJson = await cli(['search', '不存在的關鍵字zzz', '--json'], env);
  assert.equal(emptyJson.code, 0);
  assert.deepEqual(JSON.parse(emptyJson.stdout).hits, []);
});

test('show 用 id 前綴看單一 session', async () => {
  const r = await cli(['show', 'S1'], env);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /S1/);
  const bad = await cli(['show', '不存在的ID'], env);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /找不到/);
});

test('export 產出 Markdown 與 JSON，寫在 --out 之內', async () => {
  const md = await cli(['export', 'S1', '--stdout'], env);
  assert.equal(md.code, 0, md.stderr);
  assert.match(md.stdout, /北海道行程/);

  const js = await cli(['export', 'S1', '--stdout', '--format', 'json'], env);
  assert.equal(js.code, 0, js.stderr);
  const doc = JSON.parse(js.stdout);
  assert.equal(doc.id, 'S1');
  assert.ok(Array.isArray(doc.turns) && doc.turns.length > 0);

  const toFile = await cli(['export', 'S1'], env);
  assert.equal(toFile.code, 0, toFile.stderr);
  const written = fs.readdirSync(path.join(out, 'export'));
  assert.ok(written.some((f) => f.endsWith('.md')), `export 目錄內容：${written.join(',')}`);
});

test('report 產出單一 HTML 檔', async () => {
  const r = await cli(['report'], env);
  assert.equal(r.code, 0, r.stderr);
  const html = fs.readFileSync(path.join(out, 'report.html'), 'utf8');
  assert.ok(html.startsWith('<!doctype html>') || html.startsWith('<!DOCTYPE html>'));
  assert.ok(!/https?:\/\//i.test(html));
});

test('reclaim 預設不動檔案', async () => {
  const before = fs.readdirSync(path.join(root, PROJ)).sort();
  const r = await cli(['reclaim'], env);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(fs.readdirSync(path.join(root, PROJ)).sort(), before);
  assert.match(r.stdout, /沒有任何檔案被動過|要執行/);
});

test('reclaim --apply 少了 --yes 會被擋下', async () => {
  const before = fs.readdirSync(path.join(root, PROJ)).sort();
  const r = await cli(['reclaim', '--apply'], env);
  assert.equal(r.code, 2);
  assert.deepEqual(fs.readdirSync(path.join(root, PROJ)).sort(), before);
});

test('--version 印出版本號', async () => {
  const r = await cli(['--version'], env);
  assert.equal(r.code, 0);
  assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test('索引不存在時給出可行動的錯誤訊息', async () => {
  const blank = tmpRoot('ccblank');
  try {
    const r = await cli(['ls'], { CCARCHIVE_ROOT: root, CCARCHIVE_OUT: blank });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /請先執行 ccarchive scan/);
  } finally { rm(blank); }
});

test('收尾：清掉暫存目錄', () => {
  rm(root); rm(out);
  assert.ok(!fs.existsSync(root));
});
