import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
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

test('refresh token 失效（Supabase 回 400）時轉成 401 與中文訊息', async () => {
  const res = await run(createCloudHandler({
    env: ENV,
    fetchImpl: async (url) => {
      assert.match(url, /\/auth\/v1\/token\?grant_type=refresh_token$/);
      return json({
        code: 400, error_code: 'refresh_token_not_found',
        msg: 'Invalid Refresh Token: Refresh Token Not Found',
      }, { status: 400 });
    },
  }), { method: 'GET', path: 'summary', headers: { cookie: 'cadence_refresh=stale-refresh' } });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json.error, '登入已過期，請重新登入');
});

test('refresh 時 Supabase 5xx 不偽裝成登入過期', async () => {
  const res = await run(createCloudHandler({
    env: ENV,
    fetchImpl: async () => json({ msg: 'upstream down' }, { status: 503 }),
  }), { method: 'GET', path: 'summary', headers: { cookie: 'cadence_refresh=some-refresh' } });
  assert.equal(res.statusCode, 502);
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

test('有效的 ES256 access token 在函式內驗完，不打 /auth/v1/user，JWKS 只抓一次', async () => {
  // 每個測試用不同網址，JWKS 快取是模組層級的，共用網址會互相污染。
  const env = { ...ENV, SUPABASE_URL: 'https://jwt-valid.supabase.co' };
  const signer = keySigner('kid-valid');
  const token = signer.token(ownerClaims(env));
  const hits = { jwks: 0, user: 0 };
  const fetchImpl = async (url) => {
    if (url.endsWith('/auth/v1/.well-known/jwks.json')) { hits.jwks += 1; return json({ keys: [signer.jwk] }); }
    if (url.endsWith('/auth/v1/user')) { hits.user += 1; return json({ id: 'user-1', email: 'ricky@example.com' }); }
    if (url.includes('/rest/v1/content_resources')) return json([]);
    throw new Error(`未處理的 URL：${url}`);
  };
  const handler = createCloudHandler({ env, fetchImpl });
  for (let i = 0; i < 2; i += 1) {
    const res = await run(handler, { method: 'GET', path: 'resources', headers: { cookie: `cadence_access=${token}` } });
    assert.equal(res.statusCode, 200);
  }
  assert.deepEqual(hits, { jwks: 1, user: 0 });
});

test('簽章被竄改或已過期時退回 /auth/v1/user 判斷', async () => {
  const env = { ...ENV, SUPABASE_URL: 'https://jwt-fallback.supabase.co' };
  const signer = keySigner('kid-fallback');
  const good = signer.token(ownerClaims(env));
  const [head, body] = good.split('.');
  const forged = `${head}.${Buffer.from(JSON.stringify({ ...ownerClaims(env), sub: 'user-9' })).toString('base64url')}.${good.split('.')[2]}`;
  const expired = signer.token({ ...ownerClaims(env), exp: Math.floor(Date.now() / 1000) - 5 });
  assert.notEqual(body, forged.split('.')[1]);
  let userCalls = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith('/auth/v1/.well-known/jwks.json')) return json({ keys: [signer.jwk] });
    if (url.endsWith('/auth/v1/user')) { userCalls += 1; return json({ msg: 'invalid JWT' }, { status: 401 }); }
    throw new Error(`未處理的 URL：${url}`);
  };
  const handler = createCloudHandler({ env, fetchImpl });
  for (const token of [forged, expired]) {
    const res = await run(handler, { method: 'GET', path: 'resources', headers: { cookie: `cadence_access=${token}` } });
    assert.equal(res.statusCode, 401);
  }
  assert.equal(userCalls, 2);
});

test('簽章有效但信箱不是擁有者，仍回 403', async () => {
  const env = { ...ENV, SUPABASE_URL: 'https://jwt-owner.supabase.co' };
  const signer = keySigner('kid-owner');
  const token = signer.token({ ...ownerClaims(env), email: 'other@example.com' });
  const fetchImpl = async (url) => {
    if (url.endsWith('/auth/v1/.well-known/jwks.json')) return json({ keys: [signer.jwk] });
    throw new Error(`未處理的 URL：${url}`);
  };
  const res = await run(createCloudHandler({ env, fetchImpl }), {
    method: 'GET', path: 'resources', headers: { cookie: `cadence_access=${token}` },
  });
  assert.equal(res.statusCode, 403);
});

test('作答的事件與排程合成一次 RPC 寫入，不再分兩支請求', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method ?? 'GET', body: options.body });
    if (url.endsWith('/auth/v1/user')) return json({ id: 'user-1', email: 'ricky@example.com' });
    if (url.includes('/rest/v1/cards?')) return json([{ payload: { id: 'card-1', kind: 'vocab-recall', mode: 'self' } }]);
    if (url.includes('/rest/v1/card_states?')) return json([]);
    if (url.includes('/rest/v1/user_settings')) return json([]);
    if (url.endsWith('/rest/v1/rpc/cadence_record_review')) return new Response(null, { status: 204 });
    throw new Error(`未處理的 URL：${url}`);
  };
  const res = await run(createCloudHandler({ env: ENV, fetchImpl }), {
    method: 'POST', path: 'review',
    headers: {
      cookie: 'cadence_access=valid-token',
      host: 'cadence.vercel.app', origin: 'https://cadence.vercel.app', 'x-forwarded-proto': 'https',
    },
    body: { cardId: sealForTest(ENV.CADENCE_TOKEN_SECRET, 'card-1'), rating: 3 },
  });
  assert.equal(res.statusCode, 200);
  const writes = calls.filter((call) => call.method === 'POST');
  assert.equal(writes.length, 1);
  assert.match(writes[0].url, /\/rest\/v1\/rpc\/cadence_record_review$/);
  const sent = JSON.parse(writes[0].body);
  assert.equal(sent.p_event.card_id, 'card-1');
  assert.equal(sent.p_event.event_type, 'review');
  assert.equal(sent.p_state.card_id, 'card-1');
  assert.equal(sent.p_state.reps, 1);
  // owner_id 由資料庫取 auth.uid()，請求內容不該帶。
  assert.equal('owner_id' in sent.p_event, false);
  assert.equal('owner_id' in sent.p_state, false);
});

test('今天頁推演用最近 7 天的作答量，停練的那一半也真的跑模擬', async () => {
  const day = (offset) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' })
    .format(new Date(Date.now() - offset * 86_400_000));
  const reviews = [];
  // 今天 1 題、前 6 天每天 2 題、一個月前 30 題。舊版只看今天，pace 會算成 0。
  const push = (offset, n) => {
    for (let i = 0; i < n; i += 1) {
      reviews.push({
        event_id: `e${reviews.length}`, event_type: 'review', card_id: 'c1', at: new Date(Date.now() - offset * 86_400_000).toISOString(),
        study_day: day(offset), rating: 3, correct: true, response_ms: 4000,
      });
    }
  };
  push(0, 1);
  for (let offset = 1; offset <= 6; offset += 1) push(offset, 2);
  push(30, 30);
  const due = new Date(Date.now() + 3 * 86_400_000).toISOString();
  const fetchImpl = async (url) => {
    if (url.endsWith('/auth/v1/user')) return json({ id: 'user-1', email: 'ricky@example.com' });
    if (url.includes('/rest/v1/user_settings')) {
      return json([{ desired_retention: 0.9, daily_new_limit: 5, exam_date: day(-40), start_level: 'A2' }]);
    }
    if (url.includes('/rest/v1/cards?')) {
      return json(Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, kind: 'vocab-recall', level: 'B1' })));
    }
    if (url.includes('/rest/v1/card_states?')) {
      return json([{ card_id: 'c1', stability: 4, difficulty: 5, due, last_review: new Date().toISOString(), reps: 3, lapses: 0 }]);
    }
    if (url.includes('/rest/v1/review_events?')) return json(reviews);
    throw new Error(`未處理的 URL：${url}`);
  };
  const res = await run(createCloudHandler({ env: ENV, fetchImpl }), {
    method: 'GET', path: 'outlook', headers: { cookie: 'cadence_access=valid-token' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.window, 7);
  assert.equal(res.json.windowReviews, 13);
  assert.equal(res.json.pace, 2);
  assert.equal(res.json.cardsInScope, 40);
  // 照節奏做 40 天會學到新卡，停下來只剩 c1 的殘餘記憶。
  assert.ok(res.json.expectedRecall > res.json.stoppedRecall);
  assert.ok(res.json.stoppedRecall <= 1);
});

test('沒設考試日期時，推演不讀整份題庫', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    if (url.endsWith('/auth/v1/user')) return json({ id: 'user-1', email: 'ricky@example.com' });
    if (url.includes('/rest/v1/user_settings')) return json([]);
    throw new Error(`未處理的 URL：${url}`);
  };
  const res = await run(createCloudHandler({ env: ENV, fetchImpl }), {
    method: 'GET', path: 'outlook', headers: { cookie: 'cadence_access=valid-token' },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json, { examDate: null });
  assert.equal(seen.some((url) => url.includes('/rest/v1/cards')), false);
});

const WRITE_HEADERS = {
  cookie: 'cadence_access=valid-token',
  host: 'cadence.vercel.app', origin: 'https://cadence.vercel.app', 'x-forwarded-proto': 'https',
};

test('分頁讀取一律帶唯一排序，避免超過 1000 列時翻頁重複或漏列', async () => {
  const reads = [];
  const fetchImpl = async (url) => {
    if (url.endsWith('/auth/v1/user')) return json({ id: 'user-1', email: 'ricky@example.com' });
    if (url.includes('/rest/v1/rpc/')) return json({ due_now: 0, new_count: 0, streak: 0 });
    if (url.includes('/rest/v1/user_settings')) return json([]);
    if (url.includes('/rest/v1/')) { reads.push(url); return json([]); }
    throw new Error(`未處理的 URL：${url}`);
  };
  const handler = createCloudHandler({ env: ENV, fetchImpl });
  for (const path of ['stats', 'sentence']) {
    const res = await run(handler, { method: 'GET', path, headers: { cookie: 'cadence_access=valid-token' } });
    assert.equal(res.statusCode, 200, path);
  }
  await run(handler, { method: 'GET', path: 'backup', headers: { cookie: 'cadence_access=valid-token' } });
  const unique = { cards: 'id.asc', card_states: 'card_id.asc' };
  const paged = reads.filter((url) => /\/rest\/v1\/(cards|card_states|review_events|practice_events|checkin_events)\?/.test(url));
  assert.ok(paged.length >= 8);
  for (const url of paged) {
    const table = url.match(/\/rest\/v1\/(\w+)\?/)[1];
    const order = new URL(url).searchParams.get('order');
    assert.ok(order, `${table} 缺 order`);
    const last = order.split(',').at(-1);
    assert.equal(last, unique[table] ?? 'event_id.asc', url);
  }
});

test('每日一句：缺 headword 的單字卡不會讓整頁 500', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/auth/v1/user')) return json({ id: 'user-1', email: 'ricky@example.com' });
    if (url.includes('kind=in.(pick,rw)')) {
      return json([{ id: 'p1', kind: 'pick', payload: { front: { prompt: 'Le chat dort.' } } }]);
    }
    if (url.includes('kind=eq.vocab-recall')) return json([{ id: 'v1', headword: null }, { id: 'v2', headword: 'Chat' }]);
    if (url.includes('/rest/v1/card_states?')) return json([{ card_id: 'v1', stability: 30 }, { card_id: 'v2', stability: 30 }]);
    throw new Error(`未處理的 URL：${url}`);
  };
  const res = await run(createCloudHandler({ env: ENV, fetchImpl }), {
    method: 'GET', path: 'sentence', headers: { cookie: 'cadence_access=valid-token' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.total, 1);
});

test('同一張卡的作答撞到版本鎖（PT409）時回 409，不是 502', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/auth/v1/user')) return json({ id: 'user-1', email: 'ricky@example.com' });
    if (url.includes('/rest/v1/cards?')) return json([{ payload: { id: 'card-1', kind: 'vocab-recall', mode: 'self' } }]);
    if (url.includes('/rest/v1/card_states?')) {
      return json([{ card_id: 'card-1', stability: 3, difficulty: 5, due: new Date().toISOString(), last_review: new Date().toISOString(), reps: 2, lapses: 0, version: 2 }]);
    }
    if (url.includes('/rest/v1/user_settings')) return json([]);
    if (url.endsWith('/rest/v1/rpc/cadence_record_review')) {
      return json({ code: 'PT409', message: 'card state changed', details: null, hint: null }, { status: 409 });
    }
    throw new Error(`未處理的 URL：${url}`);
  };
  const res = await run(createCloudHandler({ env: ENV, fetchImpl }), {
    method: 'POST', path: 'review', headers: WRITE_HEADERS,
    body: { cardId: sealForTest(ENV.CADENCE_TOKEN_SECRET, 'card-1'), rating: 3 },
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json.error, '這張卡剛剛已經記錄過一次作答，請重新整理後再試');
});

test('作答送出的 version 是這張卡目前的版本 + 1', async () => {
  let sent = null;
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith('/auth/v1/user')) return json({ id: 'user-1', email: 'ricky@example.com' });
    if (url.includes('/rest/v1/cards?')) return json([{ payload: { id: 'card-1', kind: 'vocab-recall', mode: 'self' } }]);
    if (url.includes('/rest/v1/card_states?')) {
      return json([{ card_id: 'card-1', stability: 3, difficulty: 5, due: new Date().toISOString(), last_review: new Date().toISOString(), reps: 2, lapses: 0, version: 7 }]);
    }
    if (url.includes('/rest/v1/user_settings')) return json([]);
    if (url.endsWith('/rest/v1/rpc/cadence_record_review')) { sent = JSON.parse(options.body); return new Response(null, { status: 204 }); }
    throw new Error(`未處理的 URL：${url}`);
  };
  const res = await run(createCloudHandler({ env: ENV, fetchImpl }), {
    method: 'POST', path: 'review', headers: WRITE_HEADERS,
    body: { cardId: sealForTest(ENV.CADENCE_TOKEN_SECRET, 'card-1'), rating: 3 },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(sent.p_state.version, 8);
  assert.equal(sent.p_state.reps, 3);
});

test('評分更正的 version 用該卡目前版本 + 1，不受其他卡的更正筆數影響', async () => {
  let sent = null;
  const at = (min) => new Date(Date.now() - min * 60_000).toISOString();
  const rows = [
    // 別張卡的兩筆更正：舊版會把它們算進 version
    { event_id: 'x1', event_type: 'review', card_id: 'other', at: at(50), rating: 3, elapsed_days: 0, self_rated: true },
    { event_id: 'x2', event_type: 'rating-correction', target_event_id: 'x1', card_id: 'other', at: at(49), rating: 2 },
    { event_id: 'x3', event_type: 'rating-correction', target_event_id: 'x1', card_id: 'other', at: at(48), rating: 4 },
    { event_id: 'a1', event_type: 'review', card_id: 'card-1', at: at(10), rating: 3, elapsed_days: 0, self_rated: true },
  ];
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith('/auth/v1/user')) return json({ id: 'user-1', email: 'ricky@example.com' });
    if (url.includes('/rest/v1/review_events?')) return json(rows);
    if (url.includes('/rest/v1/user_settings')) return json([]);
    if (url.includes('/rest/v1/card_states?card_id=eq.card-1')) return json([{ version: 5 }]);
    if (url.endsWith('/rest/v1/rpc/cadence_record_review')) { sent = JSON.parse(options.body); return new Response(null, { status: 204 }); }
    throw new Error(`未處理的 URL：${url}`);
  };
  const res = await run(createCloudHandler({ env: ENV, fetchImpl }), {
    method: 'POST', path: 'review-correction', headers: WRITE_HEADERS, body: { id: 'a1', rating: 1 },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(sent.p_state.card_id, 'card-1');
  assert.equal(sent.p_state.version, 6);
  assert.equal(sent.p_state.lapses, 1);
});

test('設定欄位型別不符時回 400，不會被 Number() 轉成 0 存進去', async () => {
  const writes = [];
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith('/auth/v1/user')) return json({ id: 'user-1', email: 'ricky@example.com' });
    if (url.includes('/rest/v1/user_settings') && options.method === 'POST') {
      writes.push(JSON.parse(options.body));
      return json([JSON.parse(options.body)]);
    }
    if (url.includes('/rest/v1/user_settings')) return json([]);
    throw new Error(`未處理的 URL：${url}`);
  };
  const handler = createCloudHandler({ env: ENV, fetchImpl });
  const bad = [
    { dailyNewLimit: '' },
    { dailyNewLimit: true },
    { dailyNewLimit: 3.5 },
    { desiredRetention: '0.9' },
    { examDate: ['2026-12-12'] },
    { examDate: '2026-02-31' },
    { examDate: 20261212 },
  ];
  for (const body of bad) {
    const res = await run(handler, { method: 'POST', path: 'settings', headers: WRITE_HEADERS, body });
    assert.equal(res.statusCode, 400, JSON.stringify(body));
  }
  const notObject = await run(handler, { method: 'POST', path: 'settings', headers: WRITE_HEADERS, body: '[1,2]' });
  assert.equal(notObject.statusCode, 400);
  assert.equal(writes.length, 0);

  const ok = await run(handler, {
    method: 'POST', path: 'settings', headers: WRITE_HEADERS,
    body: { desiredRetention: 0.85, dailyNewLimit: null, examDate: '2027-05-01' },
  });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json, { desiredRetention: 0.85, dailyNewLimit: null, examDate: '2027-05-01', startLevel: null });
  const cleared = await run(handler, { method: 'POST', path: 'settings', headers: WRITE_HEADERS, body: { examDate: '' } });
  assert.equal(cleared.statusCode, 200);
  assert.equal(cleared.json.examDate, null);
});

function keySigner(kid) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'ES256', use: 'sig', key_ops: ['verify'], ext: true };
  return {
    jwk,
    token(claims) {
      const head = Buffer.from(JSON.stringify({ alg: 'ES256', kid, typ: 'JWT' })).toString('base64url');
      const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
      const signature = sign('sha256', Buffer.from(`${head}.${body}`), { key: privateKey, dsaEncoding: 'ieee-p1363' });
      return `${head}.${body}.${signature.toString('base64url')}`;
    },
  };
}

function ownerClaims(env) {
  return {
    iss: `${env.SUPABASE_URL}/auth/v1`, aud: 'authenticated', role: 'authenticated',
    sub: 'user-1', email: 'ricky@example.com', exp: Math.floor(Date.now() / 1000) + 3600,
  };
}

// 與 learning.mjs 的 sealCardId 同一格式；那支沒有匯出，測試自己封一個。
function sealForTest(secret, id) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(secret, 'hex'), iv);
  const encrypted = Buffer.concat([cipher.update(id, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}

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
