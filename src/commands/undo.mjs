// 還原 reclaim --apply 搬走的檔案。依 manifest 原路搬回，目的地已存在就不覆蓋。
import fs from 'node:fs';
import path from 'node:path';
import { outDir } from '../paths.mjs';
import { c, bytes, num, table, kv, heading, truncate, date } from '../fmt.mjs';

export const spec = { flags: ['list', 'yes'], alias: {} };

export function help() {
  return `${c.bold('ccarchive undo')} — 還原被搬到隔離區的檔案

用法  ccarchive undo --list              ${c.dim('# 列出所有隔離批次')}
      ccarchive undo <計畫編號>          ${c.dim('# 還原該批次')}
      ccarchive undo <計畫編號> --json

${c.dim('說明')}
  只搬回 manifest 裡 status 為 moved 的項目。
  原位置若已經有同名檔案，該項會跳過而不是覆蓋——這種情況要自己看隔離區決定。`;
}

export async function run(args) {
  const base = path.join(outDir(args.out), 'quarantine');

  if (args.list || !args._[0]) {
    const plans = listPlans(base);
    if (args.json) { process.stdout.write(`${JSON.stringify(plans, null, 2)}\n`); return 0; }
    process.stdout.write(`${heading('隔離批次')}\n`);
    if (plans.length === 0) {
      process.stdout.write(`  ${c.dim('沒有任何隔離批次——reclaim 從來沒有 --apply 過。')}\n`);
      return 0;
    }
    process.stdout.write(`${table(plans, [
      { label: '計畫編號', value: (p) => c.cyan(p.planId) },
      { label: '時間', value: (p) => date(p.createdAt) },
      { label: '項目', align: 'right', value: (p) => num(p.moved) },
      { label: '大小', align: 'right', value: (p) => bytes(p.bytes) },
      { label: '狀態', value: (p) => (p.moved ? c.yellow('待還原') : c.dim('已清空')) },
    ], { indent: '  ' })}\n`);
    process.stdout.write(`\n  ${c.dim('還原：')} ccarchive undo <計畫編號>\n`);
    return 0;
  }

  const planId = String(args._[0]);
  const dir = path.join(base, planId);
  const manifestPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`找不到隔離批次：${planId}\n用 ccarchive undo --list 看有哪些。`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const pending = manifest.entries.filter((e) => e.status === 'moved');

  if (pending.length === 0) {
    process.stdout.write(`  ${c.dim(`批次 ${planId} 沒有待還原的項目。`)}\n`);
    return 0;
  }

  let restored = 0, restoredBytes = 0, skipped = 0;
  for (const e of pending) {
    if (fs.existsSync(e.from)) {
      process.stdout.write(`  ${c.yellow('跳過')} ${e.id.slice(0, 8)} ${c.dim('原位置已有同名檔案，不覆蓋')}\n`);
      skipped++;
      continue;
    }
    if (!fs.existsSync(e.to)) {
      process.stdout.write(`  ${c.yellow('跳過')} ${e.id.slice(0, 8)} ${c.dim('隔離區內找不到該項目')}\n`);
      skipped++;
      continue;
    }
    fs.mkdirSync(path.dirname(e.from), { recursive: true });
    moveAcross(e.to, e.from);
    e.status = 'restored';
    e.restoredAt = new Date().toISOString();
    restored++; restoredBytes += e.bytes;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  }

  process.stdout.write(`\n${heading('已還原')}\n`);
  process.stdout.write(`${kv([
    ['計畫編號', planId, ''],
    ['已還原', num(restored), bytes(restoredBytes)],
    ['跳過', num(skipped), skipped ? '見上方原因' : ''],
  ])}\n`);
  if (restored) process.stdout.write(`\n  ${c.dim('索引已過期，建議重跑')} ccarchive scan\n`);
  return 0;
}

function listPlans(base) {
  let names;
  try { names = fs.readdirSync(base, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of names) {
    if (!e.isDirectory()) continue;
    const mp = path.join(base, e.name, 'manifest.json');
    if (!fs.existsSync(mp)) continue;
    try {
      const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
      const pending = m.entries.filter((x) => x.status === 'moved');
      out.push({
        planId: m.planId, createdAt: m.createdAt, dir: path.join(base, e.name),
        moved: pending.length, bytes: pending.reduce((s, x) => s + x.bytes, 0),
        total: m.entries.length,
      });
    } catch { /* manifest 壞了就略過，不讓整個列表掛掉 */ }
  }
  return out.sort((a, b) => String(b.planId).localeCompare(String(a.planId)));
}

function moveAcross(from, to) {
  try { fs.renameSync(from, to); }
  catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}
