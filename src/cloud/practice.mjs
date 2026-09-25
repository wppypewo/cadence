/** 四科實作與模考的雲端追加式紀錄。 */

import { randomUUID } from 'node:crypto';
import { restRequest, CloudError } from './supabase.mjs';

export const PRACTICE_SKILLS = ['CE', 'PE', 'CO', 'PO'];

export async function savePractice(config, auth, input, fetchImpl = fetch) {
  let entry;
  try {
    entry = practiceEntry(input ?? {});
  } catch (err) {
    throw new CloudError(400, err.message);
  }
  await insert(config, auth, entry, fetchImpl);
  return entry;
}

export async function saveMock(config, auth, input, fetchImpl = fetch) {
  let entry;
  try {
    entry = mockEntry(input ?? {});
  } catch (err) {
    throw new CloudError(400, err.message);
  }
  await insert(config, auth, entry, fetchImpl);
  return entry;
}

export function summarizePractice(rows, days = 120, now = new Date()) {
  const from = taipeiDay(new Date(now.getTime() - (days - 1) * 86_400_000));
  const inWindow = rows.filter((row) => row?.day >= from)
    .sort((a, b) => (a.day === b.day ? String(b.at).localeCompare(String(a.at)) : b.day.localeCompare(a.day)));
  const practices = inWindow.filter((row) => row.type === 'practice');
  const mocks = inWindow.filter((row) => row.type === 'mock');
  const bySkill = PRACTICE_SKILLS.map((skill) => {
    const list = practices.filter((row) => row.skill === skill);
    const scored = list.filter((row) => row.score !== null && row.maxScore);
    return {
      skill,
      attempts: list.length,
      days: new Set(list.map((row) => row.day)).size,
      minutes: Math.round(list.reduce((sum, row) => sum + row.durationSec, 0) / 60),
      latestDay: list[0]?.day ?? null,
      average: scored.length
        ? scored.reduce((sum, row) => sum + row.score / row.maxScore, 0) / scored.length
        : null,
    };
  });
  return { periodDays: days, bySkill, recent: practices.slice(0, 20), mocks: mocks.slice(0, 10) };
}

export function practiceEntry(input, now = new Date()) {
  const skill = enumValue(input.skill, PRACTICE_SKILLS, '不認得的科目');
  const score = optionalNumber(input.score, 0, 100, '得分');
  const maxScore = optionalNumber(input.maxScore, 0.5, 100, '滿分');
  if ((score === null) !== (maxScore === null)) throw new Error('得分與滿分要一起填');
  if (score !== null && score > maxScore) throw new Error('得分不能高於滿分');
  return {
    v: 1,
    id: randomUUID(),
    type: 'practice',
    skill,
    at: now.toISOString(),
    day: taipeiDay(now),
    source: optionalText(input.source, 120, '題目或來源'),
    durationSec: integer(input.durationSec, 0, 86_400, '練習秒數'),
    score,
    maxScore,
    wordCount: input.wordCount === null || input.wordCount === undefined
      ? null : integer(input.wordCount, 0, 20_000, '字數'),
    text: optionalText(input.text, 20_000, '練習文字'),
    notes: optionalText(input.notes, 4_000, '練習筆記'),
    details: optionalDetails(input.details),
  };
}

export function mockEntry(input, now = new Date()) {
  const day = String(input.day ?? taipeiDay(now));
  if (!validDay(day)) throw new Error('日期需要 YYYY-MM-DD 格式');
  const scores = {};
  for (const skill of PRACTICE_SKILLS) {
    const raw = input.scores?.[skill];
    if (!raw) throw new Error(`${skill} 缺少分數`);
    const score = requiredNumber(raw.score, 0, 100, `${skill} 得分`);
    const maxScore = requiredNumber(raw.maxScore, 0.5, 100, `${skill} 滿分`);
    if (score > maxScore) throw new Error(`${skill} 得分不能高於滿分`);
    scores[skill] = { score, maxScore };
  }
  return {
    v: 1,
    id: randomUUID(),
    type: 'mock',
    skill: null,
    at: now.toISOString(),
    day,
    source: optionalText(input.source, 120, '模考來源'),
    baseline: input.baseline === true,
    scores,
    total: PRACTICE_SKILLS.reduce((sum, skill) => sum + scores[skill].score, 0),
    maxTotal: PRACTICE_SKILLS.reduce((sum, skill) => sum + scores[skill].maxScore, 0),
    notes: optionalText(input.notes, 4_000, '模考檢討'),
  };
}

async function insert(config, auth, entry, fetchImpl) {
  await restRequest(config, 'practice_events', {
    method: 'POST', token: auth.token, prefer: 'return=minimal', fetchImpl,
    body: {
      owner_id: auth.user.id,
      event_id: entry.id,
      event_type: entry.type,
      skill: entry.skill,
      study_day: entry.day,
      at: entry.at,
      payload: entry,
    },
  });
}

function optionalDetails(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('練習細節格式錯誤');
  const text = JSON.stringify(value);
  if (text.length > 8_000) throw new Error('練習細節不能超過 8000 字');
  return JSON.parse(text);
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
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) throw new Error(`${label}超出範圍`);
  return number;
}

function integer(value, min, max, label) {
  const number = Number(value ?? 0);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${label}超出範圍`);
  return number;
}

function enumValue(value, allowed, message) {
  if (!allowed.includes(value)) throw new Error(message);
  return value;
}

function validDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function taipeiDay(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
