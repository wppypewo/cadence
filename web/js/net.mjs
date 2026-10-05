/**
 * 跟本機伺服器講話。就一個 fetch 包裝，外加把後端的錯誤訊息原樣帶出來——
 * 後端的錯誤訊息本來就是寫給人看的繁體中文，不需要在前端再翻譯一次。
 */

import { isCloudRuntime } from './runtime.mjs';

async function call(method, path, { query, body } = {}) {
  const url = new URL(path, location.origin);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === null || v === undefined || v === '') continue;
    url.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  let res;
  let text;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    text = await res.text();
  } catch {
    // 斷網時瀏覽器丟的是英文的「Failed to fetch」／「Load failed」，原樣印到 toast 上看不懂，
    // 更看不出剛按的那一題有沒有存到。寫入類的請求寫「沒有確認存到」而不是「沒存」：
    // 請求可能已經送到、只是回應在路上斷了，前端分不出這兩種情況。
    const err = new Error(method === 'GET'
      ? '連不上伺服器。網路恢復後再試一次。'
      : '連不上伺服器，這一筆沒有確認存到。網路恢復後再按一次。');
    err.offline = true;
    throw err;
  }
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`伺服器回了不是 JSON 的東西（HTTP ${res.status}）`);
  }
  if (!res.ok) {
    const err = new Error(data?.error ?? `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const DOCS = {
  co: { file: 'delf-b1-comprehension-orale.md', title: 'DELF B1 聽力' },
  pe: { file: 'delf-b1-production-ecrite.md', title: 'DELF B1 寫作' },
  po: { file: 'delf-b1-production-orale.md', title: 'DELF B1 口說' },
};

/**
 * 雲端版把 study/ 當靜態檔案發出去（scripts/build-web.mjs 複製進 dist/）；
 * 本機伺服器只發 web/，study/ 走 /api/doc 的白名單端點，直接抓 /study/ 會 404。
 */
async function staticDoc(id) {
  const entry = DOCS[String(id ?? '')];
  if (!entry) {
    const err = new Error(`沒有這份文件：${id}`);
    err.status = 404;
    throw err;
  }
  const path = `/study/${entry.file}`;
  const res = await fetch(path, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`讀不到 ${path}（HTTP ${res.status}）`);
  return { id, title: entry.title, path: path.slice(1), text: await res.text() };
}

export const api = {
  session: () => call('GET', '/api/session'),
  register: (body) => call('POST', '/api/auth/register', { body }),
  login: (body) => call('POST', '/api/auth/login', { body }),
  logout: () => call('POST', '/api/auth/logout', { body: {} }),
  summary: () => call('GET', '/api/summary'),
  today: () => call('GET', '/api/today'),
  outlook: () => call('GET', '/api/outlook'),
  sentence: (i) => call('GET', '/api/sentence', { query: i === undefined ? {} : { i } }),
  weekly: () => call('GET', '/api/weekly'),
  resources: () => call('GET', '/api/resources'),
  doc: (id) => (isCloudRuntime() ? staticDoc(id) : call('GET', '/api/doc', { query: { id } })),
  queue: (q) => call('GET', '/api/queue', { query: q }),
  reveal: (id) => call('GET', '/api/reveal', { query: { id } }),
  preview: (id) => call('GET', '/api/preview', { query: { id } }),
  stats: (q) => call('GET', '/api/stats', { query: q }),
  forecast: (q) => call('GET', '/api/forecast', { query: q }),
  search: (q) => call('GET', '/api/search', { query: { q } }),
  settings: () => call('GET', '/api/settings'),
  backup: () => call('GET', '/api/backup'),
  saveSettings: (body) => call('POST', '/api/settings', { body }),
  review: (body) => call('POST', '/api/review', { body }),
  correctReview: (body) => call('POST', '/api/review-correction', { body }),
  checkin: (body) => call('POST', '/api/checkin', { body }),
  practice: (body) => call('POST', '/api/practice', { body }),
  mock: (body) => call('POST', '/api/mock', { body }),
  verb: (name) => call('GET', `/api/verb/${encodeURIComponent(name)}`),
};
