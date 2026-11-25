import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloudHandler } from '../src/cloud/router.mjs';
import { generateJson } from '../src/cloud/gemini.mjs';
import { peFeedback, gradePe, weeklyDigest, countWords, PE_CRITERIA } from '../src/cloud/ai.mjs';
import { countWords as uiCountWords } from '../web/js/practice.mjs';

const ENV = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
  CADENCE_OWNER_EMAIL: 'ricky@example.com',
  CADENCE_TOKEN_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
};
const KEYED = { ...ENV, GEMINI_API_KEY: 'test-gemini-key' };
const SAME_ORIGIN = {
  cookie: 'cadence_access=valid-token',
  host: 'cadence-wheat-mu.vercel.app', origin: 'https://cadence-wheat-mu.vercel.app', 'x-forwarded-proto': 'https',
};
// 80 個字剛好過「79 字以下全部 0 分」的門檻。
const ESSAY = Array.from({ length: 80 }, (_, i) => (i % 2 ? 'élève' : 'je')).join(' ');

function geminiReply(value, { finishReason = 'STOP', thought = false } = {}) {
  const parts = [{ text: JSON.stringify(value) }];
  if (thought) parts.unshift({ text: '先想一下', thought: true });
  return json({
    candidates: [{ content: { role: 'model', parts }, finishReason }],
    modelVersion: 'gemini-3.8-flash',
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 },
  });
}

function rawGrade(levels, extra = {}) {
  return {
    anomalies: [],
    criteria: PE_CRITERIA.map((criterion, i) => ({ criterion, level: levels[i], quote: 'je', reason: '理由' })),
    fixes: [{ original: 'je suis allé', corrected: 'je suis allée', why: '過去分詞配合' }],
    vocabulary: [{ fr: 'le bénévolat', zh: '志工服務' }],
    summary: '整體',
    ...extra,
  };
}

// ── gemini.mjs ──────────────────────────────────────────────────────

test('沒設 GEMINI_API_KEY 時回 503，不送出請求', async () => {
  let called = false;
  await assert.rejects(
    generateJson({ env: {}, system: 's', prompt: 'p', schema: {}, fetchImpl: async () => { called = true; } }),
    (err) => err.status === 503,
  );
  assert.equal(called, false);
});

test('key 放在 x-goog-api-key 標頭，不出現在網址', async () => {
  let seen;
  const fetchImpl = async (url, options) => { seen = { url, options }; return geminiReply({ ok: true }); };
  const { value } = await generateJson({ env: KEYED, system: 's', prompt: 'p', schema: { type: 'object' }, fetchImpl });
  assert.deepEqual(value, { ok: true });
  assert.equal(seen.url.includes('test-gemini-key'), false);
  assert.match(seen.url, /\/models\/gemini-3\.8-flash:generateContent$/);
  assert.equal(seen.options.headers['x-goog-api-key'], 'test-gemini-key');
  const body = JSON.parse(seen.options.body);
  assert.equal(body.generationConfig.responseFormat.text.mimeType, 'APPLICATION_JSON');
  assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, 'medium');
  // 3.6 之後的模型不該送 temperature 這類取樣參數。
  assert.equal('temperature' in body.generationConfig, false);
});

test('GEMINI_MODEL 含斜線時拒絕，不拼進網址', async () => {
  await assert.rejects(
    generateJson({ env: { ...KEYED, GEMINI_MODEL: '../x' }, system: 's', prompt: 'p', schema: {}, fetchImpl: async () => geminiReply({}) }),
    (err) => err.status === 503,
  );
});

test('thought 片段不混進 JSON 正文', async () => {
  const { value } = await generateJson({
    env: KEYED, system: 's', prompt: 'p', schema: {}, fetchImpl: async () => geminiReply({ a: 1 }, { thought: true }),
  });
  assert.deepEqual(value, { a: 1 });
});

test('429、逾時、截斷各自對應到明確的錯誤', async () => {
  const base = { env: KEYED, system: 's', prompt: 'p', schema: {} };
  await assert.rejects(generateJson({ ...base, fetchImpl: async () => json({}, { status: 429 }) }), (err) => err.status === 429);
  await assert.rejects(generateJson({ ...base, fetchImpl: async () => json({}, { status: 400 }) }), (err) => err.status === 502);
  await assert.rejects(generateJson({
    ...base, fetchImpl: async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); },
  }), (err) => err.status === 504);
  await assert.rejects(
    generateJson({ ...base, fetchImpl: async () => geminiReply({ a: 1 }, { finishReason: 'MAX_TOKENS' }) }),
    (err) => err.status === 502 && /MAX_TOKENS/.test(err.message),
  );
});

// ── PE 批改 ────────────────────────────────────────────────────────

test('後端與前端的字數算法一致', () => {
  for (const text of ['', '  ', "C'est l'été, à 20 h — voilà !", ESSAY]) {
    assert.equal(countWords(text), uiCountWords(text));
  }
});

test('79 字以下直接全部 0 分，不呼叫 Gemini', async () => {
  const fetchImpl = async () => { throw new Error('不該呼叫'); };
  const short = await peFeedback(KEYED, { text: 'je suis là' }, fetchImpl);
  assert.equal(short.rule, 'matiere');
  assert.equal(short.total, 0);
  assert.equal(short.words, 3);
  const blank = await peFeedback(KEYED, { text: '   ' }, fetchImpl);
  assert.equal(blank.rule, 'copie-blanche');
  assert.equal(blank.total, 0);
});

test('總分由程式加總，不採模型自己算的數字', async () => {
  const fetchImpl = async () => geminiReply(rawGrade(['B1', 'B1+', '未達 B1', 'B1', 'B1'], { total: 25 }));
  const result = await peFeedback(KEYED, { text: ESSAY, task: 'Écrivez un courriel…' }, fetchImpl);
  assert.equal(result.total, 3 + 5 + 1 + 3 + 3);
  assert.equal(result.words, 80);
  assert.equal(result.model, 'gemini-3.8-flash');
});

test('離題封頂：thematique 與 discursif 同時成立時取較低的上限', () => {
  const graded = gradePe(rawGrade(['B1+', 'B1+', 'B1+', 'B1+', 'B1+'], {
    anomalies: [{ type: 'thematique', reason: 'a' }, { type: 'discursif', reason: 'b' }],
  }), 160);
  assert.deepEqual(graded.criteria.map((c) => c.points), [1, 1, 5, 3, 5]);
  assert.deepEqual(graded.criteria.map((c) => c.capped), [true, true, false, true, false]);
  assert.equal(graded.criteria[3].level, 'B1');
  assert.equal(graded.total, 15);
});

test('完全離題：前三項 0 分，後兩項最多 B1', () => {
  const graded = gradePe(rawGrade(['B1+', 'B1', 'B1', 'B1+', '未達 B1'], {
    anomalies: [{ type: 'complet', reason: 'x' }],
  }), 160);
  assert.deepEqual(graded.criteria.map((c) => c.points), [0, 0, 0, 3, 1]);
  assert.equal(graded.total, 4);
});

test('模型漏判一項時總分留空，不替它猜', () => {
  const raw = rawGrade(['B1', 'B1', 'B1', 'B1', 'B1']);
  raw.criteria.pop();
  const graded = gradePe(raw, 160);
  assert.equal(graded.total, null);
  assert.equal(graded.criteria[4].points, null);
});

test('草稿過長回 400', async () => {
  await assert.rejects(peFeedback(KEYED, { text: 'a'.repeat(20_001) }, async () => geminiReply({})), (err) => err.status === 400);
});

// ── 路由 ────────────────────────────────────────────────────────────

test('未登入不能呼叫 AI 批改', async () => {
  const res = await run(createCloudHandler({
    env: KEYED, fetchImpl: async () => { throw new Error('不該呼叫'); },
  }), {
    method: 'POST', path: 'ai/pe-feedback',
    headers: { host: SAME_ORIGIN.host, origin: SAME_ORIGIN.origin, 'x-forwarded-proto': 'https' },
    body: { text: ESSAY },
  });
  assert.equal(res.statusCode, 401);
});

test('跨站 POST 在登入檢查前就擋掉', async () => {
  const res = await run(createCloudHandler({
    env: KEYED, fetchImpl: async () => { throw new Error('不該呼叫'); },
  }), {
    method: 'POST', path: 'ai/pe-feedback',
    headers: { ...SAME_ORIGIN, origin: 'https://evil.example' },
    body: { text: ESSAY },
  });
  assert.equal(res.statusCode, 403);
});

test('登入後 AI 批改經路由回傳整理過的結果', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/auth/v1/user')) return json({ id: 'user-1', email: 'ricky@example.com' });
    if (url.includes('generativelanguage.googleapis.com')) return geminiReply(rawGrade(['B1', 'B1', 'B1', 'B1', 'B1']));
    throw new Error(`未處理的 URL：${url}`);
  };
  const res = await run(createCloudHandler({ env: KEYED, fetchImpl }), {
    method: 'POST', path: 'ai/pe-feedback', headers: SAME_ORIGIN, body: { text: ESSAY },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.total, 15);
  assert.equal(res.body.includes('test-gemini-key'), false);
});

test('週報在沒設 key 時回 503，不先去讀統計', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    if (url.endsWith('/auth/v1/user')) return json({ id: 'user-1', email: 'ricky@example.com' });
    throw new Error(`未處理的 URL：${url}`);
  };
  const res = await run(createCloudHandler({ env: ENV, fetchImpl }), {
    method: 'POST', path: 'ai/weekly-brief', headers: SAME_ORIGIN, body: {},
  });
  assert.equal(res.statusCode, 503);
  assert.match(res.json.error, /GEMINI_API_KEY/);
  assert.equal(urls.length, 1);
});

test('週報摘要只帶這 7 天與有作答的科目', () => {
  const digest = weeklyDigest({
    summary: { seenCards: 500, matureCards: 120, dueNow: 30, streakDays: 6 },
    byKind: [{ kind: 'vocab-recall', total: 900, seen: 400, mature: 100, due: 20, fresh: 500 }, { kind: 'x', total: 5, seen: 0, mature: 0, due: 0, fresh: 5 }],
    daily: [{ day: '2026-11-20', count: 40, correct: 30 }, { day: '2026-11-21', count: 10, correct: 10 }],
    upcoming: { backlog: 30, days: [{ day: '2026-11-26', count: 12 }, { day: '2026-11-27', count: 8 }] },
    weakest: [{ lapses: 4, lastReason: 'gender', card: { id: 'c1', kind: 'vocab-recall', front: { word: 'la clé' } } }],
    errorProfile: [{ reason: 'gender', count: 9 }],
    practice: {
      bySkill: [{ skill: 'PE', attempts: 2, minutes: 70, average: 0.6 }, { skill: 'CO', attempts: 0, minutes: 0, average: null }],
      recent: [{ skill: 'PE', day: '2026-11-21', notes: '連接詞不夠' }, { skill: 'PE', day: '2026-11-20', notes: '' }],
    },
  }, { from: '2026-11-19', to: '2026-11-25', items: [{ id: 'a', kind: 'vocab-recall', label: 'le défi' }] });
  assert.equal(digest.reviews.total, 50);
  assert.equal(digest.reviews.accuracy, 0.8);
  assert.equal(digest.reviews.activeDays, 2);
  assert.equal(digest.cards.dueNext7Days, 20);
  assert.deepEqual(digest.cards.byKind.map((k) => k.kind), ['vocab-recall']);
  assert.deepEqual(digest.practice.map((p) => p.skill), ['PE']);
  assert.equal(digest.weakest[0].word, 'la clé');
  assert.equal(digest.maturedThisWeek.examples[0].word, 'le défi');
  assert.equal(digest.practiceNotes.length, 1);
});

function json(value, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

async function run(handler, { method, path, query = {}, headers = {}, body } = {}) {
  const saved = new Map();
  let raw = '';
  const res = {
    statusCode: 0,
    setHeader(name, value) { saved.set(String(name).toLowerCase(), value); },
    end(value = '') { raw = String(value); },
  };
  await handler({ method, query: { ...query, path }, headers, body }, res);
  return { statusCode: res.statusCode, headers: saved, body: raw, json: JSON.parse(raw) };
}
