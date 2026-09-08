// 孤兒快取：Claude Code 會為每個 session 建一個同名目錄存工具結果快取。
// 對話檔被刪掉時這些目錄常常留著，變成無主的磁碟佔用。
import fs from 'node:fs';
import { openDb, allSessions } from '../store.mjs';
import { dbPath, shortProject } from '../paths.mjs';
import { c, bytes, num, table, kv, heading, ago, truncate } from '../fmt.mjs';
import { intOpt } from '../cliargs.mjs';

export const spec = { flags: ['all'], alias: { n: 'limit' } };

export function help() {
  return `${c.bold('ccarchive orphans')} — 找出沒有對應對話檔的快取目錄

用法  ccarchive orphans [選項]

  -n, --limit <數字>  最多列幾筆（預設 20）
      --all           連有主的也一起列
      --json          JSON 輸出

${c.dim('說明')}
  每個 session 在專案目錄下會有一個同 ID 的子目錄，存工具結果快取。
  對話檔（.jsonl）被刪掉後，這個目錄不會跟著消失。
  這裡列出的「孤兒」是唯一在整套工具裡真正可以整個丟掉的東西——
  因為它的內容只在對應的對話存在時才有意義。

  memory/、todos/、shell-snapshots/、scripts/ 一律排除，不會被當成孤兒。`;
}

export async function run(args) {
  const db = openDb(dbPath(args.out), { create: false });
  const rows = db.prepare('SELECT * FROM sidecars ORDER BY bytes DESC').all();
  const sessions = new Map(allSessions(db).map((s) => [s.id, s]));
  db.close();

  // 索引可能是舊的：實際確認目錄還在
  const live = rows.filter((r) => fs.existsSync(r.dir));
  const orphans = live.filter((r) => !r.has_session);
  const owned = live.filter((r) => r.has_session);
  const orphanBytes = orphans.reduce((s, r) => s + r.bytes, 0);
  const totalBytes = live.reduce((s, r) => s + r.bytes, 0);

  if (args.json) {
    process.stdout.write(`${JSON.stringify({
      total: live.length, totalBytes, orphans: orphans.length, orphanBytes,
      rows: (args.all ? live : orphans).map((r) => ({
        id: r.id, dir: r.dir, bytes: r.bytes, files: r.files,
        newest: new Date(r.newest).toISOString(), orphan: !r.has_session,
      })),
    }, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(`${heading('工具結果快取目錄')}\n`);
  process.stdout.write(`${kv([
    ['目錄總數', num(live.length), bytes(totalBytes)],
    ['有對應對話', num(owned.length), bytes(totalBytes - orphanBytes)],
    ['孤兒', num(orphans.length), orphans.length ? c.yellow(bytes(orphanBytes)) : '沒有可回收的目錄'],
  ])}\n`);

  const shown = args.all ? live : orphans;
  if (shown.length === 0) {
    process.stdout.write(`\n  ${c.green('✓')} 每個快取目錄都有對應的對話檔，沒有東西可以清。\n`);
    process.stdout.write(`  ${c.dim('（加 --all 可以看全部目錄）')}\n`);
    return 0;
  }

  const limit = args.all && !args.limit ? Infinity : intOpt(args.limit, 20);
  process.stdout.write(`\n${heading(args.all ? '全部目錄' : '孤兒目錄')}\n`);
  process.stdout.write(`${table(shown.slice(0, limit), [
    { label: 'ID', value: (r) => c.cyan(r.id.slice(0, 8)) },
    { label: '專案', value: (r) => truncate(shortProject(r.project), 28) },
    { label: '大小', align: 'right', value: (r) => bytes(r.bytes) },
    { label: '檔案', align: 'right', value: (r) => num(r.files) },
    { label: '最後寫入', value: (r) => ago(new Date(r.newest).toISOString()) },
    { label: '狀態', value: (r) => (r.has_session ? c.dim(truncate(sessions.get(r.id)?.title || '有對話', 24)) : c.yellow('無對應對話檔')) },
  ], { indent: '  ' })}\n`);

  if (orphans.length) {
    process.stdout.write(`\n  ${c.dim('用')} ccarchive reclaim ${c.dim('產生回收計畫；預設只列不動手。')}\n`);
  }
  return 0;
}
