import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloudHandler } from '../src/cloud/router.mjs';
import { practiceEntry, mockEntry, summarizePractice } from '../src/cloud/practice.mjs';
import { cloudCalendarDate } from '../src/cloud/analytics.mjs';

const ENV = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
  CADENCE_OWNER_EMAIL: 'ricky@example.com',
  CADENCE_TOKEN_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
};

test('雲端登入只把 token 放進 HttpOnly Cookie', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return json({
      access_token: 'access-secret',
      refresh_token: 'refresh-secret',
      expires_in: 3600,
      user: { id: 'user-1', email: 'ricky@example.com', user_metadata: { ignored: true } },
    });
  };
  const res = await run(createCloudHandler({ env: ENV, fetchImpl }), {
    method: 'POST', path: 'auth/login',
    headers: { host: 'cadence.vercel.app', origin: 'https://cadence.vercel.app', 'x-forwarded-proto': 'https' },
    body: { email: 'ricky@example.com', password: 'correct horse battery staple' },
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json, { user: { id: 'user-1', email: 'ricky@example.com' } });
  assert.equal(res.body.includes('access-secret'), false);
  const cookies = res.headers.get('set-cookie');
  assert.equal(Array.isArray(cookies), true);
  assert.equal(cookies.length, 2);
  for (const cookie of cookies) {
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Secure/);
  }
  assert.match(calls[0].url, /\/auth\/v1\/token\?grant_type=password$/);
});

test('未登入不能讀取 summary', async () => {
  let fetched = false;
  const res = await run(createCloudHandler({
    env: ENV,
    fetchImpl: async () => { fetched = true; throw new Error('不該呼叫'); },
  }), { method: 'GET', path: 'summary' });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json.error, '請先登入');
  assert.equal(fetched, false);
});

test('空的雲端資料庫回傳 cloudReady false', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/auth/v1/user')) return json({ id: 'user-1', email: 'ricky@example.com' });
    if (url.includes('/rest/v1/rpc/cadence_dashboard')) return json({
      summary: {
        totalCards: 0, seenCards: 0, matureCards: 0, dueNow: 0,
        newCount: 0, newCards: 0, todayReviews: 0, todayCorrect: 0, totalReviews: 0,
      },
      byKind: [], newToday: 0, streakDays: 0, checkins: {}, practiceToday: {},
      settings: { desiredRetention: 0.9, dailyNewLimit: 15, examDate: null, startLevel: null },
    });
    if (url.includes('/rest/v1/user_settings')) return json([]);
    if (url.includes('/rest/v1/reference_entries')) return json([]);
    if (url.includes('/rest/v1/cards') || url.includes('/rest/v1/card_states')) {
      return json([], { headers: { 'content-range': '0-0/0' } });
    }
    throw new Error(`未處理的 URL：${url}`);
  };
  const res = await run(createCloudHandler({ env: ENV, fetchImpl }), {
    method: 'GET', path: 'summary', headers: { cookie: 'cadence_access=valid-token' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.totalCards, 0);
  assert.equal(res.json.cloudReady, false);
  assert.deepEqual(res.json.settings, {
    desiredRetention: 0.9, dailyNewLimit: 15, examDate: null, startLevel: null,
  });
});

test('跨站 POST 在送到 Supabase 前被拒絕', async () => {
  let fetched = false;
  const res = await run(createCloudHandler({
    env: ENV,
    fetchImpl: async () => { fetched = true; throw new Error('不該呼叫'); },
  }), {
    method: 'POST', path: 'auth/login',
    headers: { host: 'cadence.vercel.app', origin: 'https://evil.example', 'x-forwarded-proto': 'https' },
    body: { email: 'ricky@example.com', password: 'secret' },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json.error, '拒絕跨站寫入');
  assert.equal(fetched, false);
});

test('錯誤登入不洩漏 Supabase 原始訊息', async () => {
  const res = await run(createCloudHandler({
    env: ENV,
    fetchImpl: async () => json({ error_code: 'invalid_credentials', msg: 'Invalid login credentials' }, { status: 400 }),
  }), {
    method: 'POST', path: 'auth/login',
    headers: { host: 'cadence.vercel.app', origin: 'https://cadence.vercel.app', 'x-forwarded-proto': 'https' },
    body: { email: 'ricky@example.com', password: 'wrong' },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json.error, '電子郵件或密碼不正確');
});

test('唯一信箱可以建立帳號，但回應不帶密碼或 token', async () => {
  let sent;
  const res = await run(createCloudHandler({
    env: ENV,
    fetchImpl: async (_url, options) => {
      sent = JSON.parse(options.body);
      return json({ user: { id: 'user-1', email: 'ricky@example.com' }, session: null });
    },
  }), {
    method: 'POST', path: 'auth/register',
    headers: { host: 'cadence.vercel.app', origin: 'https://cadence.vercel.app', 'x-forwarded-proto': 'https' },
    body: { email: 'RICKY@example.com', password: 'twelve-letters-or-more' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.needsConfirmation, true);
  assert.deepEqual(res.json.user, { id: 'user-1', email: 'ricky@example.com' });
  assert.equal(res.body.includes('twelve-letters-or-more'), false);
  assert.equal(res.body.includes('access_token'), false);
  assert.deepEqual(sent, { email: 'ricky@example.com', password: 'twelve-letters-or-more' });
});

test('其他信箱不能建立帳號，也不會呼叫 Supabase', async () => {
  let fetched = false;
  const res = await run(createCloudHandler({
    env: ENV,
    fetchImpl: async () => { fetched = true; throw new Error('不該呼叫'); },
  }), {
    method: 'POST', path: 'auth/register',
    headers: { host: 'cadence.vercel.app', origin: 'https://cadence.vercel.app', 'x-forwarded-proto': 'https' },
    body: { email: 'other@example.com', password: 'twelve-letters-or-more' },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json.error, '此網站只接受指定的擁有者信箱');
  assert.equal(fetched, false);
});

test('重複按建立帳號時，明確告知驗證信已寄出', async () => {
  const res = await run(createCloudHandler({
    env: ENV,
    fetchImpl: async () => json({
      error_code: 'over_email_send_rate_limit',
      msg: 'For security purposes, you can only request this after 43 seconds.',
    }, { status: 429 }),
  }), {
    method: 'POST', path: 'auth/register',
    headers: { host: 'cadence.vercel.app', origin: 'https://cadence.vercel.app', 'x-forwarded-proto': 'https' },
    body: { email: 'ricky@example.com', password: 'twelve-letters-or-more' },
  });
  assert.equal(res.statusCode, 429);
  assert.equal(res.json.error, '驗證信已寄出；請查看收件匣或垃圾郵件，不要重複建立帳號');
});

test('即使 Supabase 驗證成功，非擁有者仍不能登入', async () => {
  const res = await run(createCloudHandler({
    env: ENV,
    fetchImpl: async () => json({
      access_token: 'access-secret', refresh_token: 'refresh-secret', expires_in: 3600,
      user: { id: 'user-2', email: 'other@example.com' },
    }),
  }), {
    method: 'POST', path: 'auth/login',
    headers: { host: 'cadence.vercel.app', origin: 'https://cadence.vercel.app', 'x-forwarded-proto': 'https' },
    body: { email: 'other@example.com', password: 'twelve-letters-or-more' },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json.error, '這個帳號沒有 cadence 使用權限');
  assert.equal(res.headers.has('set-cookie'), false);
});

test('雲端四科紀錄沿用本機的驗證與統計語意', () => {
  const now = new Date('2026-09-25T10:00:00+08:00');
  const practice = practiceEntry({
    skill: 'CO', durationSec: 900, score: 14, maxScore: 25, source: '樣題',
  }, now);
  assert.equal(practice.day, '2026-09-25');
  assert.equal(practice.score, 14);
  assert.throws(() => practiceEntry({ skill: 'CO', durationSec: 1, score: 26, maxScore: 25 }, now), /不能高於/);

  const scores = Object.fromEntries(['CE', 'PE', 'CO', 'PO'].map((skill) => [skill, { score: 15, maxScore: 25 }]));
  const mock = mockEntry({ day: '2026-09-25', scores }, now);
  assert.equal(mock.total, 60);
  const summary = summarizePractice([practice, mock], 30, now);
  assert.equal(summary.bySkill.find((item) => item.skill === 'CO').minutes, 15);
  assert.equal(summary.mocks[0].maxTotal, 100);
});

test('雲端推演用 UTC 中午承載日曆日期，不會少算一天', () => {
  assert.equal(cloudCalendarDate('2027-05-01').toISOString(), '2027-05-01T12:00:00.000Z');
});

test('B2 資源只回啟用中的查證索引，不把內容複製進站內', async () => {
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith('/auth/v1/user')) return json({ id: 'user-1', email: 'ricky@example.com' });
    if (url.includes('/rest/v1/content_resources?active=eq.true')) {
      assert.equal(options.headers.authorization, 'Bearer valid-token');
      return json([{
        level: 'B2', skill: 'CO', title: 'B2 avancé 練習庫', resource_type: 'video-exercises',
        url: 'https://example.test/b2', source_name: 'Example', license_note: '免費連結',
        checked_at: '2026-09-25', payload: { skills: ['CO'], free: true },
      }]);
    }
    throw new Error(`未處理的 URL：${url}`);
  };
  const res = await run(createCloudHandler({ env: ENV, fetchImpl }), {
    method: 'GET', path: 'resources', headers: { cookie: 'cadence_access=valid-token' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.checkedAt, '2026-09-25');
  assert.equal(res.json.resources.length, 1);
  assert.equal(res.json.resources[0].title, 'B2 avancé 練習庫');
});

function json(value, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

async function run(handler, { method, path, headers = {}, body } = {}) {
  const saved = new Map();
  let raw = '';
  const res = {
    statusCode: 0,
    setHeader(name, value) { saved.set(String(name).toLowerCase(), value); },
    end(value = '') { raw = String(value); },
  };
  await handler({ method, query: { path }, headers, body }, res);
  return { statusCode: res.statusCode, headers: saved, body: raw, json: JSON.parse(raw) };
}
