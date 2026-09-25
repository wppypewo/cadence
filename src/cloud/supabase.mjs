/** Supabase Auth 與 Data API 的最小客戶端；只用原生 fetch，避免把管理員金鑰帶進瀏覽器。 */

export function cloudConfig(env = process.env) {
  const url = String(env.SUPABASE_URL ?? '').replace(/\/$/, '');
  const key = String(env.SUPABASE_PUBLISHABLE_KEY ?? '');
  const ownerEmail = String(env.CADENCE_OWNER_EMAIL ?? '').trim().toLowerCase();
  const tokenSecret = String(env.CADENCE_TOKEN_SECRET ?? '').trim();
  if (!/^https:\/\/[^/]+$/.test(url)) throw new CloudError(500, 'SUPABASE_URL 尚未設定');
  if (!key) throw new CloudError(500, 'SUPABASE_PUBLISHABLE_KEY 尚未設定');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) {
    throw new CloudError(500, 'CADENCE_OWNER_EMAIL 尚未設定');
  }
  if (!/^[a-f0-9]{64}$/i.test(tokenSecret)) {
    throw new CloudError(500, 'CADENCE_TOKEN_SECRET 尚未設定');
  }
  return { url, key, ownerEmail, tokenSecret };
}

export async function authRequest(config, path, { method = 'GET', token, body, fetchImpl = fetch } = {}) {
  const headers = { apikey: config.key };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetchImpl(`${config.url}/auth/v1${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return decode(res, { clientErrors: true });
}

export async function restRequest(config, path, {
  method = 'GET', token, body, prefer, range, fetchImpl = fetch,
} = {}) {
  const headers = {
    apikey: config.key,
    authorization: `Bearer ${token}`,
  };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (prefer) headers.prefer = prefer;
  if (range) headers.range = range;
  const res = await fetchImpl(`${config.url}/rest/v1/${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return decode(res);
}

export async function countRows(config, table, token, query = '', fetchImpl = fetch) {
  const join = query ? `&${query}` : '';
  const { response } = await restRequest(config, `${table}?select=*&limit=1${join}`, {
    token,
    prefer: 'count=exact',
    range: '0-0',
    fetchImpl,
  });
  const raw = response.headers.get('content-range') ?? '';
  const match = raw.match(/\/(\d+)$/);
  return match ? Number(match[1]) : 0;
}

async function decode(response, { clientErrors = false } = {}) {
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new CloudError(502, `Supabase 回應格式錯誤（HTTP ${response.status}）`);
  }
  if (!response.ok) {
    const message = data?.msg ?? data?.message ?? data?.error_description ?? data?.error ?? `HTTP ${response.status}`;
    const status = response.status === 401
      ? 401
      : (clientErrors && response.status >= 400 && response.status < 500 ? response.status : 502);
    throw new CloudError(status, message, data);
  }
  return { data, response };
}

export class CloudError extends Error {
  constructor(status, message, detail = null) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}
