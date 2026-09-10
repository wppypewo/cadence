/**
 * 本機 HTTP 伺服器。零依賴，只用 node: 內建模組。
 *
 * 一律綁 127.0.0.1。這個 App 存的是個人的學習紀錄，
 * 沒有任何理由讓它出現在區網上，也沒有做任何驗證機制去擋。
 */

import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './db.mjs';
import { Api, HttpError } from './api.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const WEB_DIR = path.join(ROOT, 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

const MAX_BODY = 64 * 1024;

/**
 * 前後端共用的模組。批改規則只有一份實作（src/engine/grade.mjs），
 * 瀏覽器直接載同一個檔，不複製貼上——否則遲早會出現
 *「畫面說對、伺服器記成錯」這種對不起來的狀況。
 * 白名單制：只有列在這裡的路徑能走出 web/ 之外。
 */
const SHARED = new Map([
  ['/js/shared/grade.mjs', path.join(ROOT, 'src/engine/grade.mjs')],
]);

export async function createApp({ dataDir = path.join(ROOT, 'data') } = {}) {
  const store = new Store(dataDir);
  if (store.cardCount() === 0) {
    await store.loadBank();
  }
  const metaFile = path.join(store.bankDir, 'meta.json');
  if (existsSync(metaFile)) {
    store.set('bankMeta', JSON.parse(await readFile(metaFile, 'utf8')));
  }
  const api = new Api(store);
  return { store, api, handler: makeHandler(api) };
}

function makeHandler(api) {
  return async function handler(req, res) {
    try {
      guardLocalRequest(req);
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname.startsWith('/api/')) {
        await handleApi(api, req, res, url);
        return;
      }
      await serveStatic(res, url.pathname);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      send(res, status, { error: err.message });
    }
  };
}

/**
 * 綁在 loopback 只能擋區網連線，擋不了瀏覽器從惡意網站對 127.0.0.1 發 POST。
 * Host 白名單同時封住 DNS rebinding；JSON content-type 讓跨站 simple request 無法寫入，
 * Origin 則在瀏覽器有送時再核對一次。三條都只依實際 socket 的本機 port 判斷。
 */
export function guardLocalRequest(req) {
  const port = req.socket.localPort;
  const authorities = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (port === 80) {
    authorities.add('127.0.0.1');
    authorities.add('localhost');
  }
  if (!authorities.has(String(req.headers.host ?? '').toLowerCase())) {
    throw new HttpError(403, '只接受本機 cadence 網址');
  }

  if (req.method !== 'POST') return;
  const type = String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, 'POST 只接受 application/json');

  const origin = req.headers.origin;
  if (!origin) return;
  let authority;
  try {
    const parsed = new URL(origin);
    authority = parsed.protocol === 'http:' ? parsed.host.toLowerCase() : '';
  } catch {
    authority = '';
  }
  if (!authorities.has(authority)) throw new HttpError(403, '拒絕跨站寫入');
}

async function handleApi(api, req, res, url) {
  const q = Object.fromEntries(url.searchParams);
  const route = `${req.method} ${url.pathname}`;

  switch (route) {
    case 'GET /api/summary':
      return send(res, 200, api.summary());
    case 'GET /api/today':
      return send(res, 200, api.today());
    case 'GET /api/doc':
      return send(res, 200, await api.doc(q));
    case 'GET /api/queue':
      return send(res, 200, api.queue(q));
    case 'GET /api/reveal':
      return send(res, 200, api.reveal(q));
    case 'GET /api/stats':
      return send(res, 200, api.stats(q));
    case 'GET /api/forecast':
      return send(res, 200, api.forecast(q));
    case 'GET /api/search':
      return send(res, 200, api.search(q));
    case 'GET /api/settings':
      return send(res, 200, api.settings(null));
    case 'POST /api/review':
      return send(res, 200, api.review(await body(req)));
    case 'POST /api/checkin':
      return send(res, 200, api.checkin(await body(req)));
    case 'POST /api/settings':
      return send(res, 200, api.settings(await body(req)));
    default:
      break;
  }

  const verb = url.pathname.match(/^\/api\/verb\/(.+)$/);
  if (verb && req.method === 'GET') {
    return send(res, 200, await api.verb(decodeURIComponent(verb[1])));
  }
  throw new HttpError(404, `沒有這個端點：${route}`);
}

function body(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, '請求內容過大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, '請求內容不是合法的 JSON'));
      }
    });
    req.on('error', reject);
  });
}

async function serveStatic(res, pathname) {
  const shared = SHARED.get(pathname);
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  // 正規化後再確認仍在 web/ 之內，擋掉 ../ 穿越。
  const file = shared ?? path.resolve(WEB_DIR, rel);
  if (!shared && file !== WEB_DIR && !file.startsWith(WEB_DIR + path.sep)) {
    throw new HttpError(403, '禁止存取');
  }
  if (!existsSync(file) || !statSync(file).isFile()) {
    throw new HttpError(404, `找不到 ${pathname}`);
  }
  const type = MIME[path.extname(file)] ?? 'application/octet-stream';
  res.writeHead(200, {
    'content-type': type,
    'cache-control': 'no-cache',
    'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'",
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
  });
  createReadStream(file).pipe(res);
}

function send(res, status, payload) {
  const json = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(json);
}

export async function serve({ port = 4173, dataDir } = {}) {
  const app = await createApp({ dataDir });
  const server = createServer(app.handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return { ...app, server, port: server.address().port };
}
