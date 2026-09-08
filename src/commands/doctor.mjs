// 環境與索引健康檢查。全部唯讀，只讀狀態不改狀態。
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { openDb, allSessions, getMeta } from '../store.mjs';
import { dbPath, outDir, claudeRoot } from '../paths.mjs';
import { c, bytes, num, kv, heading, ago, truncate } from '../fmt.mjs';

export const spec = { flags: [], alias: {} };

export function help() {
  return `${c.bold('ccarchive doctor')} — 環境與索引健康檢查

用法  ccarchive doctor [--json]

檢查 Node 版本、存檔目錄、索引新舊、解析失敗的行數、
無法還原的專案路徑、已消失的對話檔，以及隔離區是否有待處理的東西。
全程唯讀。`;
}

const OK = 'ok', WARN = 'warn', BAD = 'bad';

export async function run(args) {
  const checks = [];
  const add = (level, name, detail, hint) => checks.push({ level, name, detail, hint });

  // 1. Node 版本：node:sqlite 需要 24 以上
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 24) add(OK, 'Node 版本', `v${process.versions.node}`);
  else add(BAD, 'Node 版本', `v${process.versions.node}`, '需要 v24 以上（內建 node:sqlite）');

  // 2. 存檔根目錄
  const root = claudeRoot(args.root);
  let rootStat = null;
  try { rootStat = fs.statSync(root); } catch { /* 不存在 */ }
  if (rootStat?.isDirectory()) {
    let readable = true;
    try { fs.readdirSync(root); } catch { readable = false; }
    if (readable) add(OK, '存檔根目錄', root);
    else add(BAD, '存檔根目錄', root, '無法讀取，檢查權限');
  } else {
    add(BAD, '存檔根目錄', root, '不存在。用 --root 指定，或設定 CCARCHIVE_ROOT');
  }

  // 3. 輸出目錄不可以在存檔裡面——本工具不在存檔目錄寫任何東西
  const out = outDir(args.out);
  const rel = path.relative(root, out);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    add(BAD, '輸出目錄', out, '位於存檔目錄內，會污染存檔。請改用 --out 指到別處');
  } else {
    add(OK, '輸出目錄', out);
  }

  // 4. 索引
  const file = dbPath(args.out);
  if (!fs.existsSync(file)) {
    add(WARN, '索引', '尚未建立', '執行 ccarchive scan');
    return report(checks, args, null);
  }
  const dbSize = fs.statSync(file).size;
  let db;
  try { db = openDb(file, { create: false }); }
  catch (err) {
    add(BAD, '索引', '無法開啟', err.message);
    return report(checks, args, null);
  }

  const scannedAt = getMeta(db, 'scanned_at');
  const indexedRoot = getMeta(db, 'root');
  const sessions = allSessions(db);
  const sidecars = db.prepare('SELECT * FROM sidecars').all();
  const lineage = db.prepare('SELECT role, COUNT(*) n FROM lineage GROUP BY role').all();
  let ftsOk = true, ftsErr = '';
  try { db.prepare("SELECT rowid FROM msg_fts WHERE msg_fts MATCH ? LIMIT 1").get('abc'); }
  catch (err) { ftsOk = false; ftsErr = err.message; }
  db.close();

  add(OK, '索引檔', `${file}（${bytes(dbSize)}）`);
  if (indexedRoot && indexedRoot !== root) {
    add(WARN, '索引來源', indexedRoot, `與目前 --root（${root}）不同，數字對不上是正常的`);
  }
  add(OK, '索引內容', `${num(sessions.length)} 個 session · ${num(sidecars.length)} 個快取目錄`,
    lineage.map((r) => `${r.role} ${r.n}`).join(' · '));

  // 5. 索引是否過期：比對磁碟上的檔案大小與時間
  let changed = 0, missing = 0, newer = 0;
  for (const s of sessions) {
    let st;
    try { st = fs.statSync(s.file); } catch { missing++; continue; }
    if (st.size !== s.size || Math.floor(st.mtimeMs) !== s.mtime) changed++;
  }
  if (rootStat?.isDirectory()) newer = countNewFiles(root, new Set(sessions.map((s) => s.file)));
  const staleParts = [];
  if (changed) staleParts.push(`${changed} 個已變動`);
  if (missing) staleParts.push(`${missing} 個已消失`);
  if (newer) staleParts.push(`${newer} 個是新的`);
  if (staleParts.length) {
    add(WARN, '索引新舊', `${scannedAt ? ago(scannedAt) : '未知'}掃描 · ${staleParts.join('、')}`, '執行 ccarchive scan 更新');
  } else {
    add(OK, '索引新舊', `${scannedAt ? ago(scannedAt) : '未知'}掃描，與磁碟一致`);
  }

  // 6. 全文檢索
  if (ftsOk) add(OK, '全文檢索', 'FTS5 trigram 可用（中文可搜）');
  else add(BAD, '全文檢索', '不可用', `${ftsErr}；此版 SQLite 可能未編入 FTS5`);

  // 7. 解析失敗的行
  const badLines = sessions.reduce((s, x) => s + x.bad_lines, 0);
  const badFiles = sessions.filter((s) => s.bad_lines > 0);
  if (badLines === 0) add(OK, '檔案完整性', '所有行都解析成功');
  else {
    add(WARN, '檔案完整性', `${num(badLines)} 行無法解析，分布於 ${badFiles.length} 個檔案`,
      `多半是寫入中途被中斷；受影響最多的是 ${badFiles.sort((a, b) => b.bad_lines - a.bad_lines)[0].id.slice(0, 8)}`);
  }

  // 8. 專案路徑還原
  const unresolved = new Set();
  for (const s of sessions) {
    if (!s.cwd || !fs.existsSync(s.cwd)) unresolved.add(s.cwd || s.project);
  }
  if (unresolved.size === 0) add(OK, '專案路徑', '全部可對應到現存目錄');
  else add(WARN, '專案路徑', `${unresolved.size} 個對應不到現存目錄`,
    `例如 ${truncate([...unresolved][0], 50)}；專案被刪或改名後會這樣，不影響檢索`);

  // 9. 隔離區
  const qdir = path.join(out, 'quarantine');
  const pending = pendingQuarantine(qdir);
  if (pending.batches === 0) add(OK, '隔離區', '沒有待處理的批次');
  else add(WARN, '隔離區', `${pending.batches} 個批次 · ${num(pending.items)} 項 · ${bytes(pending.bytes)}`,
    '用 ccarchive undo --list 查看；確認不需要後可手動刪掉隔離區目錄');

  return report(checks, args, { sessions: sessions.length, dbSize });
}

function countNewFiles(root, known) {
  let n = 0;
  let dirs;
  try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch { return 0; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    let files;
    try { files = fs.readdirSync(path.join(root, d.name)); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      if (!known.has(path.join(root, d.name, f))) n++;
    }
  }
  return n;
}

function pendingQuarantine(dir) {
  let batches = 0, items = 0, total = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return { batches: 0, items: 0, bytes: 0 }; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const mp = path.join(dir, e.name, 'manifest.json');
    if (!fs.existsSync(mp)) continue;
    try {
      const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
      const p = m.entries.filter((x) => x.status === 'moved');
      if (p.length) { batches++; items += p.length; total += p.reduce((s, x) => s + x.bytes, 0); }
    } catch { /* manifest 壞掉就當它不存在 */ }
  }
  return { batches, items, bytes: total };
}

function report(checks, args, extra) {
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ checks, ...extra }, null, 2)}\n`);
    return checks.some((x) => x.level === BAD) ? 1 : 0;
  }
  process.stdout.write(`${heading('健康檢查')}\n`);
  for (const ch of checks) {
    const mark = ch.level === OK ? c.green('✓') : ch.level === WARN ? c.yellow('!') : c.red('✗');
    process.stdout.write(`  ${mark} ${c.dim(ch.name)}  ${ch.detail}\n`);
    if (ch.hint) process.stdout.write(`      ${c.dim(ch.hint)}\n`);
  }
  const bad = checks.filter((x) => x.level === BAD).length;
  const warn = checks.filter((x) => x.level === WARN).length;
  process.stdout.write(`\n${kv([
    ['通過', num(checks.length - bad - warn), ''],
    ['提醒', num(warn), ''],
    ['問題', num(bad), ''],
  ])}\n`);
  return bad ? 1 : 0;
}
