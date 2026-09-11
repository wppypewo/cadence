/**
 * 四科實作練習與模考的追加式紀錄。attempts.jsonl 是事實，practice_events
 * 只是查詢鏡像；這裡獨立成模組，避免把 FSRS 的儲存層再塞進另一種排程語意。
 */

import { randomUUID } from 'node:crypto';
import { appendFileSync, createReadStream, existsSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { localDay } from './db.mjs';

export const PRACTICE_SKILLS = ['CE', 'PE', 'CO', 'PO'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS practice_events (
  id      TEXT PRIMARY KEY,
  type    TEXT NOT NULL,
  skill   TEXT,
  at      TEXT NOT NULL,
  day     TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS practice_events_day ON practice_events(day);
CREATE INDEX IF NOT EXISTS practice_events_skill ON practice_events(skill, day);
`;

export class AttemptLog {
  constructor(dataDir, db) {
    this.path = path.join(dataDir, 'attempts.jsonl');
    this.db = db;
    db.exec(SCHEMA);
  }

  practice(input, now = new Date()) {
    const skill = enumValue(input.skill, PRACTICE_SKILLS, '不認得的科目');
    const score = optionalNumber(input.score, 0, 100, '得分');
    const maxScore = optionalNumber(input.maxScore, 0.5, 100, '滿分');
    if ((score === null) !== (maxScore === null)) throw new Error('得分與滿分要一起填');
    if (score !== null && score > maxScore) throw new Error('得分不能高於滿分');
    const entry = {
      v: 1,
      id: randomUUID(),
      type: 'practice',
      skill,
      at: now.toISOString(),
      day: localDay(now),
      source: optionalText(input.source, 120, '題目或來源'),
      durationSec: integer(input.durationSec, 0, 86_400, '練習秒數'),
      score,
      maxScore,
      wordCount: input.wordCount === null || input.wordCount === undefined
        ? null : integer(input.wordCount, 0, 20_000, '字數'),
      text: optionalText(input.text, 20_000, '練習文字'),
      notes: optionalText(input.notes, 4_000, '練習筆記'),
    };
    return this.append(entry);
  }

  mock(input, now = new Date()) {
    const day = String(input.day ?? localDay(now));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(new Date(`${day}T00:00:00`).getTime())) {
      throw new Error('日期需要 YYYY-MM-DD 格式');
    }
    const scores = {};
    for (const skill of PRACTICE_SKILLS) {
      const raw = input.scores?.[skill];
      if (!raw) throw new Error(`${skill} 缺少分數`);
      const score = requiredNumber(raw.score, 0, 100, `${skill} 得分`);
      const maxScore = requiredNumber(raw.maxScore, 0.5, 100, `${skill} 滿分`);
      if (score > maxScore) throw new Error(`${skill} 得分不能高於滿分`);
      scores[skill] = { score, maxScore };
    }
    const total = PRACTICE_SKILLS.reduce((n, skill) => n + scores[skill].score, 0);
    const maxTotal = PRACTICE_SKILLS.reduce((n, skill) => n + scores[skill].maxScore, 0);
    const entry = {
      v: 1,
      id: randomUUID(),
      type: 'mock',
      skill: null,
      at: now.toISOString(),
      day,
      source: optionalText(input.source, 120, '模考來源'),
      scores,
      total,
      maxTotal,
      notes: optionalText(input.notes, 4_000, '模考檢討'),
    };
    return this.append(entry);
  }

  append(entry) {
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`, 'utf8');
    this.apply(entry);
    return entry;
  }

  apply(entry) {
    validateEntry(entry);
    this.db.prepare(
      `INSERT INTO practice_events(id, type, skill, at, day, payload) VALUES(?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET type=excluded.type, skill=excluded.skill,
         at=excluded.at, day=excluded.day, payload=excluded.payload`,
    ).run(entry.id, entry.type, entry.skill ?? null, entry.at, entry.day, JSON.stringify(entry));
  }

  summary({ days = 120, now = new Date() } = {}) {
    const from = localDay(new Date(now.getTime() - (days - 1) * 86_400_000));
    const rows = this.db.prepare(
      `SELECT payload FROM practice_events WHERE day >= ? ORDER BY day DESC, at DESC`,
    ).all(from).map((row) => JSON.parse(row.payload));
    const practices = rows.filter((row) => row.type === 'practice');
    const mocks = rows.filter((row) => row.type === 'mock');
    const bySkill = PRACTICE_SKILLS.map((skill) => {
      const list = practices.filter((row) => row.skill === skill);
      const scored = list.filter((row) => row.score !== null && row.maxScore);
      const distinctDays = new Set(list.map((row) => row.day)).size;
      return {
        skill,
        attempts: list.length,
        days: distinctDays,
        minutes: Math.round(list.reduce((n, row) => n + row.durationSec, 0) / 60),
        latestDay: list[0]?.day ?? null,
        average: scored.length
          ? scored.reduce((n, row) => n + row.score / row.maxScore, 0) / scored.length
          : null,
      };
    });
    return { bySkill, recent: practices.slice(0, 20), mocks: mocks.slice(0, 10) };
  }

  today(now = new Date()) {
    const day = localDay(now);
    return Object.fromEntries(PRACTICE_SKILLS.map((skill) => {
      const row = this.db.prepare(
        `SELECT payload FROM practice_events WHERE type='practice' AND skill=? AND day=? ORDER BY at DESC LIMIT 1`,
      ).get(skill, day);
      return [skill, row ? JSON.parse(row.payload) : null];
    }));
  }

  info() {
    return existsSync(this.path)
      ? { exists: true, bytes: statSync(this.path).size }
      : { exists: false, bytes: 0 };
  }

  async reindex() {
    this.db.exec('DELETE FROM practice_events');
    if (!existsSync(this.path)) return { applied: 0, skipped: 0, bad: [] };
    const rl = createInterface({ input: createReadStream(this.path, 'utf8'), crlfDelay: Infinity });
    let applied = 0;
    let lineNo = 0;
    const bad = [];
    this.db.exec('BEGIN');
    try {
      for await (const line of rl) {
        lineNo += 1;
        if (!line.trim()) continue;
        try {
          this.apply(JSON.parse(line));
          applied += 1;
        } catch (err) {
          bad.push({ line: lineNo, error: err.message });
        }
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return { applied, skipped: bad.length, bad };
  }

  async audit() {
    const info = this.info();
    const expected = [];
    const bad = [];
    let lines = 0;
    if (info.exists) {
      const rl = createInterface({ input: createReadStream(this.path, 'utf8'), crlfDelay: Infinity });
      let lineNo = 0;
      for await (const line of rl) {
        lineNo += 1;
        if (!line.trim()) continue;
        lines += 1;
        try {
          const entry = JSON.parse(line);
          validateEntry(entry);
          expected.push({ id: entry.id, type: entry.type, skill: entry.skill ?? null, at: entry.at, day: entry.day, payload: JSON.stringify(entry) });
        } catch (err) {
          bad.push({ line: lineNo, error: err.message });
        }
      }
    }
    const indexed = this.db.prepare('SELECT id, type, skill, at, day, payload FROM practice_events ORDER BY rowid').all();
    const mismatchAt = firstDifference(expected, indexed);
    return {
      ...info, lines, valid: expected.length, indexed: indexed.length, bad,
      mismatchAt: mismatchAt === null ? null : (bad[mismatchAt]?.line ?? mismatchAt + 1),
      inSync: bad.length === 0 && mismatchAt === null,
    };
  }
}

function validateEntry(entry) {
  if (!entry?.id || !entry.at || !entry.day || !['practice', 'mock'].includes(entry.type)) throw new Error('缺必要欄位');
  if (entry.type === 'practice' && !PRACTICE_SKILLS.includes(entry.skill)) throw new Error('不認得的科目');
  if (entry.type === 'mock' && !entry.scores) throw new Error('模考缺少四科分數');
}

function enumValue(value, allowed, message) {
  if (!allowed.includes(value)) throw new Error(message);
  return value;
}

function optionalText(value, max, label) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (text.length > max) throw new Error(`${label}不能超過 ${max} 字`);
  return text || null;
}

function optionalNumber(value, min, max, label) {
  if (value === null || value === undefined || value === '') return null;
  return requiredNumber(value, min, max, label);
}

function requiredNumber(value, min, max, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${label}超出範圍`);
  return n;
}

function integer(value, min, max, label) {
  const n = Number(value ?? 0);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label}超出範圍`);
  return n;
}

function firstDifference(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i += 1) if (JSON.stringify(a[i] ?? null) !== JSON.stringify(b[i] ?? null)) return i;
  return null;
}
