/**
 * 跟本機伺服器講話。就一個 fetch 包裝，外加把後端的錯誤訊息原樣帶出來——
 * 後端的錯誤訊息本來就是寫給人看的繁體中文，不需要在前端再翻譯一次。
 */

async function call(method, path, { query, body } = {}) {
  const url = new URL(path, location.origin);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === null || v === undefined || v === '') continue;
    url.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`伺服器回了不是 JSON 的東西（HTTP ${res.status}）`);
  }
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data;
}

export const api = {
  summary: () => call('GET', '/api/summary'),
  today: () => call('GET', '/api/today'),
  doc: (id) => call('GET', '/api/doc', { query: { id } }),
  queue: (q) => call('GET', '/api/queue', { query: q }),
  stats: (q) => call('GET', '/api/stats', { query: q }),
  forecast: (q) => call('GET', '/api/forecast', { query: q }),
  search: (q) => call('GET', '/api/search', { query: { q } }),
  settings: () => call('GET', '/api/settings'),
  saveSettings: (body) => call('POST', '/api/settings', { body }),
  review: (body) => call('POST', '/api/review', { body }),
  verb: (name) => call('GET', `/api/verb/${encodeURIComponent(name)}`),
};
