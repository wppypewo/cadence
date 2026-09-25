/** 從 cadence-backup-v1 安全補回事實檔；JSONL 永遠只追加，不覆寫。 */

import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const FACTS = ['reviews.jsonl', 'checkins.jsonl', 'attempts.jsonl'];
const FILES = [...FACTS, 'settings.json'];

export function readBackup(file) {
  let bundle;
  try {
    bundle = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`讀不到備份 ${file}：${err.message}`);
  }
  validateBundle(bundle);
  return bundle;
}

export function restorePlan(dataDir, bundle) {
  validateBundle(bundle);
  const changes = [];
  for (const name of FACTS) {
    const current = read(path.join(dataDir, name));
    const backup = bundle.files[name];
    validateJsonl(name, backup);
    if (!backup.startsWith(current)) {
      throw new Error(`${name} 與備份分岔，不能用覆寫解決；目前檔案不是備份內容的前綴`);
    }
    const suffix = backup.slice(current.length);
    changes.push({ file: name, action: suffix ? 'append' : 'unchanged', lines: countLines(suffix), suffix });
  }

  const settings = bundle.files['settings.json'];
  if (settings) {
    let parsed;
    try {
      parsed = JSON.parse(settings);
    } catch (err) {
      throw new Error(`settings.json 不是合法 JSON：${err.message}`);
    }
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('settings.json 必須是 JSON 物件');
  }
  const currentSettings = read(path.join(dataDir, 'settings.json'));
  changes.push({
    file: 'settings.json',
    // 早期備份可能還沒有 settings.json；空字串代表「沒有可還原的設定」，不是清空現況。
    action: settings && settings !== currentSettings ? 'replace-settings' : 'unchanged',
    lines: null,
    content: settings,
  });
  return changes;
}

export function applyRestore(dataDir, bundle) {
  const plan = restorePlan(dataDir, bundle);
  for (const item of plan) {
    const file = path.join(dataDir, item.file);
    if (item.action === 'append') appendFileSync(file, item.suffix, 'utf8');
    if (item.action === 'replace-settings') {
      const temp = `${file}.restore.tmp`;
      writeFileSync(temp, item.content, 'utf8');
      renameSync(temp, file);
    }
  }
  return plan.map(({ suffix, content, ...item }) => item);
}

function validateBundle(bundle) {
  if (bundle?.format !== 'cadence-backup-v1' || !bundle.files || typeof bundle.files !== 'object') {
    throw new Error('不是 cadence-backup-v1 備份');
  }
  for (const name of FILES) {
    if (typeof bundle.files[name] !== 'string') throw new Error(`備份缺少 ${name}`);
  }
}

function validateJsonl(name, text) {
  let lineNo = 0;
  for (const line of text.split('\n')) {
    lineNo += 1;
    if (!line.trim()) continue;
    try {
      JSON.parse(line);
    } catch (err) {
      throw new Error(`${name} 第 ${lineNo} 行不是合法 JSON：${err.message}`);
    }
  }
}

function read(file) {
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

function countLines(text) {
  return text.split('\n').filter((line) => line.trim()).length;
}
