/** 將不可重建的學習事實與設定包成一份可下載 JSON，不改動任何來源檔。 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { uncommittedFacts } from './facts-git.mjs';

const FILES = ['reviews.jsonl', 'checkins.jsonl', 'attempts.jsonl', 'settings.json'];

export function backupBundle(dataDir, now = new Date()) {
  return {
    format: 'cadence-backup-v1',
    exportedAt: now.toISOString(),
    files: Object.fromEntries(FILES.map((name) => [name, read(dataDir, name)])),
  };
}

export function backupStatus(dataDir) {
  const files = Object.fromEntries(FILES.map((name) => {
    const file = path.join(dataDir, name);
    const text = read(dataDir, name);
    return [name, {
      exists: existsSync(file),
      bytes: existsSync(file) ? statSync(file).size : 0,
      lines: name.endsWith('.jsonl') ? text.split('\n').filter((line) => line.trim()).length : null,
    }];
  }));
  const root = path.dirname(dataDir);
  const tracked = path.basename(dataDir) === 'data' ? uncommittedFacts(root) : null;
  return {
    files,
    pendingFacts: tracked?.reduce((sum, item) => sum + item.added, 0) ?? null,
    gitAvailable: tracked !== null,
  };
}

function read(dataDir, name) {
  const file = path.join(dataDir, name);
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}
