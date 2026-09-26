/**
 * 把雲端的事實資料拉回本機存檔：作答、打卡、實作／模考三張事件表，加上設定快照。
 * 對雲端只讀，不寫任何東西。
 *
 * 為什麼需要：2026-09-26 起停用本機版，雲端成為唯一的作答來源，data/reviews.jsonl
 * 停在 569 行不再增加。Supabase 專案被刪、帳號出事或誤刪列時，這份檔是唯一的退路。
 *
 * 事件表存成 data/cloud-backup/<表名>.jsonl，只追加、不改寫既有行（規則見
 * src/cloud/event-backup.mjs）；settings.json 是快照，每次覆寫。
 * 沒備份的：card_states 由作答事件重播即可算回；practice_assets 的 Storage 檔案不在資料表裡。
 *
 *   node scripts/cloud-backup.mjs --env .env.cloud
 */

import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { backupRow, planAppend } from '../src/cloud/event-backup.mjs';
import { ownerSession, parseArgs, readAll } from '../src/cloud/owner-cli.mjs';

const TABLES = ['review_events', 'checkin_events', 'practice_events'];

try {
  await main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = args.out ?? path.join('data', 'cloud-backup');
  const session = await ownerSession(args.env);

  // 先全部讀完、全部檢查過再寫檔：中途連線失敗時不會留下只更新一半的備份。
  const plans = [];
  for (const table of TABLES) {
    const rows = await readAll(session, `${table}?select=*&order=at.asc,event_id.asc`);
    const file = path.join(outDir, `${table}.jsonl`);
    const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
    plans.push({ table, file, cloud: rows.length, plan: planAppend(existing, rows) });
  }
  const settings = (await readAll(session, 'user_settings?select=*')).map(backupRow);

  mkdirSync(outDir, { recursive: true });
  for (const { file, plan } of plans) {
    if (plan.text) appendFileSync(file, plan.text);
  }
  writeFileSync(path.join(outDir, 'settings.json'), `${JSON.stringify(settings[0] ?? null, null, 2)}\n`);

  const report = Object.fromEntries(plans.map(({ table, cloud, plan }) => [table, {
    cloud,
    appended: plan.appended,
    missingFromCloud: plan.missingFromCloud.length,
  }]));
  console.log(JSON.stringify({ outDir, tables: report, settings: settings.length === 1 }, null, 2));

  const missing = plans.filter(({ plan }) => plan.missingFromCloud.length);
  for (const { table, plan } of missing) {
    console.error(`警告：${table} 有 ${plan.missingFromCloud.length} 筆在本機備份裡、雲端已查無（備份照留）：`
      + plan.missingFromCloud.slice(0, 10).join(', '));
  }
}
