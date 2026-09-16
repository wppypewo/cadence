import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backupBundle, backupStatus } from '../src/backup.mjs';

test('備份完整帶走三份事實與設定，來源檔不變', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cadence-backup-'));
  try {
    writeFileSync(path.join(dir, 'reviews.jsonl'), '{"id":1}\n{"id":2}\n');
    writeFileSync(path.join(dir, 'settings.json'), '{"examDate":null}\n');
    const before = backupStatus(dir);
    const bundle = backupBundle(dir, new Date('2026-09-14T00:00:00Z'));
    const after = backupStatus(dir);
    assert.equal(bundle.format, 'cadence-backup-v1');
    assert.equal(bundle.files['reviews.jsonl'], '{"id":1}\n{"id":2}\n');
    assert.equal(bundle.files['checkins.jsonl'], '');
    assert.equal(before.files['reviews.jsonl'].lines, 2);
    assert.deepEqual(after.files, before.files);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
