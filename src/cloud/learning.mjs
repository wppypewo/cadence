/** 雲端學習端點：資料留在 Supabase，Vercel Function 只做排程與批改。 */

import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { grade, gradeNom, gradePick, gradeRewrite } from '../engine/grade.mjs';
import { createScheduler } from '../engine/fsrs.mjs';
import { buildToday } from '../engine/today.mjs';
import { restRequest, CloudError } from './supabase.mjs';
import { readSettings, recordReview } from './data.mjs';

const DAY_MS = 86_400_000;
const KINDS = ['vocab-recall', 'vocab-produce', 'conj', 'connector', 'pick', 'rw', 'nom'];
const LEVELS = ['A2', 'B1', 'B2'];
const CHECKIN_SKILLS = ['PE', 'CO', 'PO'];

export async function cloudSummary(config, auth, fetchImpl = fetch) {
  const dash = await dashboard(config, auth, fetchImpl);
  const meta = await readMeta(config, auth, fetchImpl);
  return {
    ...dash.summary,
    byKind: dash.byKind,
    streakDays: dash.streakDays,
    backup: { pendingFacts: null, cloud: true },
    settings: dash.settings,
    meta,
    cloudReady: dash.summary.totalCards > 0,
  };
}

export async function today(config, auth, fetchImpl = fetch) {
  const dash = await dashboard(config, auth, fetchImpl);
  const value = buildToday({
    byKind: dash.byKind,
    newLimit: dash.settings.dailyNewLimit,
    newToday: dash.newToday,
    startLevel: dash.settings.startLevel,
    examDate: dash.settings.examDate,
    reviewsToday: dash.summary.todayReviews,
    streakDays: dash.streakDays,
    checkins: dash.checkins,
    practiceToday: dash.practiceToday,
    now: taipeiNoon(dash.day),
  });
  return { ...value, day: dash.day };
}

export async function queue(config, auth, query, fetchImpl = fetch) {
  const kinds = listParam(query?.kinds, KINDS);
  const levels = listParam(query?.levels, LEVELS);
  const limit = clampInt(query?.limit, 1, 200, 20);
  const preset = query?.preset ? String(query.preset) : null;
  if (preset && preset !== 'weak') throw new CloudError(400, `不認得的練習模式：${preset}`);
  const day = taipeiDay();
  const result = await rpc(config, auth, 'cadence_queue', {
    p_limit: limit,
    p_kinds: kinds,
    p_levels: levels,
    p_due_before: dueBefore(day),
    p_today: day,
    p_weak: preset === 'weak',
  }, fetchImpl);
  return {
    ...result,
    cards: result.cards.map((card) => stripAnswer({ ...card, id: sealCardId(config.tokenSecret, card.id) })),
  };
}

export async function reveal(config, auth, query, fetchImpl = fetch) {
  const cardId = openCardId(config.tokenSecret, String(query?.id ?? ''));
  const [card, state, settings] = await Promise.all([
    readCard(config, auth, cardId, fetchImpl),
    readState(config, auth, cardId, fetchImpl),
    readSettings(config, auth, fetchImpl),
  ]);
  if (card.kind !== 'vocab-recall' || card.mode !== 'self') {
    throw new CloudError(400, '只有看字回想題可以翻面');
  }
  const scheduler = createScheduler({ desiredRetention: settings.desiredRetention });
  const elapsed = state ? Math.max(0, (Date.now() - Date.parse(state.last_review)) / DAY_MS) : 0;
  const base = state ? { stability: state.stability, difficulty: state.difficulty } : null;
  const front = card.front ?? {};
  return {
    gloss: front.gloss ?? card.answer ?? null,
    en: front.en ?? null,
    glossSource: front.glossSource ?? null,
    examples: front.examples ?? [],
    intervals: [1, 2, 3, 4].map((rating) => scheduler.review(base, rating, elapsed).intervalDays),
  };
}

export async function preview(config, auth, query, fetchImpl = fetch) {
  const cardId = openCardId(config.tokenSecret, String(query?.id ?? ''));
  const [card, state] = await Promise.all([
    readCard(config, auth, cardId, fetchImpl),
    readState(config, auth, cardId, fetchImpl),
  ]);
  if (card.kind !== 'nom' && card.kind !== 'rw') {
    throw new CloudError(400, '只有名詞化與改寫整句的新卡可以先看解答');
  }
  if (state) throw new CloudError(400, '這張卡已經學過，不能先看解答');
  return { answer: card.answer ?? null, note: card.note ?? null };
}

export async function review(config, auth, body, fetchImpl = fetch) {
  if (!body?.cardId) throw new CloudError(400, '缺少 cardId');
  const cardId = openCardId(config.tokenSecret, String(body.cardId));
  const [card, previous, settings] = await Promise.all([
    readCard(config, auth, cardId, fetchImpl),
    readState(config, auth, cardId, fetchImpl),
    readSettings(config, auth, fetchImpl),
  ]);

  const suppliedRating = Number.isInteger(body.rating);
  let rating = body.rating;
  let result = null;
  let correct = null;
  if (card.kind === 'rw') {
    const graded = gradeRewrite(body.answer ?? '', card.must ?? []);
    if (!graded.correct) {
      result = graded;
      rating = 1;
      correct = false;
    } else if (!Number.isInteger(body.rating)) {
      return {
        phase: 'self', grade: graded, answer: card.answer ?? null,
        note: card.note ?? null, src: card.front?.src ?? null,
      };
    } else {
      result = graded;
      rating = body.rating;
      correct = rating > 1;
    }
  } else if (card.kind === 'nom') {
    result = gradeNom(body.answer ?? '', card.accept ?? [card.answer], card.noun ?? '');
    rating = result.correct ? 3 : 1;
  } else if (card.kind === 'pick') {
    result = gradePick(body.answer ?? '', card.answer, card.front?.options ?? []);
    rating = result.correct ? 3 : 1;
  } else if (card.mode === 'typed' || card.mode === 'choice') {
    result = grade(body.answer ?? '', card.accept ?? [card.answer]);
    rating = result.correct ? (result.reason === 'exact' ? 3 : 2) : 1;
  }
  if (!Number.isInteger(rating) || rating < 1 || rating > 4) {
    throw new CloudError(400, 'rating 必須是 1..4 的整數');
  }

  const now = new Date();
  const elapsed = previous ? Math.max(0, (now - new Date(previous.last_review)) / DAY_MS) : 0;
  const scheduler = createScheduler({ desiredRetention: settings.desiredRetention });
  const next = scheduler.review(
    previous ? { stability: previous.stability, difficulty: previous.difficulty } : null,
    rating,
    elapsed,
  );
  const eventId = randomUUID();
  const studyDay = taipeiDay(now);
  const isCorrect = correct ?? (result ? result.correct : rating > 1);
  const entry = {
    v: 1, type: 'review', id: eventId, card: cardId,
    at: now.toISOString(), day: studyDay, rating,
    elapsed: Number(elapsed.toFixed(6)), answered: body.answer ?? null,
    correct: isCorrect, reason: result?.reason ?? null,
    ms: Number.isFinite(body.ms) ? Math.max(0, Math.round(body.ms)) : null,
    selfRated: suppliedRating && (card.mode === 'self' || card.kind === 'rw'),
  };

  const due = new Date(now.getTime() + next.intervalDays * DAY_MS).toISOString();
  const lapses = (previous?.lapses ?? 0) + (rating === 1 ? 1 : 0);
  const reps = (previous?.reps ?? 0) + 1;
  await recordReview(config, auth, {
    event_id: eventId,
    event_type: 'review',
    target_event_id: null,
    card_id: cardId,
    at: entry.at,
    study_day: studyDay,
    rating,
    elapsed_days: entry.elapsed,
    answered: entry.answered,
    correct: entry.correct,
    reason: entry.reason,
    response_ms: entry.ms,
    self_rated: entry.selfRated,
    payload: entry,
  }, {
    card_id: cardId,
    stability: next.stability, difficulty: next.difficulty,
    due, last_review: entry.at, reps, lapses,
    version: (previous?.version ?? 0) + 1,
    updated_at: entry.at,
  }, fetchImpl);

  return {
    phase: 'done', reviewId: eventId, selfRated: entry.selfRated,
    rating, grade: result,
    answer: card.kind === 'vocab-recall' ? card.front?.gloss ?? null : card.answer ?? null,
    en: card.kind === 'vocab-recall' ? card.front?.en ?? null : null,
    glossSource: card.kind === 'vocab-recall' ? card.front?.glossSource ?? null : null,
    examples: card.kind === 'vocab-recall' || card.kind === 'vocab-produce' ? card.front?.examples ?? [] : [],
    accept: card.accept ?? null,
    note: card.note ?? null,
    fn: card.kind === 'connector' ? card.front?.fn ?? null : null,
    state: {
      stability: next.stability, difficulty: next.difficulty, due,
      reps, lapses, intervalDays: next.intervalDays,
    },
  };
}

export async function checkin(config, auth, body, fetchImpl = fetch) {
  const skill = String(body?.skill ?? '');
  if (!CHECKIN_SKILLS.includes(skill)) {
    throw new CloudError(400, `只有 ${CHECKIN_SKILLS.join('／')} 可以打卡，收到 ${skill || '空值'}`);
  }
  const at = new Date();
  const payload = { v: 1, skill, day: taipeiDay(at), done: body?.done !== false, at: at.toISOString() };
  await restRequest(config, 'checkin_events', {
    method: 'POST', token: auth.token, prefer: 'return=minimal', fetchImpl,
    body: {
      owner_id: auth.user.id, event_id: randomUUID(), skill,
      study_day: payload.day, done: payload.done, at: payload.at, payload,
    },
  });
  return today(config, auth, fetchImpl);
}

export async function search(config, auth, query, fetchImpl = fetch) {
  const q = String(query?.q ?? '').trim();
  if (!q) return { hits: [], total: 0, groups: 0, truncated: false };
  return rpc(config, auth, 'cadence_search', { p_query: q, p_limit: 200 }, fetchImpl);
}

export async function weekly(config, auth, fetchImpl = fetch) {
  const from = new Date(Date.now() - 6 * DAY_MS).toISOString();
  const { data } = await restRequest(config,
    `card_states?stability=gte.21&last_review=gte.${encodeURIComponent(from)}&select=card_id,stability,last_review,cards!inner(payload)&order=last_review.desc&limit=40`,
    { token: auth.token, fetchImpl });
  return {
    window: 7,
    from: taipeiDay(new Date(Date.now() - 6 * DAY_MS)),
    to: taipeiDay(),
    items: data.map((row) => maturedItem(row.cards.payload, row)),
    matureTotal: await matureCount(config, auth, fetchImpl),
  };
}

export async function outlook(config, auth, fetchImpl = fetch) {
  const dash = await dashboard(config, auth, fetchImpl);
  const examDate = dash.settings.examDate;
  if (!examDate) return { examDate: null };
  const daysUntilExam = Math.round((Date.parse(`${examDate}T00:00:00+08:00`) - Date.parse(`${dash.day}T00:00:00+08:00`)) / DAY_MS);
  const expectedRecall = dash.summary.matureCards;
  return {
    examDate, daysUntilExam, window: 7,
    windowReviews: dash.summary.todayReviews,
    pace: Math.round(dash.summary.todayReviews / 7),
    cardsInScope: dash.summary.totalCards,
    expectedRecall,
    studiedByExam: dash.summary.seenCards,
    stoppedRecall: expectedRecall,
  };
}

export function sentence() {
  return { total: 0, sentence: null };
}

async function dashboard(config, auth, fetchImpl) {
  const day = taipeiDay();
  const data = await rpc(config, auth, 'cadence_dashboard', {
    p_today: day, p_due_before: dueBefore(day),
  }, fetchImpl);
  return { ...data, day };
}

async function rpc(config, auth, name, body, fetchImpl) {
  const { data } = await restRequest(config, `rpc/${name}`, {
    method: 'POST', token: auth.token, body, fetchImpl,
  });
  return data;
}

async function readCard(config, auth, id, fetchImpl) {
  const { data } = await restRequest(config,
    `cards?id=eq.${encodeURIComponent(id)}&select=payload&limit=1`,
    { token: auth.token, fetchImpl });
  const card = data?.[0]?.payload;
  if (!card) throw new CloudError(404, '找不到這張卡；請重新載入題目');
  return card;
}

async function readState(config, auth, cardId, fetchImpl) {
  const { data } = await restRequest(config,
    `card_states?card_id=eq.${encodeURIComponent(cardId)}&select=*&limit=1`,
    { token: auth.token, fetchImpl });
  return data?.[0] ?? null;
}

async function readMeta(config, auth, fetchImpl) {
  const { data } = await restRequest(config,
    'reference_entries?entry_type=eq.meta&entry_key=eq.bank&select=payload&limit=1',
    { token: auth.token, fetchImpl });
  return data?.[0]?.payload ?? null;
}

async function matureCount(config, auth, fetchImpl) {
  const { response } = await restRequest(config, 'card_states?stability=gte.21&select=card_id&limit=1', {
    token: auth.token, prefer: 'count=exact', range: '0-0', fetchImpl,
  });
  const match = (response.headers.get('content-range') ?? '').match(/\/(\d+)$/);
  return match ? Number(match[1]) : 0;
}

function maturedItem(card, state) {
  const front = card.front ?? {};
  const label = front.word ?? front.connector ?? front.base ?? card.answer ?? card.id;
  return {
    id: card.id, kind: card.kind, day: taipeiDay(new Date(state.last_review)),
    stability: Math.round(state.stability), label,
    sub: front.gloss ?? front.zh ?? front.prompt ?? null,
  };
}

function sealCardId(secret, id) {
  const key = Buffer.from(secret, 'hex');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(id, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}

function openCardId(secret, token) {
  try {
    const raw = Buffer.from(token, 'base64url');
    if (raw.length < 29) throw new Error('short');
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(secret, 'hex'), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    throw new CloudError(400, '題目代號已失效，請重新載入');
  }
}

function stripAnswer(card) {
  const { answer, accept, note, must, noun, tags, ...rest } = card;
  const front = { ...(rest.front ?? {}) };
  if (card.kind === 'vocab-recall') {
    delete front.gloss;
    delete front.en;
    delete front.glossSource;
  }
  if (card.kind === 'vocab-recall' || card.kind === 'vocab-produce') delete front.examples;
  if (card.kind === 'vocab-produce') delete front.word;
  if (card.kind === 'connector') {
    delete front.moodRaw;
    delete front.fn;
  }
  return { ...rest, front };
}

function listParam(raw, allowed) {
  if (!raw) return [];
  const values = String(raw).split(',').map((v) => v.trim()).filter(Boolean);
  const bad = values.filter((v) => !allowed.includes(v));
  if (bad.length) throw new CloudError(400, `不認得的參數：${bad.join(', ')}`);
  return values;
}

function taipeiDay(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function dueBefore(day) {
  return new Date(Date.parse(`${day}T00:00:00+08:00`) + DAY_MS).toISOString();
}

function taipeiNoon(day) {
  return new Date(`${day}T12:00:00+08:00`);
}

function clampInt(raw, min, max, fallback) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.round(value), min), max);
}
