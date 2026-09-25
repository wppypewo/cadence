import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyRestore, restorePlan } from '../src/restore.mjs';

function bundle(files = {}) {
  return {
    format: 'cadence-backup-v1',
    files: {
      'reviews.jsonl': '', 'checkins.jsonl': '', 'attempts.jsonl': '',
      'settings.json': '{}\n', ...files,
    },
  };
}

test('dry-run 只列出可追加內容，不改檔案', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cadence-restore-'));
  try {
    writeFileSync(path.join(dir, 'reviews.jsonl'), '{"id":1}\n');
    const source = bundle({ 'reviews.jsonl': '{"id":1}\n{"id":2}\n' });
    const plan = restorePlan(dir, source);
    assert.deepEqual(plan.find((item) => item.file === 'reviews.jsonl').lines, 1);
    assert.equal(readFileSync(path.join(dir, 'reviews.jsonl'), 'utf8'), '{"id":1}\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('真正還原只追加 JSONL，分岔時拒絕覆寫', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cadence-restore-'));
  try {
    writeFileSync(path.join(dir, 'reviews.jsonl'), '{"id":1}\n');
    applyRestore(dir, bundle({ 'reviews.jsonl': '{"id":1}\n{"id":2}\n' }));
    assert.equal(readFileSync(path.join(dir, 'reviews.jsonl'), 'utf8'), '{"id":1}\n{"id":2}\n');
    assert.throws(
      () => restorePlan(dir, bundle({ 'reviews.jsonl': '{"id":1}\n{"id":3}\n' })),
      /分岔/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('壞掉的 JSONL 與錯誤格式在寫入前就拒絕', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cadence-restore-'));
  try {
    assert.throws(() => restorePlan(dir, bundle({ 'reviews.jsonl': '{bad}\n' })), /第 1 行/);
    assert.throws(() => restorePlan(dir, { format: 'other', files: {} }), /不是 cadence-backup-v1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
