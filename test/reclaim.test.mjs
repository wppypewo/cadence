// 回收與還原。這是整套工具唯一會動到檔案的路徑，所以測得比較細：
// 預設唯讀、--apply 只搬不刪、undo 能原樣搬回、磁碟與索引不符時要拒絕動手。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildIndex } from '../src/indexer.mjs';
import * as reclaim from '../src/commands/reclaim.mjs';
import * as undo from '../src/commands/undo.mjs';
import { tmpRoot, rm, conversation, writeSession, writeSidecar } from './helpers.mjs';

const PROJ = '-tmp-demo';

/** 吃掉指令的終端輸出，只留回傳值與檔案系統的結果。 */
async function quiet(fn) {
  const real = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  let buf = '';
  process.stdout.write = (s) => { buf += s; return true; };
  process.stderr.write = (s) => { buf += s; return true; };
  try { return { code: await fn(), out: buf }; }
  finally { process.stdout.write = real; process.stderr.write = realErr; }
}

/** 假存檔：S1 主線、S4 完全被 S1 包含（subsumed）、一個孤兒快取、一個有主快取。 */
async function fixture() {
  const root = tmpRoot('ccreclaim');
  const out = tmpRoot('ccout');
  const base = conversation({ session: 'S1', from: 0, turns: 6, prefix: '主線' });
  writeSession(root, PROJ, 'S1', base);
  writeSession(root, PROJ, 'S4', base.slice(0, 4));   // 每一則都在 S1 裡
  writeSidecar(root, PROJ, 'S1', 2, 300);
  const orphanDir = writeSidecar(root, PROJ, 'orphan-1', 3, 400);
  fs.mkdirSync(path.join(root, PROJ, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(root, PROJ, 'memory', 'keep.md'), '永遠不能被搬走');
  await buildIndex({ root, out });
  return { root, out, orphanDir, s4: path.join(root, PROJ, 'S4.jsonl') };
}

test('預設只出計畫，一個檔案都不動', async () => {
  const { root, out, orphanDir, s4 } = await fixture();
  try {
    const { code, out: text } = await quiet(() => reclaim.run({ root, out, json: true, _: [] }));
    assert.equal(code, 0);
    const plan = JSON.parse(text);
    assert.equal(plan.items.length, 2);
    assert.deepEqual(plan.items.map((i) => i.kind).sort(), ['session', 'sidecar']);
    assert.ok(plan.totalBytes > 0);
    assert.ok(fs.existsSync(orphanDir), '計畫階段不得動到孤兒目錄');
    assert.ok(fs.existsSync(s4), '計畫階段不得動到 session 檔');
    assert.ok(!fs.existsSync(path.join(out, 'quarantine')), '計畫階段不該建隔離區');
  } finally { rm(root); rm(out); }
});

test('--apply 沒有 --yes 一律拒絕', async () => {
  const { root, out, orphanDir } = await fixture();
  try {
    const { code, out: text } = await quiet(() => reclaim.run({ root, out, apply: true, _: [] }));
    assert.equal(code, 2);
    assert.match(text, /拒絕執行/);
    assert.ok(fs.existsSync(orphanDir));
  } finally { rm(root); rm(out); }
});

test('--apply --yes 是搬到隔離區，不是刪除；undo 能原樣搬回', async () => {
  const { root, out, orphanDir, s4 } = await fixture();
  try {
    const before = fs.readFileSync(s4, 'utf8');
    const { code } = await quiet(() => reclaim.run({ root, out, apply: true, yes: true, _: [] }));
    assert.equal(code, 0);

    assert.ok(!fs.existsSync(orphanDir), '孤兒目錄應已搬離原位');
    assert.ok(!fs.existsSync(s4), 'subsumed 的 session 檔應已搬離原位');

    const plans = fs.readdirSync(path.join(out, 'quarantine'));
    assert.equal(plans.length, 1);
    const planId = plans[0];
    const manifest = JSON.parse(fs.readFileSync(path.join(out, 'quarantine', planId, 'manifest.json'), 'utf8'));
    assert.equal(manifest.entries.length, 2);
    assert.ok(manifest.entries.every((e) => e.status === 'moved'));
    for (const e of manifest.entries) {
      assert.ok(fs.existsSync(e.to), `隔離區裡應該找得到 ${e.id}`);
      assert.equal(e.from, e.kind === 'session' ? s4 : orphanDir);
    }

    const back = await quiet(() => undo.run({ out, _: [planId] }));
    assert.equal(back.code, 0);
    assert.ok(fs.existsSync(s4), 'undo 之後 session 檔要回到原位');
    assert.equal(fs.readFileSync(s4, 'utf8'), before, '還原的內容必須逐字相同');
    assert.ok(fs.existsSync(orphanDir));
    assert.equal(fs.readdirSync(orphanDir).length, 3);

    const after = JSON.parse(fs.readFileSync(path.join(out, 'quarantine', planId, 'manifest.json'), 'utf8'));
    assert.ok(after.entries.every((e) => e.status === 'restored'));
  } finally { rm(root); rm(out); }
});

test('memory/ 的內容不會出現在任何計畫裡', async () => {
  const { root, out } = await fixture();
  try {
    const { out: text } = await quiet(() => reclaim.run({ root, out, json: true, _: [] }));
    const plan = JSON.parse(text);
    assert.ok(plan.items.every((i) => !i.path.includes('/memory')), 'memory/ 必須被排除');
    const memFile = path.join(root, PROJ, 'memory', 'keep.md');
    await quiet(() => reclaim.run({ root, out, apply: true, yes: true, _: [] }));
    assert.ok(fs.existsSync(memFile), 'memory/ 的檔案必須原封不動');
  } finally { rm(root); rm(out); }
});

test('磁碟現況與索引不符時跳過，不硬搬', async () => {
  const { root, out, orphanDir, s4 } = await fixture();
  try {
    fs.appendFileSync(s4, '\n');                                   // session 大小變了
    fs.writeFileSync(path.join(orphanDir, 'extra.json'), 'zzz');   // 快取目錄多了檔案
    const { out: text } = await quiet(() => reclaim.run({ root, out, apply: true, yes: true, _: [] }));
    assert.match(text, /跳過/);
    assert.ok(fs.existsSync(s4));
    assert.ok(fs.existsSync(orphanDir));
    const planId = fs.readdirSync(path.join(out, 'quarantine'))[0];
    const manifest = JSON.parse(fs.readFileSync(path.join(out, 'quarantine', planId, 'manifest.json'), 'utf8'));
    assert.ok(manifest.entries.every((e) => e.status === 'skipped'));
    assert.ok(manifest.entries.every((e) => /改變|請重新 scan/.test(e.reason)));
  } finally { rm(root); rm(out); }
});

test('--orphans 與 --subsumed 各自只挑一種', async () => {
  const { root, out } = await fixture();
  try {
    const a = JSON.parse((await quiet(() => reclaim.run({ root, out, json: true, orphans: true, _: [] }))).out);
    assert.deepEqual(a.items.map((i) => i.kind), ['sidecar']);
    const b = JSON.parse((await quiet(() => reclaim.run({ root, out, json: true, subsumed: true, _: [] }))).out);
    assert.deepEqual(b.items.map((i) => i.kind), ['session']);
  } finally { rm(root); rm(out); }
});

test('undo --list 在沒有任何批次時也不報錯', async () => {
  const out = tmpRoot('ccout');
  try {
    const { code, out: text } = await quiet(() => undo.run({ out, list: true, _: [] }));
    assert.equal(code, 0);
    assert.match(text, /沒有任何隔離批次/);
    const j = JSON.parse((await quiet(() => undo.run({ out, list: true, json: true, _: [] }))).out);
    assert.deepEqual(j, []);
  } finally { rm(out); }
});

test('undo 到不存在的批次要明確報錯', async () => {
  const out = tmpRoot('ccout');
  try {
    await assert.rejects(() => undo.run({ out, _: ['20260101-000000'] }), /找不到隔離批次/);
  } finally { rm(out); }
});

test('原位置已有同名檔案時，undo 跳過而不是覆蓋', async () => {
  const { root, out, s4 } = await fixture();
  try {
    await quiet(() => reclaim.run({ root, out, apply: true, yes: true, subsumed: true, _: [] }));
    assert.ok(!fs.existsSync(s4));
    fs.writeFileSync(s4, '後來有人在原位置放了新檔案');
    const { out: text } = await quiet(() => undo.run({ out, _: [fs.readdirSync(path.join(out, 'quarantine'))[0]] }));
    assert.match(text, /不覆蓋/);
    assert.equal(fs.readFileSync(s4, 'utf8'), '後來有人在原位置放了新檔案');
  } finally { rm(root); rm(out); }
});
