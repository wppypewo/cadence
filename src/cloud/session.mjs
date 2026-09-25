/** HttpOnly Cookie session。Access token 短存、refresh token 只送回同網域 API。 */

import { authRequest, CloudError } from './supabase.mjs';

const ACCESS = 'cadence_access';
const REFRESH = 'cadence_refresh';

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
