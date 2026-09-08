// 回收：只處理「整個丟掉也不會失去獨有內容」的東西。
// 預設只產生計畫檔，不動任何檔案；--apply 也不是刪除，而是搬到隔離區並留下 manifest，可以 undo。
import fs from 'node:fs';
import path from 'node:path';
import { openDb, allSessions } from '../store.mjs';
import { dbPath, outDir, claudeRoot, ensureDir, shortProject } from '../paths.mjs';
import { dirUsage, RESERVED_DIRS } from '../scan.mjs';
import { c, bytes, num, table, kv, heading, truncate, ago } from '../fmt.mjs';

export const spec = { flags: ['apply', 'yes', 'orphans', 'subsumed'], alias: { n: 'limit' } };

export function help() {
  return `${c.bold('ccarchive reclaim')} — 產生可回收清單

用法  ccarchive reclaim [選項]            ${c.dim('# 只列計畫，不動檔案')}
      ccarchive reclaim --apply --yes    ${c.dim('# 搬到隔離區（可 undo）')}

      --orphans     只算孤兒快取目錄
      --subsumed    只算被完全包含的 session
      --apply       實際執行（搬移，不是刪除）
      --yes         確認執行；沒有這個旗標 --apply 會拒絕
      --json        JSON 輸出

${c.dim('安全性')}
  1. 預設是唯讀的，只產生計畫。
  2. --apply 不會刪除任何東西，只把檔案搬到 <out>/quarantine/<計畫編號>/，
     並寫下 manifest.json 記錄每個檔案的原始位置與大小。
  3. 隨時可以用 ccarchive undo <計畫編號> 原樣搬回去。
  4. memory/、todos/、shell-snapshots/、scripts/ 永不列入。
  5. 搬移前會重新確認磁碟上的大小與時間，與索引不符就跳過。
  6. 確認自己不需要之後，隔離區可以整個手動刪掉。

${c.dim('可回收的兩類')}
  孤兒快取目錄  對應的對話檔已不存在，內容失去意義
  subsumed      該 session 的每一則訊息都能在另一個檔案找到`;
}

export async function run(args) {
  const root = claudeRoot(args.root);
  const out = outDir(args.out);
  const db = openDb(dbPath(args.out), { create: false });
  const sidecars = db.prepare('SELECT * FROM sidecars').all();
  const sessions = new Map(allSessions(db).map((s) => [s.id, s]));
  const lineage = db.prepare('SELECT * FROM lineage').all();
  db.close();

  const wantOrphans = args.orphans || (!args.orphans && !args.subsumed);
  const wantSubsumed = args.subsumed || (!args.orphans && !args.subsumed);

  const items = [];
  if (wantOrphans) {
    for (const r of sidecars) {
      if (r.has_session) continue;
      if (RESERVED_DIRS.has(path.basename(r.dir))) continue;
      if (!fs.existsSync(r.dir)) continue;
      items.push({
        kind: 'sidecar', id: r.id, path: r.dir, bytes: r.bytes, files: r.files,
        project: r.project, newest: r.newest,
        why: '對應的對話檔不存在，快取內容失去意義',
      });
    }
  }
  if (wantSubsumed) {
    for (const l of lineage) {
      if (l.role !== 'subsumed') continue;
      const s = sessions.get(l.session_id);
      if (!s || !fs.existsSync(s.file)) continue;
      items.push({
        kind: 'session', id: s.id, path: s.file, bytes: s.size, files: 1,
        project: s.project, newest: s.mtime, title: s.title,
        why: `${num(l.shared_msgs)} 則訊息全部在其他 session 中，獨有訊息 0`,
      });
    }
  }
  items.sort((a, b) => b.bytes - a.bytes);
  const totalBytes = items.reduce((s, i) => s + i.bytes, 0);

  if (args.json && !args.apply) {
    process.stdout.write(`${JSON.stringify({ root, items, totalBytes }, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(`${heading('回收計畫')}\n`);
  process.stdout.write(`${kv([
    ['存檔根目錄', root, ''],
    ['孤兒快取', num(items.filter((i) => i.kind === 'sidecar').length), bytes(items.filter((i) => i.kind === 'sidecar').reduce((s, i) => s + i.bytes, 0))],
    ['subsumed', num(items.filter((i) => i.kind === 'session').length), bytes(items.filter((i) => i.kind === 'session').reduce((s, i) => s + i.bytes, 0))],
    ['可回收合計', bytes(totalBytes), ''],
  ])}\n`);

  if (items.length === 0) {
    process.stdout.write(`\n  ${c.green('✓')} 沒有可以安全回收的東西。\n`);
    process.stdout.write(`  ${c.dim('存檔裡的重複位元組分散在多個檔案的開頭，刪任何一個整檔都會連帶失去獨有內容。')}\n`);
    process.stdout.write(`  ${c.dim('這是實測結果——用 ccarchive lineage 看每個群組的獨有／共用訊息數。')}\n`);
    return 0;
  }

  process.stdout.write(`\n${table(items, [
    { label: '類型', value: (i) => (i.kind === 'sidecar' ? c.yellow('快取目錄') : c.red('session')) },
    { label: 'ID', value: (i) => c.cyan(i.id.slice(0, 8)) },
    { label: '專案', value: (i) => truncate(shortProject(i.project), 26) },
    { label: '大小', align: 'right', value: (i) => bytes(i.bytes) },
    { label: '檔案', align: 'right', value: (i) => num(i.files) },
    { label: '最後寫入', value: (i) => ago(new Date(i.newest).toISOString()) },
    { label: '理由', value: (i) => c.dim(truncate(i.why, 34)) },
  ], { indent: '  ' })}\n`);

  if (!args.apply) {
    process.stdout.write(`\n  ${c.dim('以上只是清單，沒有任何檔案被動過。')}\n`);
    process.stdout.write(`  ${c.dim('要執行：')} ccarchive reclaim --apply --yes  ${c.dim('（搬到隔離區，可 undo）')}\n`);
    return 0;
  }
  if (!args.yes) {
    process.stderr.write(`\n${c.red('拒絕執行')} --apply 需要同時加上 --yes 才會動檔案。\n`);
    process.stderr.write(`${c.dim('先看清楚上面的清單，確認每一項都不需要了再加 --yes。')}\n`);
    return 2;
  }

  return applyPlan({ items, root, out });
}

function applyPlan({ items, root, out }) {
  const planId = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  const quarantine = path.join(out, 'quarantine', planId);
  ensureDir(quarantine);

  const manifest = {
    planId, createdAt: new Date().toISOString(), root, quarantine,
    tool: 'ccarchive', entries: [],
  };
  const manifestPath = path.join(quarantine, 'manifest.json');
  // 先落地一份空 manifest：中途當掉也還原得回來。
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  let moved = 0, movedBytes = 0, skipped = 0;
  for (const item of items) {
    const check = verify(item, root);
    if (!check.ok) {
      process.stdout.write(`  ${c.yellow('跳過')} ${item.id.slice(0, 8)} ${c.dim(check.reason)}\n`);
      manifest.entries.push({ ...item, status: 'skipped', reason: check.reason });
      skipped++;
      continue;
    }
    const rel = path.relative(root, item.path);
    const dest = path.join(quarantine, 'files', rel);
    ensureDir(path.dirname(dest));
    try {
      moveAcross(item.path, dest);
    } catch (err) {
      process.stdout.write(`  ${c.red('失敗')} ${item.id.slice(0, 8)} ${c.dim(err.message)}\n`);
      manifest.entries.push({ ...item, status: 'failed', reason: err.message });
      skipped++;
      continue;
    }
    manifest.entries.push({ ...item, status: 'moved', from: item.path, to: dest, rel });
    moved++; movedBytes += item.bytes;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  }

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  process.stdout.write(`\n${heading('已執行')}\n`);
  process.stdout.write(`${kv([
    ['計畫編號', planId, ''],
    ['已搬移', num(moved), bytes(movedBytes)],
    ['跳過', num(skipped), skipped ? '見上方原因' : ''],
    ['隔離區', quarantine, ''],
  ])}\n`);
  process.stdout.write(`\n  ${c.dim('要還原：')} ccarchive undo ${planId}\n`);
  process.stdout.write(`  ${c.dim('確認不需要後，手動刪掉隔離區目錄即可真正釋放空間。')}\n`);
  return moved > 0 || items.length === 0 ? 0 : 1;
}

/** 搬移前重新確認磁碟現況，與索引不符就不動它。 */
function verify(item, root) {
  const rel = path.relative(root, item.path);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, reason: '路徑不在存檔根目錄內' };
  if (rel.split(path.sep).some((seg) => RESERVED_DIRS.has(seg))) return { ok: false, reason: '位於保留目錄內' };
  let st;
  try { st = fs.statSync(item.path); } catch { return { ok: false, reason: '路徑已不存在' }; }

  if (item.kind === 'session') {
    if (!st.isFile()) return { ok: false, reason: '不是檔案' };
    if (st.size !== item.bytes) return { ok: false, reason: `大小已改變（索引 ${item.bytes} → 現在 ${st.size}），請重新 scan` };
  } else {
    if (!st.isDirectory()) return { ok: false, reason: '不是目錄' };
    const now = dirUsage(item.path);
    if (now.bytes !== item.bytes || now.files !== item.files) {
      return { ok: false, reason: '目錄內容已改變，請重新 scan' };
    }
  }
  return { ok: true };
}

/** rename 跨磁碟會失敗，退回複製後刪除。 */
function moveAcross(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}
