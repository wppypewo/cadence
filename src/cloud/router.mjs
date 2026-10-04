/** Vercel Function 路由。登入與資料查詢都留在同網域，瀏覽器看不到 Supabase token。 */

import { cloudConfig, CloudError } from './supabase.mjs';
import { login, register, authenticate, logout, appendCookies } from './session.mjs';
import { readSettings, saveSettings, backup } from './data.mjs';
import {
  cloudSummary, today, queue, reveal, preview, review, checkin, search,
  weekly,
} from './learning.mjs';
import {
  cloudStats, cloudForecast, cloudOutlook, cloudSentence, correctCloudReview,
} from './analytics.mjs';
import { savePractice, saveMock } from './practice.mjs';
import { listResources } from './resources.mjs';

const MAX_BODY = 64 * 1024;

export function createCloudHandler({ env = process.env, fetchImpl = fetch } = {}) {
  return async function handler(req, res) {
    try {
      const config = cloudConfig(env);
      const path = routePath(req);
      const method = String(req.method ?? 'GET').toUpperCase();
      if (method === 'POST') guardOrigin(req);
      const secure = requestIsSecure(req);

      if (method === 'GET' && path === 'health') return send(res, 200, { ok: true, mode: 'cloud' });
      if (method === 'POST' && path === 'auth/register') {
        const result = await register(config, await readBody(req), { fetchImpl, secure });
        appendCookies(res, result.cookies);
        return send(res, 200, { user: result.user, needsConfirmation: result.needsConfirmation });
      }
      if (method === 'POST' && path === 'auth/login') {
        const result = await login(config, await readBody(req), { fetchImpl, secure });
        appendCookies(res, result.cookies);
        return send(res, 200, { user: result.user });
      }
      if (method === 'POST' && path === 'auth/logout') {
        appendCookies(res, await logout(config, req, { fetchImpl, secure }));
        return send(res, 200, { ok: true });
      }

      const auth = await authenticate(config, req, { fetchImpl, secure });
      appendCookies(res, auth.cookies);
      if (method === 'GET' && path === 'session') return send(res, 200, { user: auth.user });
      if (method === 'GET' && path === 'summary') return send(res, 200, await cloudSummary(config, auth, fetchImpl));
      if (method === 'GET' && path === 'today') return send(res, 200, await today(config, auth, fetchImpl));
      if (method === 'GET' && path === 'outlook') return send(res, 200, await cloudOutlook(config, auth, fetchImpl));
      if (method === 'GET' && path === 'sentence') return send(res, 200, await cloudSentence(config, auth, req.query, fetchImpl));
      if (method === 'GET' && path === 'weekly') return send(res, 200, await weekly(config, auth, fetchImpl));
      if (method === 'GET' && path === 'resources') return send(res, 200, await listResources(config, auth, fetchImpl));
      if (method === 'GET' && path === 'queue') return send(res, 200, await queue(config, auth, req.query, fetchImpl));
      if (method === 'GET' && path === 'reveal') return send(res, 200, await reveal(config, auth, req.query, fetchImpl));
      if (method === 'GET' && path === 'preview') return send(res, 200, await preview(config, auth, req.query, fetchImpl));
      if (method === 'GET' && path === 'search') return send(res, 200, await search(config, auth, req.query, fetchImpl));
      if (method === 'GET' && path === 'stats') return send(res, 200, await cloudStats(config, auth, req.query, fetchImpl));
      if (method === 'GET' && path === 'forecast') return send(res, 200, await cloudForecast(config, auth, req.query, fetchImpl));
      if (method === 'POST' && path === 'review') return send(res, 200, await review(config, auth, await readBody(req), fetchImpl));
      if (method === 'POST' && path === 'review-correction') {
        return send(res, 200, await correctCloudReview(config, auth, await readBody(req), fetchImpl));
      }
      if (method === 'POST' && path === 'checkin') return send(res, 200, await checkin(config, auth, await readBody(req), fetchImpl));
      if (method === 'POST' && path === 'practice') return send(res, 200, await savePractice(config, auth, await readBody(req), fetchImpl));
      if (method === 'POST' && path === 'mock') return send(res, 200, await saveMock(config, auth, await readBody(req), fetchImpl));
      if (method === 'GET' && path === 'settings') return send(res, 200, await readSettings(config, auth, fetchImpl));
      if (method === 'POST' && path === 'settings') {
        return send(res, 200, await saveSettings(config, auth, await readBody(req), fetchImpl));
      }
      if (method === 'GET' && path === 'backup') return send(res, 200, await backup(config, auth, fetchImpl));
      if (method === 'GET' && path.startsWith('verb/')) {
        throw new CloudError(404, '雲端版未收錄 Verbiste 變位表；GPL-2.0 衍生資料仍只保留在本機');
      }

      throw new CloudError(503, '這個雲端功能會在資料搬移階段啟用');
    } catch (err) {
      const status = err instanceof CloudError ? err.status : 500;
      if (status >= 500) console.error(err);
      return send(res, status, { error: status === 500 ? '雲端服務暫時無法使用' : err.message });
    }
  };
}

function routePath(req) {
  const fromQuery = req.query?.path;
  if (Array.isArray(fromQuery)) return fromQuery.join('/').replace(/^\/+|\/+$/g, '');
  if (typeof fromQuery === 'string') return fromQuery.replace(/^\/+|\/+$/g, '');
  const url = new URL(req.url ?? '/', 'http://cadence.invalid');
  return url.pathname.replace(/^\/api\/?/, '').replace(/^router\/?/, '').replace(/^\/+|\/+$/g, '');
}

function guardOrigin(req) {
  const origin = req.headers?.origin;
  if (!origin) return;
  const forwarded = req.headers['x-forwarded-host'];
  const host = String(forwarded ?? req.headers.host ?? '').split(',')[0].trim();
  const proto = String(req.headers['x-forwarded-proto'] ?? (host.startsWith('localhost') ? 'http' : 'https'))
    .split(',')[0].trim();
  if (!host || origin !== `${proto}://${host}`) throw new CloudError(403, '拒絕跨站寫入');
}

function requestIsSecure(req) {
  const proto = String(req.headers?.['x-forwarded-proto'] ?? '').split(',')[0].trim();
  if (proto) return proto === 'https';
  const host = String(req.headers?.host ?? '');
  return !/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host);
}

async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    const body = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : req.body;
    if (typeof body === 'object') return body;
    if (Buffer.byteLength(String(body)) > MAX_BODY) throw new CloudError(413, '請求內容過大');
    try { return body ? JSON.parse(body) : {}; } catch { throw new CloudError(400, '請求內容不是合法的 JSON'); }
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new CloudError(413, '請求內容過大');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return raw ? JSON.parse(raw) : {}; } catch { throw new CloudError(400, '請求內容不是合法的 JSON'); }
}

function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-content-type-options', 'nosniff');
  res.end(JSON.stringify(payload));
}
