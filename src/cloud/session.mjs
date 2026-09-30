/** HttpOnly Cookie session。Access token 短存、refresh token 只送回同網域 API。 */

import { createPublicKey, verify } from 'node:crypto';
import { authRequest, CloudError } from './supabase.mjs';

const ACCESS = 'cadence_access';
const REFRESH = 'cadence_refresh';
// Supabase 建議的快取時間；簽章金鑰輪替時新金鑰會先以備用身分發布，十分鐘內一定看得到。
const JWKS_TTL_MS = 10 * 60 * 1000;
// 查無 kid 時重抓的最短間隔，避免隨便編個 kid 就能讓每次請求都多打一趟 JWKS。
const JWKS_RETRY_MS = 30 * 1000;
const jwksCache = new Map();

export async function login(config, credentials, { fetchImpl = fetch, secure = true } = {}) {
  const email = bounded(credentials?.email, 320, '電子郵件');
  const password = bounded(credentials?.password, 1024, '密碼');
  let result;
  try {
    result = await authRequest(config, '/token?grant_type=password', {
      method: 'POST', body: { email, password }, fetchImpl,
    });
  } catch (err) {
    if (err instanceof CloudError && (err.status === 400 || err.status === 401)) {
      throw new CloudError(401, '電子郵件或密碼不正確');
    }
    throw err;
  }
  const session = result.data;
  if (!session?.access_token || !session?.refresh_token || !session?.user) {
    throw new CloudError(502, 'Supabase 沒有回傳完整登入狀態');
  }
  assertOwner(config, session.user);
  return { user: publicUser(session.user), cookies: sessionCookies(session, secure) };
}

export async function register(config, credentials, { fetchImpl = fetch, secure = true } = {}) {
  const email = bounded(credentials?.email, 320, '電子郵件').toLowerCase();
  if (email !== config.ownerEmail) throw new CloudError(403, '此網站只接受指定的擁有者信箱');
  const password = bounded(credentials?.password, 1024, '密碼');
  if (password.length < 12) throw new CloudError(400, '密碼至少需要 12 個字元');
  let result;
  try {
    result = await authRequest(config, '/signup', {
      method: 'POST', body: { email, password }, fetchImpl,
    });
  } catch (err) {
    if (err instanceof CloudError && err.status === 429) {
      throw new CloudError(429, '驗證信已寄出；請查看收件匣或垃圾郵件，不要重複建立帳號');
    }
    if (err instanceof CloudError && err.status >= 400 && err.status < 500) {
      throw new CloudError(400, '帳號建立失敗；請確認信箱、密碼，或改用登入');
    }
    throw err;
  }
  const session = result.data?.session;
  const user = result.data?.user;
  if (!user) throw new CloudError(502, 'Supabase 沒有回傳帳號狀態');
  assertOwner(config, user);
  return {
    user: publicUser(user),
    needsConfirmation: !session,
    cookies: session ? sessionCookies(session, secure) : [],
  };
}

export async function authenticate(config, req, { fetchImpl = fetch, secure = true } = {}) {
  const jar = parseCookies(req.headers?.cookie);
  const access = jar.get(ACCESS);
  if (access) {
    const claims = await verifyLocally(config, access, fetchImpl);
    if (claims) {
      const user = { id: claims.sub, email: claims.email };
      assertOwner(config, user);
      return { token: access, user: publicUser(user), cookies: [] };
    }
    try {
      const { data: user } = await authRequest(config, '/user', { token: access, fetchImpl });
      assertOwner(config, user);
      return { token: access, user: publicUser(user), cookies: [] };
    } catch (err) {
      if (!(err instanceof CloudError) || err.status !== 401) throw err;
    }
  }
  const refresh = jar.get(REFRESH);
  if (!refresh) throw new CloudError(401, '請先登入');
  try {
    const { data: session } = await authRequest(config, '/token?grant_type=refresh_token', {
      method: 'POST', body: { refresh_token: refresh }, fetchImpl,
    });
    if (!session?.access_token || !session?.refresh_token || !session?.user) throw new Error('refresh payload incomplete');
    assertOwner(config, session.user);
    return {
      token: session.access_token,
      user: publicUser(session.user),
      cookies: sessionCookies(session, secure),
    };
  } catch (err) {
    if (err instanceof CloudError && err.status !== 401) throw err;
    throw new CloudError(401, '登入已過期，請重新登入');
  }
}

/**
 * 在函式內驗 access token 的簽章與宣告，省掉每個請求先打一趟 /auth/v1/user。
 * 資料請求送到 PostgREST 時它會再驗一次同一個 JWT，RLS 照樣生效，所以這裡信任的範圍
 * 和 PostgREST 相同。代價是登出或撤銷後的 token 在到期（最多一小時）前仍會通過這關；
 * 本站登出會一併清 Cookie，這個差別只影響被複製出去的 token，而那種 token 本來就能直接打 PostgREST。
 * 任何一步不成立（舊版 HS256、JWKS 抓不到、簽章或宣告不符、已過期）都回 null，
 * 交回原本的 /auth/v1/user 路徑判斷，最壞情況等於改動前。
 */
async function verifyLocally(config, token, fetchImpl) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const verifier = VERIFIERS[header?.alg];
    if (!verifier || typeof header.kid !== 'string') return null;
    const jwk = await signingKey(config, header.kid, fetchImpl);
    if (!jwk || (jwk.alg && jwk.alg !== header.alg)) return null;
    const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
    const signature = Buffer.from(parts[2], 'base64url');
    const key = createPublicKey({ key: jwk, format: 'jwk' });
    if (!verify('sha256', signed, verifier(key), signature)) return null;
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const now = Date.now() / 1000;
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!(claims.exp > now)) return null;
    if (claims.iss !== `${config.url}/auth/v1`) return null;
    if (!audience.includes('authenticated') || claims.role !== 'authenticated') return null;
    if (typeof claims.sub !== 'string' || !claims.sub || typeof claims.email !== 'string') return null;
    return claims;
  } catch {
    return null;
  }
}

const VERIFIERS = {
  // JWS 的 ECDSA 簽章是 r‖s 各 32 位元組，不是 Node 預設的 DER。
  ES256: (key) => ({ key, dsaEncoding: 'ieee-p1363' }),
  RS256: (key) => key,
};

async function signingKey(config, kid, fetchImpl) {
  const now = Date.now();
  let entry = jwksCache.get(config.url);
  const stale = !entry || now - entry.at > JWKS_TTL_MS;
  const missing = entry && !entry.keys.has(kid) && now - entry.at > JWKS_RETRY_MS;
  const backoff = entry?.failedAt && now - entry.failedAt < JWKS_RETRY_MS;
  if ((stale || missing) && !backoff) {
    try {
      const { data } = await authRequest(config, '/.well-known/jwks.json', { fetchImpl });
      const keys = new Map((data?.keys ?? []).filter((k) => typeof k?.kid === 'string').map((k) => [k.kid, k]));
      entry = { at: now, keys };
      jwksCache.set(config.url, entry);
    } catch {
      // JWKS 暫時抓不到時沿用舊快取（若有），否則交給 /auth/v1/user；
      // 記下失敗時間，免得 Auth 出狀況時每個請求都先白打一趟。
      entry = { at: entry?.at ?? 0, keys: entry?.keys ?? new Map(), failedAt: now };
      jwksCache.set(config.url, entry);
    }
  }
  return entry?.keys.get(kid) ?? null;
}

export async function logout(config, req, { fetchImpl = fetch, secure = true } = {}) {
  const access = parseCookies(req.headers?.cookie).get(ACCESS);
  if (access) {
    try {
      await authRequest(config, '/logout', { method: 'POST', token: access, fetchImpl });
    } catch {
      // 遠端 session 已失效也要清掉本機 Cookie，否則使用者會卡在登出迴圈。
    }
  }
  return clearCookies(secure);
}

export function appendCookies(res, cookies) {
  if (cookies?.length) res.setHeader('set-cookie', cookies);
}

export function clearCookies(secure = true) {
  return [cookie(ACCESS, '', { maxAge: 0, secure }), cookie(REFRESH, '', { maxAge: 0, secure })];
}

function sessionCookies(session, secure) {
  const seconds = Number.isFinite(Number(session.expires_in)) ? Math.max(60, Number(session.expires_in) - 30) : 3570;
  return [
    cookie(ACCESS, session.access_token, { maxAge: seconds, secure }),
    cookie(REFRESH, session.refresh_token, { maxAge: 60 * 60 * 24 * 30, secure }),
  ];
}

function cookie(name, value, { maxAge, secure }) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function parseCookies(raw = '') {
  const out = new Map();
  for (const part of String(raw).split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    const name = part.slice(0, at).trim();
    try { out.set(name, decodeURIComponent(part.slice(at + 1).trim())); } catch { /* 壞 Cookie 當不存在。 */ }
  }
  return out;
}

function publicUser(user) {
  return { id: user.id, email: user.email ?? null };
}

function assertOwner(config, user) {
  const email = String(user?.email ?? '').trim().toLowerCase();
  if (!email || email !== config.ownerEmail) throw new CloudError(403, '這個帳號沒有 cadence 使用權限');
}

function bounded(value, max, label) {
  const text = String(value ?? '').trim();
  if (!text || text.length > max) throw new CloudError(400, `${label}格式不正確`);
  return text;
}
