// JSONL 讀取：存檔可能在寫入中途被截斷，壞行必須跳過而不是讓整個工具死掉。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readJsonl, readJsonlSync } from '../src/jsonl.mjs';
import { tmpRoot, rm } from './helpers.mjs';

function write(dir, name, text) {
  const f = path.join(dir, name);
  fs.writeFileSync(f, text);
  return f;
}

test('壞行被標成 ok:false，好行照常解析', async () => {
  const dir = tmpRoot('ccjsonl');
  try {
    const f = write(dir, 'a.jsonl', '{"n":1}\n{壞掉的一行\n{"n":2}\n');
    const rows = readJsonlSync(f);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((r) => r.ok), [true, false, true]);
    assert.equal(rows[0].value.n, 1);
    assert.equal(rows[2].value.n, 2);
    assert.equal(rows[1].value, null);
    assert.equal(rows[1].raw, '{壞掉的一行');
  } finally { rm(dir); }
});

test('被截斷的最後一行不會讓讀取拋錯', async () => {
  const dir = tmpRoot('ccjsonl');
  try {
    const f = write(dir, 'cut.jsonl', '{"n":1}\n{"n":2,"text":"寫到一半就');
    const rows = readJsonlSync(f);
    assert.equal(rows.length, 2);
    assert.equal(rows[1].ok, false);
  } finally { rm(dir); }
});

test('空行被略過，行號仍然照原檔計算', () => {
  const dir = tmpRoot('ccjsonl');
  try {
    const f = write(dir, 'blank.jsonl', '{"n":1}\n\n{"n":3}\n');
    const rows = readJsonlSync(f);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.lineNo), [1, 3]);
  } finally { rm(dir); }
});

test('bytes 算的是 UTF-8 位元組，不是字元數', () => {
  const dir = tmpRoot('ccjsonl');
  try {
    const line = JSON.stringify({ t: '中文三個字' });
    const f = write(dir, 'cjk.jsonl', `${line}\n`);
    const rows = readJsonlSync(f);
    assert.equal(rows[0].bytes, Buffer.byteLength(line, 'utf8'));
    assert.ok(rows[0].bytes > line.length, 'CJK 的位元組數必須大於字元數');
  } finally { rm(dir); }
});

test('串流版與同步版結果一致', async () => {
  const dir = tmpRoot('ccjsonl');
  try {
    const f = write(dir, 'both.jsonl', '{"n":1}\nbad\n{"n":2}\n{"t":"中文"}\n');
    const sync = readJsonlSync(f);
    const streamed = [];
    for await (const r of readJsonl(f)) streamed.push(r);
    assert.deepEqual(
      streamed.map((r) => [r.lineNo, r.bytes, r.ok]),
      sync.map((r) => [r.lineNo, r.bytes, r.ok]),
    );
  } finally { rm(dir); }
});

test('CRLF 換行不會被算進位元組數', async () => {
  const dir = tmpRoot('ccjsonl');
  try {
    const f = write(dir, 'crlf.jsonl', '{"n":1}\r\n{"n":2}\r\n');
    const rows = [];
    for await (const r of readJsonl(f)) rows.push(r);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].ok, true);
    assert.equal(rows[0].bytes, 7);
  } finally { rm(dir); }
});
