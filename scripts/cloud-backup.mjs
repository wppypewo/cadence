/**
 * 把雲端的事實資料拉回本機存檔：作答、打卡、實作／模考三張事件表，加上設定快照。
 * 對雲端只讀，不寫任何東西。
 *
 * 為什麼需要：2026-09-26 起停用本機版，雲端成為唯一的作答來源，data/reviews.jsonl
 * 停在 569 行不再增加。Supabase 專案被刪、帳號出事或誤刪列時，這份檔是唯一的退路。
 *
 * 事件表存成 <cadence-data>/data/cloud-backup/<表名>.jsonl，只追加、不改寫既有行（規則見
 * src/cloud/event-backup.mjs）；settings.json 是快照，每次覆寫。
 *
 * 備份寫進私有 repo cadence-data，不寫進本 repo：作答紀錄是個人資料，本 repo 是公開的
 * （2026-10-26 移出）。cadence-data 預設 clone 在本 repo 旁邊，位置不同時設 CADENCE_DATA_REPO，
 * 或用 --out 直接指定目錄。
 * 沒備份的：card_states 由作答事件重播即可算回；practice_assets 的 Storage 檔案不在資料表裡。
 *
 *   node scripts/cloud-backup.mjs --env .env.cloud [--out <目錄>]
 */

import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { backupRow, planAppend } from '../src/cloud/event-backup.mjs';
import { ownerSession, parseArgs, readAll } from '../src/cloud/owner-cli.mjs';

const TABLES = ['review_events', 'checkin_events', 'practice_events'];
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_REPO = process.env.CADENCE_DATA_REPO
  ? path.resolve(process.env.CADENCE_DATA_REPO)
  : path.join(ROOT, '..', 'cadence-data');

try {
  await main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = args.out ?? path.join(DATA_REPO, 'data', 'cloud-backup');
  // 找不到 cadence-data 就停：mkdirSync 會默默建出一個不在任何 repo 裡的目錄，
  // 備份看起來成功，實際上沒有異地副本。
  if (!args.out && !existsSync(DATA_REPO)) {
    throw new Error(`找不到 cadence-data：${DATA_REPO}。先把私有 repo clone 到這裡，或設 CADENCE_DATA_REPO、或用 --out 指定目錄`);
  }
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
