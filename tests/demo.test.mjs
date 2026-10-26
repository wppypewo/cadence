/**
 * demo/sources/ 建得起題庫，而且七種題型都有卡。
 *
 * 示範範例是照五個外部來源的格式手寫的，解析器一改格式，範例就可能靜靜地變成 0 張——
 * npm run demo 照樣開得起來，只是某一種題型消失。這題盯住那件事。
 *
 * SOURCES 在 import 時讀環境變數，所以先設好再動態 import；node --test 每個檔各跑一個行程，
 * 不會影響其他測試。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES = path.join(ROOT, 'demo', 'sources');
Object.assign(process.env, {
  CADENCE_FEXGEN: path.join(SOURCES, 'fexgen'),
  CADENCE_VERBISTE: path.join(SOURCES, 'verbiste'),
  CADENCE_VAULT: path.join(SOURCES, 'vault'),
  CADENCE_PACKS: path.join(SOURCES, 'packs'),
  CADENCE_FLELEX: path.join(SOURCES, 'flelex'),
});

test('示範來源：建得起題庫，七種題型都有卡', async () => {
  const { build } = await import('../src/build/bank.mjs');
  const dir = mkdtempSync(path.join(tmpdir(), 'cadence-demo-test-'));
  try {
    const report = await build(path.join(dir, 'bank'));
    assert.equal(report.ok, true, `缺來源：${report.missing?.map((m) => m.name).join('、')}`);
    const cards = JSON.parse(readFileSync(path.join(dir, 'bank', 'cards.json'), 'utf8'));
    const kinds = new Set(cards.map((c) => c.kind));
    for (const kind of ['vocab-recall', 'vocab-produce', 'conj', 'connector', 'pick', 'rw', 'nom']) {
      assert.ok(kinds.has(kind), `示範題庫沒有 ${kind} 卡`);
    }
    // B2 走 FLELex 那條路，範例裡有三個字；少了代表 TSV 的欄位對不上了。
    assert.ok(cards.some((c) => c.kind === 'vocab-recall' && c.level === 'B2'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
