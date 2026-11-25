import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloudHandler } from '../src/cloud/router.mjs';
import { generateChat } from '../src/cloud/gemini.mjs';
import {
  aiChat, chatHistory, peContext, quizMaterial, ROLEPLAY_SCENARIOS, MAX_TURNS, DEBRIEF_TEXT,
} from '../src/cloud/chat.mjs';

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
const AUTH = { user: { id: 'user-1' }, accessToken: 'valid-token' };
const ESSAY = Array.from({ length: 80 }, (_, i) => (i % 2 ? 'élève' : 'je')).join(' ');

function chatReply(text, { finishReason = 'STOP', signature = 'c2lnLTE=' } = {}) {
  const part = signature ? { text, thoughtSignature: signature } : { text };
  return json({
    candidates: [{ content: { role: 'model', parts: [part] }, finishReason }],
    modelVersion: 'gemini-3.8-flash',
  });
}

// 一個 fetch 假件：Gemini 照 reply 回，Supabase 一律回空資料（空資料庫）。
function fakeFetch(reply = () => chatReply('Bonjour !')) {
  const sent = [];
  const fetchImpl = async (url, options) => {
    if (url.includes('generativelanguage.googleapis.com')) {
      sent.push(JSON.parse(options.body));
      return reply();
    }
    if (url.endsWith('/auth/v1/user')) return json({ id: 'user-1', email: 'ricky@example.com' });
    if (url.includes('/rest/v1/rpc/')) return json({ summary: {}, byKind: [], streakDays: 0 });
    if (url.includes('/rest/v1/')) return json([], { headers: { 'content-range': '0-0/0' } });
    throw new Error(`未處理的 URL：${url}`);
  };
  return { fetchImpl, sent };
}

// ── gemini.mjs 的對話版 ─────────────────────────────────────────────

test('對話把簽章放回同一個 part，且不要求 JSON 輸出', async () => {
  const { fetchImpl, sent } = fakeFetch(() => chatReply('Très bien.', { signature: 'bmV3' }));
  const result = await generateChat({
    env: KEYED, system: 's', fetchImpl,
    contents: [
      { role: 'user', text: 'Salut' },
      { role: 'model', text: 'Bonjour', signature: 'b2xk' },
      { role: 'user', text: 'Ça va ?' },
    ],
  });
  assert.equal(result.text, 'Très bien.');
  assert.equal(result.signature, 'bmV3');
  assert.equal(result.truncated, false);
  const body = sent[0];
  assert.deepEqual(body.contents[1], { role: 'model', parts: [{ text: 'Bonjour', thoughtSignature: 'b2xk' }] });
  assert.deepEqual(body.contents[0], { role: 'user', parts: [{ text: 'Salut' }] });
  assert.equal('responseFormat' in body.generationConfig, false);
  assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, 'low');
});

test('對話被截斷時仍回前半段並標記，被擋掉時報錯', async () => {
  const cut = await generateChat({
    env: KEYED, system: 's', contents: [{ role: 'user', text: 'x' }],
    fetchImpl: fakeFetch(() => chatReply('前半段', { finishReason: 'MAX_TOKENS' })).fetchImpl,
  });
  assert.equal(cut.truncated, true);
  assert.equal(cut.text, '前半段');
  await assert.rejects(generateChat({
    env: KEYED, system: 's', contents: [{ role: 'user', text: 'x' }],
    fetchImpl: fakeFetch(() => chatReply('', { finishReason: 'SAFETY' })).fetchImpl,
  }), (err) => err.status === 502 && /SAFETY/.test(err.message));
});

// ── 歷史檢查 ────────────────────────────────────────────────────────

test('歷史要一問一答交替、最後是使用者', () => {
  assert.throws(() => chatHistory([]), (err) => err.status === 400);
  assert.throws(() => chatHistory([{ role: 'model', text: 'a' }]), (err) => err.status === 400);
  assert.throws(() => chatHistory([{ role: 'user', text: 'a' }, { role: 'user', text: 'b' }]), (err) => err.status === 400);
  assert.throws(() => chatHistory([{ role: 'user', text: 'a' }, { role: 'model', text: 'b' }]), (err) => err.status === 400);
  assert.throws(() => chatHistory([{ role: 'system', text: 'a' }]), (err) => err.status === 400);
  assert.throws(() => chatHistory([{ role: 'user', text: '   ' }]), (err) => err.status === 400);
  assert.equal(chatHistory([{ role: 'user', text: ' a ' }])[0].text, 'a');
});

test('由 AI 開場的模式可以從空歷史開始，且第一則是模型', () => {
  assert.deepEqual(chatHistory([], true), []);
  assert.throws(() => chatHistory([{ role: 'user', text: 'a' }], true), (err) => err.status === 400);
  assert.equal(chatHistory([{ role: 'model', text: 'Bonjour' }, { role: 'user', text: 'Salut' }], true).length, 2);
});

test('超過 20 輪或單則過長時拒絕', () => {
  const turns = (n) => Array.from({ length: n * 2 - 1 }, (_, i) => ({ role: i % 2 ? 'model' : 'user', text: `m${i}` }));
  assert.equal(chatHistory(turns(MAX_TURNS)).length, MAX_TURNS * 2 - 1);
  assert.throws(() => chatHistory(turns(MAX_TURNS + 1)), (err) => err.status === 400);
  assert.throws(() => chatHistory([{ role: 'user', text: 'a'.repeat(4_001) }]), (err) => err.status === 400);
});

test('格式不對的簽章丟掉，不讓整輪失敗', () => {
  const [, good] = chatHistory([{ role: 'user', text: 'a' }, { role: 'model', text: 'b', signature: 'YWJj' }, { role: 'user', text: 'c' }]);
  assert.equal(good.signature, 'YWJj');
  const [, bad] = chatHistory([{ role: 'user', text: 'a' }, { role: 'model', text: 'b', signature: '<script>' }, { role: 'user', text: 'c' }]);
  assert.equal('signature' in bad, false);
  const [user] = chatHistory([{ role: 'user', text: 'a', signature: 'YWJj' }]);
  assert.equal('signature' in user, false);
});

// ── 各模式 ──────────────────────────────────────────────────────────

test('沒設 key 回 503、模式不明回 400，都不送出請求', async () => {
  const { fetchImpl, sent } = fakeFetch();
  await assert.rejects(aiChat({}, AUTH, ENV, { mode: 'free', messages: [{ role: 'user', text: 'a' }] }, fetchImpl),
    (err) => err.status === 503);
  await assert.rejects(aiChat({}, AUTH, KEYED, { mode: 'oops', messages: [{ role: 'user', text: 'a' }] }, fetchImpl),
    (err) => err.status === 400);
  assert.equal(sent.length, 0);
});

test('PE 追問把作文與批改放進系統提示的資料區塊，丟掉不認得的評分項', async () => {
  const { fetchImpl, sent } = fakeFetch(() => chatReply('因為連接詞太少。'));
  const result = await aiChat({}, AUTH, KEYED, {
    mode: 'pe',
    messages: [{ role: 'user', text: '為什麼 Cohérence 只有 B1？' }],
    context: {
      text: ESSAY, task: 'Écrivez un courriel',
      result: {
        total: 15, words: 80,
        criteria: [
          { criterion: 'Cohérence et cohésion', level: 'B1', points: 3, reason: '連接詞少', quote: 'je' },
          { criterion: '自創項目', level: 'B1+', points: 5 },
        ],
      },
    },
  }, fetchImpl);
  assert.equal(result.reply, '因為連接詞太少。');
  assert.equal(result.turnsLeft, MAX_TURNS - 1);
  assert.equal(result.signature, 'c2lnLTE=');
  const system = sent[0].systemInstruction.parts[0].text;
  assert.match(system, /<data>/);
  assert.ok(system.includes('élève'));
  assert.equal(system.includes('自創項目'), false);
  assert.equal(sent[0].generationConfig.thinkingConfig.thinkingLevel, 'medium');
});

test('PE 追問沒附草稿時拒絕', () => {
  assert.throws(() => peContext({ result: {} }), (err) => err.status === 400);
  assert.throws(() => peContext({ text: 'a'.repeat(20_001) }), (err) => err.status === 400);
});

test('情境對話：後端持有情境卡，補一則開場指令讓 AI 先說話', async () => {
  const { fetchImpl, sent } = fakeFetch(() => chatReply('Bonjour, je peux vous aider ?'));
  const result = await aiChat({}, AUTH, KEYED, { mode: 'roleplay', messages: [], context: { scenario: 'echange' } }, fetchImpl);
  assert.equal(result.reply, 'Bonjour, je peux vous aider ?');
  assert.equal(result.turnsLeft, MAX_TURNS);
  assert.equal(sent[0].contents.length, 1);
  assert.equal(sent[0].contents[0].role, 'user');
  const system = sent[0].systemInstruction.parts[0].text;
  assert.ok(system.includes(ROLEPLAY_SCENARIOS.find((s) => s.id === 'echange').card));
  assert.ok(system.includes(DEBRIEF_TEXT));
  await assert.rejects(aiChat({}, AUTH, KEYED, { mode: 'roleplay', messages: [], context: { scenario: 'x' } }, fetchImpl),
    (err) => err.status === 400);
});

test('出題在沒有答錯過的卡時回 409，不呼叫 Gemini', async () => {
  const { fetchImpl, sent } = fakeFetch();
  await assert.rejects(
    aiChat({ url: ENV.SUPABASE_URL, publishableKey: ENV.SUPABASE_PUBLISHABLE_KEY }, AUTH, KEYED, { mode: 'quiz', messages: [] }, fetchImpl),
    (err) => err.status === 409,
  );
  assert.equal(sent.length, 0);
});

test('出題材料只留答題欄位，例句與英文釋義不送', () => {
  const material = quizMaterial({
    weakest: [{
      lapses: 3, lastReason: 'accent',
      card: {
        id: 'v:clé|NOM|p', kind: 'vocab-produce', answer: 'la clé',
        front: { word: 'clé', gloss: '鑰匙', gender: 'f', en: ['key'], examples: [{ fr: 'La clé est là.' }] },
      },
    }, { lapses: 1, lastReason: null, card: null }],
    errorProfile: [{ reason: 'accent', count: 7 }],
  });
  assert.equal(material.cards.length, 1);
  assert.deepEqual(material.cards[0].front, { word: 'clé', gloss: '鑰匙', gender: 'f' });
  assert.equal(material.cards[0].lastReason, '漏重音');
  assert.deepEqual(material.errorReasons, [{ reason: '漏重音', count: 7 }]);
});

// ── 路由 ────────────────────────────────────────────────────────────

test('隨時對話經路由回覆，系統提示帶伺服器算的 7 天摘要', async () => {
  const { fetchImpl, sent } = fakeFetch(() => chatReply('這週你答了 0 題。'));
  const res = await run(createCloudHandler({ env: KEYED, fetchImpl }), {
    method: 'POST', path: 'ai/chat', headers: SAME_ORIGIN,
    body: { mode: 'free', messages: [{ role: 'user', text: '我這週表現如何？' }], context: { digest: { reviews: 999 } } },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.reply, '這週你答了 0 題。');
  const system = sent[0].systemInstruction.parts[0].text;
  assert.match(system, /"digest":\{"period"/);
  // 前端塞進 context 的數字不會被採用。
  assert.equal(system.includes('999'), false);
  assert.equal(res.body.includes('test-gemini-key'), false);
});

test('對話路由接受超過 64 KB 的歷史，其他路由仍是 64 KB', async () => {
  const long = Array.from({ length: 19 }, (_, i) => [
    { role: 'user', text: 'é'.repeat(3_900) }, { role: 'model', text: `r${i}` },
  ]).flat();
  long.push({ role: 'user', text: 'fin' });
  const raw = JSON.stringify({ mode: 'free', messages: long });
  assert.ok(Buffer.byteLength(raw) > 64 * 1024);
  const { fetchImpl } = fakeFetch();
  const ok = await run(createCloudHandler({ env: KEYED, fetchImpl }), {
    method: 'POST', path: 'ai/chat', headers: SAME_ORIGIN, body: raw,
  });
  assert.equal(ok.statusCode, 200);
  const other = await run(createCloudHandler({ env: KEYED, fetchImpl }), {
    method: 'POST', path: 'ai/pe-feedback', headers: SAME_ORIGIN, body: JSON.stringify({ text: 'a'.repeat(70_000) }),
  });
  assert.equal(other.statusCode, 413);
});

test('未登入不能對話', async () => {
  const res = await run(createCloudHandler({
    env: KEYED, fetchImpl: async () => { throw new Error('不該呼叫'); },
  }), {
    method: 'POST', path: 'ai/chat',
    headers: { host: SAME_ORIGIN.host, origin: SAME_ORIGIN.origin, 'x-forwarded-proto': 'https' },
    body: { mode: 'free', messages: [{ role: 'user', text: 'a' }] },
  });
  assert.equal(res.statusCode, 401);
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

test('前端題卡與後端情境、講評句、字數上限是同一份', async () => {
  const web = await import('../web/js/roleplay.mjs');
  const server = await import('../src/cloud/chat.mjs');
  assert.deepEqual(web.ROLEPLAY, server.ROLEPLAY_SCENARIOS.map(({ id, part, title, card }) => ({ id, part, title, card })));
  assert.equal(web.DEBRIEF_TEXT, server.DEBRIEF_TEXT);
  assert.equal(web.MAX_MESSAGE, server.MAX_MESSAGE);
});
