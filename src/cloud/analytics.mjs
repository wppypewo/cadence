/** 雲端統計、推演與追加式評分更正。 */

import { randomUUID } from 'node:crypto';
import { simulate, solveDailyNew, ratingDistribution } from '../engine/forecast.mjs';
import { createScheduler } from '../engine/fsrs.mjs';
import { readCheck } from '../engine/lexicon.mjs';
import { restRequest, CloudError } from './supabase.mjs';
import { readSettings, recordReview } from './data.mjs';
import { summarizePractice } from './practice.mjs';

const DAY_MS = 86_400_000;
const KINDS = ['vocab-recall', 'vocab-produce', 'conj', 'connector', 'pick', 'rw', 'nom'];
const LEVELS = ['A2', 'B1', 'B2'];
const DEFAULT_SECONDS = 8;
const OUTLOOK_WINDOW = 7;

export async function cloudStats(config, auth, query, fetchImpl = fetch) {
  const days = clampInt(query?.days, 7, 365, 120);
  const upcomingDays = clampInt(query?.upcoming, 7, 180, 30);
  const weakestLimit = clampInt(query?.weakest, 1, 100, 24);
  const scope = parseScope(query);
  const [cards, states, reviewRows, attempts, dashboard] = await Promise.all([
    readAll(config, auth, 'cards?select=id,kind,level&order=id.asc', fetchImpl),
    readAll(config, auth, 'card_states?select=card_id,stability,difficulty,due,last_review,reps,lapses&order=card_id.asc', fetchImpl),
    readReviews(config, auth, fetchImpl),
    readPayloads(config, auth, 'practice_events', 'at.desc,event_id.asc', fetchImpl),
    rpc(config, auth, 'cadence_dashboard', { p_today: taipeiDay(), p_due_before: dueBefore(taipeiDay()) }, fetchImpl),
  ]);
  const stateById = new Map(states.map((state) => [state.card_id, state]));
  const scopedCards = applyScope(cards, stateById, scope);
  const ids = new Set(scopedCards.map((card) => card.id));
  const reviews = effectiveReviews(reviewRows).filter((row) => row.card_id && ids.has(row.card_id));
  const today = taipeiDay();
  const tomorrow = Date.parse(dueBefore(today));
  const scopedStates = scopedCards.map((card) => stateById.get(card.id)).filter(Boolean);
  const summary = {
    totalCards: scopedCards.length,
    seenCards: scopedStates.length,
    matureCards: scopedStates.filter((state) => state.stability >= 21).length,
    dueNow: scopedStates.filter((state) => Date.parse(state.due) < tomorrow).length,
    newCount: scopedCards.length - scopedStates.length,
    newCards: scopedCards.length - scopedStates.length,
    todayReviews: reviews.filter((row) => row.study_day === today).length,
    todayCorrect: reviews.filter((row) => row.study_day === today && row.correct === true).length,
    totalReviews: reviews.length,
    streakDays: dashboard.streakDays,
  };

  const byKind = [...new Set(scopedCards.map((card) => card.kind))].sort().map((kind) => {
    const list = scopedCards.filter((card) => card.kind === kind);
    const withState = list.map((card) => stateById.get(card.id)).filter(Boolean);
    return {
      kind,
      total: list.length,
      seen: withState.length,
      mature: withState.filter((state) => state.stability >= 21).length,
      due: withState.filter((state) => Date.parse(state.due) < tomorrow).length,
      fresh: list.length - withState.length,
    };
  });

  const fromDay = taipeiDay(new Date(Date.now() - (days - 1) * DAY_MS));
  const dailyMap = new Map();
  for (const row of reviews) {
    if (row.study_day < fromDay) continue;
    const value = dailyMap.get(row.study_day) ?? { day: row.study_day, count: 0, correct: 0 };
    value.count += 1;
    if (row.correct === true) value.correct += 1;
    dailyMap.set(row.study_day, value);
  }
  const daily = [...dailyMap.values()].sort((a, b) => a.day.localeCompare(b.day));

  const until = Date.now() + upcomingDays * DAY_MS;
  let backlog = 0;
  const dueBuckets = new Map();
  for (const state of scopedStates) {
    const at = Date.parse(state.due);
    if (at > until) continue;
    const day = taipeiDay(new Date(at));
    if (day <= today) backlog += 1;
    else dueBuckets.set(day, (dueBuckets.get(day) ?? 0) + 1);
  }
  const upcoming = {
    backlog,
    days: [...dueBuckets].sort(([a], [b]) => a.localeCompare(b)).map(([day, count]) => ({ day, count })),
  };

  const weakStates = scopedStates.filter((state) => state.lapses > 0)
    .sort((a, b) => b.lapses - a.lapses || Date.parse(b.last_review) - Date.parse(a.last_review))
    .slice(0, weakestLimit);
  const weakCards = await Promise.all(weakStates.map((state) => readCardPayload(config, auth, state.card_id, fetchImpl)));
  const latestByCard = new Map();
  for (const row of reviews) latestByCard.set(row.card_id, row);
  const weakest = weakStates.map((state, index) => ({
    lapses: state.lapses,
    lastReason: latestByCard.get(state.card_id)?.reason ?? null,
    card: keepWeakAnswer(weakCards[index]),
  }));

  const reasons = new Map();
  for (const row of reviews) {
    if (row.correct !== false || !row.reason) continue;
    reasons.set(row.reason, (reasons.get(row.reason) ?? 0) + 1);
  }
  const errorProfile = [...reasons].map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));

  return {
    scope: { ...scope, active: true },
    periodDays: days,
    summary,
    byKind,
    daily,
    upcoming,
    weakest,
    errorProfile,
    journal: journalInfo(reviewRows.map((row) => row.payload)),
    practice: summarizePractice(attempts, days),
    attemptsJournal: journalInfo(attempts),
  };
}

export async function cloudForecast(config, auth, query, fetchImpl = fetch) {
  const examDay = String(query?.exam ?? '');
  if (!validDay(examDay)) throw new CloudError(400, 'exam 需要 YYYY-MM-DD 格式的日期');
  const today = taipeiDay();
  if (examDay < today) throw new CloudError(400, '考試日期已經過了');
  const scope = parseScope(query);
  const { cards, reviews, ratings, secondsPerCard, settings } = await simulationInputs(config, auth, scope, fetchImpl);
  const base = {
    cards,
    // Vercel 執行環境是 UTC；用 UTC 中午承載「日曆日期」，避免台北午夜
    // 換算成前一天 16:00Z 後再被模擬器截成前一天。
    from: cloudCalendarDate(today),
    examDate: cloudCalendarDate(examDay),
    dailyLimit: clampInt(query?.limit, 5, 500, 60),
    desiredRetention: settings.desiredRetention,
    ratings,
    secondsPerCard,
  };
  const plan = simulate({
    ...base,
    dailyNew: clampInt(query?.new, 0, 200, settings.dailyNewLimit ?? 15),
  });
  const target = query?.target === undefined || query?.target === '' ? null : Number(query.target);
  if (target !== null && (!Number.isFinite(target) || target <= 0 || target > 1)) {
    throw new CloudError(400, 'target 需要是 0 到 1 之間的比例');
  }
  const solved = target === null ? null : solveDailyNew({ ...base, target });
  return {
    plan,
    solved: solved && {
      ...solved,
      recommended: dropResult(solved.recommended),
      ceiling: dropResult(solved.ceiling),
    },
    inputs: {
      ratingSample: ratings?.sample ?? 0,
      secondsPerCard,
      secondsSource: secondsPerCard === DEFAULT_SECONDS ? 'default' : 'observed',
      scope: { ...scope, active: true },
    },
  };
}

/**
 * 今天頁開場那一句：照最近 7 天的節奏做到考試，那天大約記得幾張；完全停下來又剩幾張。
 *
 * 語意與本機的 Api#outlook 相同（src/api.mjs），模擬輸入與推演頁的 cloudForecast 同一份，
 * 兩頁的數字才對得起來。舊版拿「今天的作答數」當 7 天量、stoppedRecall 直接填已熟記張數，
 * 今天沒練時開場就說「照這樣」的數字是 0 題的推演，而停練的那一半根本沒算。
 */
export async function cloudOutlook(config, auth, fetchImpl = fetch) {
  const today = taipeiDay();
  const settings = await readSettings(config, auth, fetchImpl);
  const examDay = settings.examDate;
  if (!examDay || !validDay(examDay) || examDay < today) return { examDate: null };

  const { cards, reviews, ratings, secondsPerCard } = await simulationInputs(config, auth, parseScope({}), fetchImpl, settings);
  const fromDay = taipeiDay(new Date(Date.parse(`${today}T12:00:00+08:00`) - (OUTLOOK_WINDOW - 1) * DAY_MS));
  // 撤銷與評分更正是另外追加的事件，effectiveReviews 只留 review 本身，次數不會重複算。
  const windowReviews = reviews.filter((row) => (row.study_day ?? taipeiDay(new Date(row.at))) >= fromDay).length;
  const pace = Math.round(windowReviews / OUTLOOK_WINDOW);
  const base = {
    cards,
    from: cloudCalendarDate(today),
    examDate: cloudCalendarDate(examDay),
    desiredRetention: settings.desiredRetention,
    ratings,
    secondsPerCard,
  };
  // 新卡設成不設上限時，新卡就吃掉整個節奏裡複習沒用完的額度，與本機一致。
  const dailyNew = Math.min(settings.dailyNewLimit ?? pace, pace);
  const going = simulate({ ...base, dailyLimit: pace, dailyNew });
  const stopped = simulate({ ...base, dailyLimit: 0, dailyNew: 0 });
  return {
    examDate: examDay,
    daysUntilExam: going.daysUntilExam,
    window: OUTLOOK_WINDOW,
    windowReviews,
    pace,
    cardsInScope: going.cardsInScope,
    expectedRecall: Math.round(going.expectedRecall),
    studiedByExam: going.studiedByExam,
    stoppedRecall: Math.round(stopped.expectedRecall),
  };
}

export async function cloudSentence(config, auth, query, fetchImpl = fetch) {
  const [sentenceCards, vocabCards, states] = await Promise.all([
    readAll(config, auth, 'cards?kind=in.(pick,rw)&select=id,kind,payload&order=id.asc', fetchImpl),
    readAll(config, auth, 'cards?kind=eq.vocab-recall&select=id,headword&order=id.asc', fetchImpl),
    readAll(config, auth, 'card_states?select=card_id,stability&order=card_id.asc', fetchImpl),
  ]);
  const stateById = new Map(states.map((row) => [row.card_id, row]));
  const pool = [];
  for (const row of sentenceCards) {
    const card = row.payload;
    if (row.kind === 'pick' && card.front?.prompt) {
      pool.push({ id: row.id, kind: row.kind, text: card.front.prompt, src: card.front.src ?? null });
    } else if (row.kind === 'rw' && stateById.has(row.id) && card.answer) {
      pool.push({ id: row.id, kind: row.kind, text: card.answer, src: card.front?.src ?? null });
    }
  }
  if (!pool.length) return { total: 0, sentence: null };
  const seed = [...taipeiDay()].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 100_003, 7);
  const wanted = query?.i === undefined ? seed : Number.parseInt(query.i, 10);
  if (!Number.isInteger(wanted)) throw new CloudError(400, 'i 需要是整數');
  const index = ((wanted % pool.length) + pool.length) % pool.length;
  const picked = pool[index];
  const words = new Set(vocabCards.map((row) => String(row.headword ?? '').toLowerCase()).filter(Boolean));
  const best = new Map();
  for (const row of vocabCards) {
    const stability = stateById.get(row.id)?.stability;
    // 上面建 words 時已經處理過 headword 為 null 的列，這裡也要，否則一張缺 headword 的卡就讓整頁 500
    const word = String(row.headword ?? '').toLowerCase();
    if (stability !== undefined && word) best.set(word, Math.max(best.get(word) ?? 0, stability));
  }
  const { tokens, counts } = readCheck(
    picked.text,
    { has: (word) => words.has(word), verbOf: () => null },
    (word) => !best.has(word) ? 'fresh' : best.get(word) >= 21 ? 'mature' : 'seen',
  );
  return { total: pool.length, index, sentence: { ...picked, tokens, counts } };
}

export async function correctCloudReview(config, auth, body, fetchImpl = fetch) {
  const target = String(body?.id ?? '');
  const rating = Number(body?.rating);
  if (!target) throw new CloudError(400, '缺少要更正的作答 id');
  if (!Number.isInteger(rating) || rating < 1 || rating > 4) {
    throw new CloudError(400, 'rating 必須是 1..4 的整數');
  }
  const [rows, settings] = await Promise.all([
    readReviews(config, auth, fetchImpl),
    readSettings(config, auth, fetchImpl),
  ]);
  const originals = rows.filter((row) => row.event_type === 'review')
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const latest = originals.at(-1);
  if (!latest || latest.event_id !== target) throw new CloudError(400, '只能更正剛才那一筆作答');
  if (!latest.self_rated) throw new CloudError(400, '自動批改的答案不能改成人工評分');

  const now = new Date();
  const eventId = randomUUID();
  const payload = { v: 2, type: 'rating-correction', id: eventId, target, rating, at: now.toISOString() };
  const corrections = new Map(rows.filter((row) => row.event_type === 'rating-correction')
    .map((row) => [row.target_event_id, row.rating]));
  corrections.set(target, rating);
  const history = originals.filter((row) => row.card_id === latest.card_id);
  const scheduler = createScheduler({ desiredRetention: settings.desiredRetention });
  let state = null;
  let lastReview = null;
  let reps = 0;
  let lapses = 0;
  for (const row of history) {
    const effectiveRating = corrections.get(row.event_id) ?? row.rating;
    state = scheduler.review(state, effectiveRating, row.elapsed_days ?? 0);
    lastReview = row.at;
    reps += 1;
    if (effectiveRating === 1) lapses += 1;
  }
  const due = new Date(Date.parse(lastReview) + state.intervalDays * DAY_MS).toISOString();
  // version 是單張卡的樂觀鎖計數（cadence_record_review 只接受「目前版本 + 1」），
  // 要從這張卡現在的狀態讀，不能用 reps 加全帳號的更正筆數去湊。
  const current = await readCardVersion(config, auth, latest.card_id, fetchImpl);
  await recordReview(config, auth, {
    event_id: eventId, event_type: 'rating-correction',
    target_event_id: target, card_id: latest.card_id, at: payload.at,
    study_day: taipeiDay(now), rating, correct: rating > 1, payload,
  }, {
    card_id: latest.card_id,
    stability: state.stability, difficulty: state.difficulty, due,
    last_review: lastReview, reps, lapses,
    version: current + 1, updated_at: payload.at,
  }, fetchImpl);
  return {
    id: eventId, target, rating,
    state: {
      stability: state.stability, difficulty: state.difficulty, due, reps, lapses,
      intervalDays: state.intervalDays,
    },
    rebuilt: history.length,
  };
}

/** 推演頁與今天頁共用的模擬輸入。卡、狀態、作答紀錄都整份讀，與 cloudForecast 原本的讀法相同。 */
async function simulationInputs(config, auth, scope, fetchImpl, knownSettings = null) {
  const [cards, states, reviewRows, settings] = await Promise.all([
    readAll(config, auth, 'cards?select=id,kind,level&order=id.asc', fetchImpl),
    readAll(config, auth, 'card_states?select=card_id,stability,difficulty,due,last_review,reps,lapses&order=card_id.asc', fetchImpl),
    readReviews(config, auth, fetchImpl),
    knownSettings ?? readSettings(config, auth, fetchImpl),
  ]);
  const stateById = new Map(states.map((state) => [state.card_id, state]));
  const scoped = applyScope(cards, stateById, scope);
  const cardIds = new Set(cards.map((card) => card.id));
  const simulationCards = scoped.map((card) => {
    const state = stateById.get(card.id);
    if (state) return { id: card.id, kind: card.kind, level: card.level, ...state };
    const prerequisite = card.kind === 'vocab-produce' && card.id.endsWith('|p')
      && cardIds.has(`${card.id.slice(0, -1)}r`) && !stateById.has(`${card.id.slice(0, -1)}r`)
      ? `${card.id.slice(0, -1)}r` : null;
    return prerequisite ? { ...card, prerequisite } : card;
  });
  const reviews = effectiveReviews(reviewRows);
  return {
    cards: simulationCards,
    reviews,
    ratings: ratingDistribution(reviews.filter((row) => row.correct === true)),
    secondsPerCard: medianSeconds(reviews),
    settings,
  };
}

async function readReviews(config, auth, fetchImpl) {
  return readAll(config, auth,
    'review_events?select=event_id,event_type,target_event_id,card_id,at,study_day,rating,elapsed_days,answered,correct,reason,response_ms,self_rated,payload&order=at.asc,event_id.asc',
    fetchImpl);
}

async function readPayloads(config, auth, table, order, fetchImpl) {
  const rows = await readAll(config, auth, `${table}?select=payload&order=${order}`, fetchImpl);
  return rows.map((row) => row.payload);
}

/**
 * 用 Range 每次 1000 列翻頁。PostgREST 沒有 order 時順序不固定，排序鍵有重複時同值的列
 * 在兩頁之間的先後也不固定，翻頁就會重複或漏列（owner-cli.mjs 的 readAll 是同一個坑）。
 * 所以 path 必須帶 order，而且最後一個鍵要唯一：RLS 只回自己的列，owner_id 固定，
 * 主鍵剩下的 id／card_id／event_id 就夠。
 */
async function readAll(config, auth, path, fetchImpl) {
  if (!/[?&]order=/.test(path)) throw new Error(`readAll 需要唯一排序：${path}`);
  const out = [];
  const page = 1000;
  for (let offset = 0; ; offset += page) {
    const { data } = await restRequest(config, path, {
      token: auth.token, range: `${offset}-${offset + page - 1}`, fetchImpl,
    });
    out.push(...data);
    if (data.length < page) return out;
  }
}

async function readCardVersion(config, auth, cardId, fetchImpl) {
  const { data } = await restRequest(config,
    `card_states?card_id=eq.${encodeURIComponent(cardId)}&select=version&limit=1`,
    { token: auth.token, fetchImpl });
  return Number(data?.[0]?.version ?? 0);
}

async function readCardPayload(config, auth, id, fetchImpl) {
  const { data } = await restRequest(config,
    `cards?id=eq.${encodeURIComponent(id)}&select=payload&limit=1`,
    { token: auth.token, fetchImpl });
  return data?.[0]?.payload ?? { id };
}

async function rpc(config, auth, name, body, fetchImpl) {
  const { data } = await restRequest(config, `rpc/${name}`, {
    method: 'POST', token: auth.token, body, fetchImpl,
  });
  return data;
}

function effectiveReviews(rows) {
  const corrections = new Map();
  for (const row of rows) {
    if (row.event_type === 'rating-correction' && row.target_event_id) corrections.set(row.target_event_id, row.rating);
  }
  return rows.filter((row) => row.event_type === 'review').map((row) => {
    const rating = corrections.get(row.event_id) ?? row.rating;
    return corrections.has(row.event_id) ? { ...row, rating, correct: rating > 1 } : row;
  });
}

function parseScope(query) {
  return {
    kinds: listParam(query?.kinds, KINDS),
    levels: listParam(query?.levels, LEVELS),
  };
}

function applyScope(cards, stateById, scope) {
  return cards.filter((card) => {
    if (scope.kinds.length && !scope.kinds.includes(card.kind)) return false;
    if (scope.levels.length) return scope.levels.includes(card.level);
    return LEVELS.includes(card.level) || stateById.has(card.id);
  });
}

function listParam(raw, allowed) {
  if (!raw) return [];
  const values = String(raw).split(',').map((value) => value.trim()).filter(Boolean);
  const bad = values.filter((value) => !allowed.includes(value));
  if (bad.length) throw new CloudError(400, `不認得的參數：${bad.join(', ')}`);
  return values;
}

function keepWeakAnswer(card) {
  if (!card) return card;
  const { accept, must, noun, tags, ...rest } = card;
  return rest;
}

function journalInfo(payloads) {
  const bytes = payloads.reduce((sum, value) => sum + Buffer.byteLength(`${JSON.stringify(value)}\n`), 0);
  return { exists: payloads.length > 0, bytes, lines: payloads.length };
}

function medianSeconds(rows) {
  const values = rows.map((row) => row.response_ms)
    .filter((value) => Number.isFinite(value) && value >= 500 && value <= 120_000)
    .sort((a, b) => a - b);
  if (values.length < 30) return DEFAULT_SECONDS;
  return Math.round((values[Math.floor(values.length / 2)] / 1000) * 10) / 10;
}

function dropResult(entry) {
  if (!entry) return entry;
  const { result, ...rest } = entry;
  return rest;
}

function validDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function cloudCalendarDate(day) {
  return new Date(`${day}T12:00:00Z`);
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

function clampInt(raw, min, max, fallback) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.round(value), min), max);
}
