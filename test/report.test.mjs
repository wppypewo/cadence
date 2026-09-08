// 報表輸出：必須是單一自足的檔案（無 CDN、無外連字型），且對惡意標題不會破版。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildIndex } from '../src/indexer.mjs';
import { collect } from '../src/report/data.mjs';
import { renderHtml } from '../src/report/html.mjs';
import * as report from '../src/commands/report.mjs';
import { tmpRoot, rm, conversation, writeSession, writeSidecar } from './helpers.mjs';

const PROJ = '-tmp-demo';

async function fixture() {
  const root = tmpRoot('ccreport');
  const out = tmpRoot('ccout');
  const base = conversation({ session: 'S1', from: 0, turns: 4, prefix: '主線' });
  writeSession(root, PROJ, 'S1', base);
  writeSession(root, PROJ, 'S2', [...base.slice(0, 4), ...conversation({ session: 'S2', from: 90, turns: 2, prefix: '分岔' })]);
  writeSidecar(root, PROJ, 'orphan-1', 2, 256);
  await buildIndex({ root, out });
  return { root, out };
}

test('HTML 不引用任何外部資源', async () => {
  const { root, out } = await fixture();
  try {
    const html = renderHtml(collect({ out, root }));
    assert.ok(!/https?:\/\//i.test(html), '不得出現任何 http(s) 連結');
    assert.ok(!/<link\b/i.test(html), '不得有外連樣式表或字型');
    assert.ok(!/<script[^>]+src=/i.test(html), '不得載入外部腳本');
    assert.ok(html.includes('<style>'), '樣式要內嵌');
  } finally { rm(root); rm(out); }
});

test('HTML 帶得動主要區塊與統計數字', async () => {
  const { root, out } = await fixture();
  try {
    const d = collect({ out, root });
    const html = renderHtml(d);
    assert.match(html, /<title>/);
    assert.ok(html.includes('prefers-color-scheme'), '要有深色配色');
    assert.ok(html.includes('@media print'), '要能列印');
    assert.ok(html.includes('prefers-reduced-motion'), '動畫要尊重系統設定');
    for (const cat of d.categories) assert.ok(html.includes(cat.label), `缺少類別 ${cat.label}`);
    assert.ok(html.includes('id="data"'), 'session 表要靠內嵌 JSON 驅動');
  } finally { rm(root); rm(out); }
});

test('標題裡的角括號被跳脫，內嵌 JSON 不會被提早關閉', () => {
  const d = {
    generatedAt: '2026-01-01T00:00:00.000Z', root: '/tmp/<root>', dbSize: 10, scannedAt: '2026-01-01T00:00:00.000Z',
    totals: {
      sessions: 1, msgs: 2, userMsgs: 1, asstMsgs: 1, sidechainMsgs: 0, badLines: 0,
      bytes: 100, accounted: 100, firstTs: '2026-01-01T00:00:00.000Z', lastTs: '2026-01-01T00:00:00.000Z',
      tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      sidecarDirs: 0, sidecarBytes: 0, orphanDirs: 0, orphanBytes: 0, activeDays: 1,
    },
    categories: [{ key: 'text', label: '對話文字', bytes: 100 }],
    lineage: { roles: { solo: 1, fork: 0, primary: 0, subsumed: 0 }, groups: [], redundantBytes: 0 },
    projects: [{ name: '-tmp-demo', label: 'tmp/demo', cwd: '/tmp/demo', sessions: 1, msgs: 2, bytes: 100, lastTs: null, exists: false }],
    tools: [], models: [],
    time: { months: [], hours: [], weekdays: [], busiest: null },
    sessions: [{
      id: 'S1', title: '</script><script>alert(1)</script>', project: 'tmp/demo', cwd: '/tmp/demo',
      firstTs: null, lastTs: null, size: 100, msgs: 2, userMsgs: 1, badLines: 0,
      role: 'solo', redundantBytes: 0, topCategory: { key: 'text', label: '對話文字', bytes: 100 },
    }],
  };
  const html = renderHtml(d);
  assert.ok(!html.includes('<script>alert(1)</script>'), '標題中的標籤必須被跳脫');
  assert.equal(html.match(/<script/g).length, html.match(/<\/script>/g).length, 'script 標籤要成對');
  assert.ok(html.includes('\\u003c/script>'), '內嵌 JSON 裡的 < 要被跳脫');
});

test('report 指令把檔案寫在 --out 之內，不動存檔目錄', async () => {
  const { root, out } = await fixture();
  try {
    const real = process.stdout.write.bind(process.stdout);
    process.stdout.write = () => true;
    let code;
    try { code = await report.run({ root, out, _: [] }); }
    finally { process.stdout.write = real; }
    assert.equal(code, 0);
    const dest = path.join(out, 'report.html');
    assert.ok(fs.existsSync(dest));
    assert.ok(fs.statSync(dest).size > 10000, '報表不該是空殼');
    // 存檔目錄只剩掃描前就有的東西
    const left = fs.readdirSync(path.join(root, PROJ)).sort();
    assert.deepEqual(left, ['S1.jsonl', 'S2.jsonl', 'orphan-1']);
  } finally { rm(root); rm(out); }
});

test('report --json 只印資料，不寫檔', async () => {
  const { root, out } = await fixture();
  try {
    const real = process.stdout.write.bind(process.stdout);
    let buf = '';
    process.stdout.write = (s) => { buf += s; return true; };
    try { await report.run({ root, out, json: true, _: [] }); }
    finally { process.stdout.write = real; }
    const d = JSON.parse(buf);
    assert.equal(d.totals.sessions, 2);
    assert.ok(!fs.existsSync(path.join(out, 'report.html')));
  } finally { rm(root); rm(out); }
});
