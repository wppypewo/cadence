// 端到端：在暫存目錄造一個假存檔，跑完整的 scan → 索引 → 報表資料。
// 全程不碰真的 ~/.claude。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildIndex } from '../src/indexer.mjs';
import { openDb, allSessions, getMeta, resolveSessionId } from '../src/store.mjs';
import { dbPath } from '../src/paths.mjs';
import { collect } from '../src/report/data.mjs';
import {
  tmpRoot, rm, uuid, conversation, userLine, asstLine, writeSession, writeSidecar,
} from './helpers.mjs';

const PROJ = '-tmp-demo';

/** 造一個假存檔：一組分岔、一個獨立 session、一個孤兒快取目錄。 */
function fixture() {
  const root = tmpRoot('ccindex');
  const out = tmpRoot('ccout');

  const base = conversation({ session: 'S1', from: 0, turns: 5, prefix: '主線' });
  writeSession(root, PROJ, 'S1', base);

  // S2 是 /resume 出來的分岔：複製前 6 則，再自己續寫
  const forked = [...base.slice(0, 6), ...conversation({ session: 'S2', from: 100, turns: 2, prefix: '分岔' })];
  writeSession(root, PROJ, 'S2', forked);

  // S3 完全獨立，帶思考、工具呼叫與一行壞掉的 JSON
  const solo = [
    userLine({ id: uuid(500), parent: null, text: '幫我查北海道的雪季', ts: '2026-02-01T09:00:00.000Z', session: 'S3' }),
    asstLine({ id: uuid(501), parent: uuid(500), text: '好的，我查一下。', ts: '2026-02-01T09:00:01.000Z', session: 'S3', thinking: '先確認日期範圍', tool: { name: 'WebSearch', input: { query: '北海道 雪季' } } }),
  ];
  const file = writeSession(root, PROJ, 'S3', solo);
  fs.appendFileSync(file, '{這行是壞的\n');

  writeSidecar(root, PROJ, 'S1', 2, 300);          // 有主
  writeSidecar(root, PROJ, 'deadbeef-orphan', 3, 400); // 孤兒
  fs.mkdirSync(path.join(root, PROJ, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(root, PROJ, 'memory', 'note.md'), '不可以被當成快取目錄');

  return { root, out };
}

test('掃描一個假存檔，索引內容與磁碟相符', async () => {
  const { root, out } = fixture();
  try {
    const stats = await buildIndex({ root, out });
    assert.equal(stats.scanned, 3);
    assert.equal(stats.projects, 1);
    assert.equal(stats.badLines, 1, '壞行要被算到，而不是讓掃描失敗');

    const db = openDb(dbPath(out), { create: false });
    const sessions = allSessions(db);
    assert.equal(sessions.length, 3);

    const s1 = sessions.find((s) => s.id === 'S1');
    assert.equal(s1.msgs, 10);
    assert.equal(s1.user_msgs, 5);
    assert.equal(s1.asst_msgs, 5);
    assert.equal(s1.size, fs.statSync(s1.file).size, '索引記的大小要等於磁碟上的大小');

    const s3 = sessions.find((s) => s.id === 'S3');
    assert.equal(s3.bad_lines, 1);
    assert.equal(s3.tools.WebSearch, 1);
    assert.equal(s3.models['claude-opus-5'], 1);
    assert.equal(s3.title, '幫我查北海道的雪季', '沒有標題行時用第一則使用者訊息當標題');
    assert.ok(s3.tokens.cacheRead > 0);
    db.close();
  } finally { rm(root); rm(out); }
});

test('位元組歸因加總等於全部檔案的實際大小', async () => {
  const { root, out } = fixture();
  try {
    await buildIndex({ root, out });
    const db = openDb(dbPath(out), { create: false });
    const sessions = allSessions(db);
    db.close();
    for (const s of sessions) {
      const total = Object.values(s.bytesBy).reduce((a, b) => a + b, 0);
      const onDisk = fs.statSync(s.file).size;
      // 差額只可能是每行的換行字元。
      assert.ok(Math.abs(onDisk - total) <= s.lines, `${s.id}: 歸因 ${total} vs 磁碟 ${onDisk}`);
    }
  } finally { rm(root); rm(out); }
});

test('分岔關係被算出來：S1 是 primary，S2 是 fork，S3 是 solo', async () => {
  const { root, out } = fixture();
  try {
    await buildIndex({ root, out });
    const db = openDb(dbPath(out), { create: false });
    const lin = new Map(db.prepare('SELECT * FROM lineage').all().map((r) => [r.session_id, r]));
    db.close();
    assert.equal(lin.get('S1').role, 'primary');
    assert.equal(lin.get('S2').role, 'fork');
    assert.equal(lin.get('S3').role, 'solo');
    assert.equal(lin.get('S1').group_id, lin.get('S2').group_id);
    assert.equal(lin.get('S1').redundant_bytes, 0);
    assert.ok(lin.get('S2').redundant_bytes > 0, 'S2 複製來的 6 則要算成重複');
    assert.equal(lin.get('S2').shared_msgs, 6);
    assert.equal(lin.get('S2').unique_msgs, 4);
  } finally { rm(root); rm(out); }
});

test('快取目錄有沒有主人分得出來，memory/ 不會被當成快取', async () => {
  const { root, out } = fixture();
  try {
    await buildIndex({ root, out });
    const db = openDb(dbPath(out), { create: false });
    const rows = db.prepare('SELECT * FROM sidecars ORDER BY id').all();
    db.close();
    assert.equal(rows.length, 2, `memory/ 必須被排除，實得 ${rows.map((r) => r.id).join(',')}`);
    const orphan = rows.find((r) => r.id === 'deadbeef-orphan');
    assert.equal(orphan.has_session, 0);
    assert.equal(orphan.files, 3);
    assert.equal(orphan.bytes, 1200);
    assert.equal(rows.find((r) => r.id === 'S1').has_session, 1);
  } finally { rm(root); rm(out); }
});

test('中文可以被全文檢索到（trigram 分詞器）', async () => {
  const { root, out } = fixture();
  try {
    await buildIndex({ root, out });
    const db = openDb(dbPath(out), { create: false });
    const hits = db.prepare(`
      SELECT m.session_id FROM msg_fts f JOIN messages m ON m.rowid = f.rowid
      WHERE msg_fts MATCH ?`).all('"北海道"');
    db.close();
    assert.ok(hits.length >= 1, '中文子字串必須搜得到');
    assert.ok(hits.every((h) => h.session_id === 'S3'));
  } finally { rm(root); rm(out); }
});

test('第二次掃描是增量的，沒改過的檔案跳過', async () => {
  const { root, out } = fixture();
  try {
    await buildIndex({ root, out });
    const again = await buildIndex({ root, out });
    assert.equal(again.scanned, 0);
    assert.equal(again.skipped, 3);
    const full = await buildIndex({ root, out, full: true });
    assert.equal(full.scanned, 3, '--full 要忽略增量判斷');
  } finally { rm(root); rm(out); }
});

test('檔案從磁碟消失後，索引裡也要跟著移除', async () => {
  const { root, out } = fixture();
  try {
    await buildIndex({ root, out });
    fs.rmSync(path.join(root, PROJ, 'S3.jsonl'));
    const stats = await buildIndex({ root, out });
    assert.equal(stats.removed, 1);
    const db = openDb(dbPath(out), { create: false });
    assert.equal(allSessions(db).length, 2);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM messages WHERE session_id = ?').get('S3').n, 0);
    db.close();
  } finally { rm(root); rm(out); }
});

test('可以用 id 前綴查 session，撞名時要拋錯而不是猜', async () => {
  const { root, out } = fixture();
  try {
    await buildIndex({ root, out });
    const db = openDb(dbPath(out), { create: false });
    assert.equal(resolveSessionId(db, 'S3'), 'S3');
    assert.equal(resolveSessionId(db, 'nope'), null);
    assert.throws(() => resolveSessionId(db, 'S'), /對應到多筆/);
    db.close();
  } finally { rm(root); rm(out); }
});

test('報表資料算得出來，且只帶標題不帶內文', async () => {
  const { root, out } = fixture();
  try {
    await buildIndex({ root, out });
    const d = collect({ out, root });
    assert.equal(d.totals.sessions, 3);
    assert.equal(d.totals.msgs, 22);
    assert.equal(d.totals.badLines, 1);
    assert.equal(d.totals.orphanDirs, 1);
    assert.equal(d.lineage.roles.primary, 1);
    assert.equal(d.lineage.roles.fork, 1);
    assert.equal(d.lineage.roles.solo, 1);
    assert.equal(d.lineage.groups.length, 1);
    assert.ok(d.categories.length > 0);
    assert.equal(d.categories.reduce((a, r) => a + r.bytes, 0), d.totals.accounted);
    assert.equal(d.tools[0].name, 'WebSearch');
    assert.ok(d.scannedAt, 'scan 時間要記在索引裡');

    // 報表刻意只帶標題（來自第一則提問），不帶任何訊息本文或思考內容。
    const json = JSON.stringify(d);
    assert.ok(json.includes('幫我查北海道的雪季'), '標題是報表的識別依據，應該在');
    assert.ok(!json.includes('先確認日期範圍'), '報表資料不得包含思考內容');
    assert.ok(!json.includes('主線：助手第 1 句'), '報表資料不得包含訊息本文');
    assert.ok(!json.includes('好的，我查一下。'), '報表資料不得包含訊息本文');
  } finally { rm(root); rm(out); }
});

test('空的存檔目錄不會讓工具當掉', async () => {
  const root = tmpRoot('ccempty');
  const out = tmpRoot('ccout');
  try {
    const stats = await buildIndex({ root, out });
    assert.equal(stats.scanned, 0);
    assert.equal(stats.projects, 0);
    const d = collect({ out, root });
    assert.equal(d.totals.sessions, 0);
    assert.equal(d.totals.bytes, 0);
    assert.deepEqual(d.categories, []);
    assert.equal(d.time.busiest, null);
  } finally { rm(root); rm(out); }
});
