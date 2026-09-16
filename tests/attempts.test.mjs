import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AttemptLog } from '../src/attempts.mjs';

function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cadence-attempts-'));
  const db = new DatabaseSync(path.join(dir, 'test.db'));
  db.exec('CREATE TABLE reviews(day TEXT); CREATE TABLE checkins(day TEXT, done INTEGER);');
  const log = new AttemptLog(dir, db);
  return { dir, db, log, close: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('四科練習先寫 attempts.jsonl，再出現在查詢鏡像', () => {
  const f = fixture();
  try {
    const row = f.log.practice({
      skill: 'PE', source: 'Sujet 1', durationSec: 2700,
      score: 18, maxScore: 25, wordCount: 171, text: 'Bonjour à tous.', notes: '連接詞太少',
    }, new Date('2026-09-11T10:00:00+08:00'));
    assert.equal(row.skill, 'PE');
    assert.equal(readFileSync(path.join(f.dir, 'attempts.jsonl'), 'utf8').trim(), JSON.stringify(row));
    assert.deepEqual(f.log.today(new Date('2026-09-11T12:00:00+08:00')).PE, row);
    assert.equal(f.log.summary().bySkill.find((x) => x.skill === 'PE').attempts, 1);
    assert.equal(f.log.summary({ days: 30 }).periodDays, 30);
  } finally { f.close(); }
});

test('練習可保存分科細節，連續天數合併三種活動', () => {
  const f = fixture();
  try {
    const first = f.log.practice({ skill: 'CE', durationSec: 600, details: { mistakes: ['推論'] } }, new Date('2026-09-10T10:00:00+08:00'));
    const second = f.log.practice({ skill: 'PE', durationSec: 900, details: { rubric: { task: 3 } } }, new Date('2026-09-11T10:00:00+08:00'));
    assert.deepEqual(first.details.mistakes, ['推論']);
    assert.equal(second.details.rubric.task, 3);
    assert.equal(f.log.activityStreak(new Date('2026-09-11T12:00:00+08:00')), 2);
  } finally { f.close(); }
});

test('練習分數成對驗證，錯誤輸入不留下事實行', () => {
  const f = fixture();
  try {
    assert.throws(() => f.log.practice({ skill: 'XX', durationSec: 1 }), /不認得的科目/);
    assert.throws(() => f.log.practice({ skill: 'CO', durationSec: 1, score: 20 }), /一起填/);
    assert.throws(() => f.log.practice({ skill: 'CO', durationSec: 1, score: 26, maxScore: 25 }), /不能高於/);
    assert.equal(f.log.info().exists, false);
  } finally { f.close(); }
});

test('模考一次保存四科，並算出可核對的總分', () => {
  const f = fixture();
  try {
    const scores = Object.fromEntries(['CE', 'PE', 'CO', 'PO'].map((skill, i) => [skill, { score: 12 + i, maxScore: 25 }]));
    const row = f.log.mock({ day: '2026-09-10', source: '樣題', scores });
    assert.equal(row.total, 54);
    assert.equal(row.maxTotal, 100);
    assert.equal(f.log.summary().mocks[0].source, '樣題');
    assert.throws(() => f.log.mock({ day: '2026-09-10', scores: { CE: scores.CE } }), /缺少分數/);
    assert.throws(() => f.log.mock({ day: '2026-02-31', scores }), /日期需要/);
  } finally { f.close(); }
});

test('索引可由 attempts.jsonl 重建，壞行會回報而不吃掉好行', async () => {
  const f = fixture();
  try {
    const row = f.log.practice({ skill: 'PO', durationSec: 600 });
    const badScore = { ...row, id: 'bad-score', score: 30, maxScore: 25 };
    writeFileSync(path.join(f.dir, 'attempts.jsonl'), `${JSON.stringify(row)}\n壞掉\n${JSON.stringify(badScore)}\n`, 'utf8');
    f.db.exec('DELETE FROM practice_events');
    const rebuilt = await f.log.reindex();
    assert.equal(rebuilt.applied, 1);
    assert.equal(rebuilt.skipped, 2);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM practice_events').get().n, 1);
    const audit = await f.log.audit();
    assert.equal(audit.inSync, false);
    assert.equal(audit.bad[0].line, 2);
  } finally { f.close(); }
});
