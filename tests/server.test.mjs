/** 本機 HTTP 邊界：惡意網站不能借使用者的瀏覽器改寫 cadence。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { guardLocalRequest, serve } from '../src/server.mjs';

function req({
  method = 'GET', host = '127.0.0.1:4173', origin = null,
  type = null, port = 4173,
} = {}) {
  return {
    method,
    headers: {
      host,
      ...(origin ? { origin } : {}),
      ...(type ? { 'content-type': type } : {}),
    },
    socket: { localPort: port },
  };
}

test('只接受本機 Host，POST 同時要求 JSON 與同源 Origin', () => {
  assert.doesNotThrow(() => guardLocalRequest(req()));
  assert.doesNotThrow(() => guardLocalRequest(req({ host: 'localhost:4173' })));
  assert.doesNotThrow(() => guardLocalRequest(req({
    method: 'POST', type: 'application/json; charset=utf-8', origin: 'http://127.0.0.1:4173',
  })));
  // 沒有 Origin 的本機 CLI 仍能寫；application/json 已經讓瀏覽器跨站 simple request 走不進來。
  assert.doesNotThrow(() => guardLocalRequest(req({ method: 'POST', type: 'application/json' })));

  assert.throws(
    () => guardLocalRequest(req({ host: 'evil.example' })),
    (err) => err.status === 403 && /本機/.test(err.message),
  );
  assert.throws(
    () => guardLocalRequest(req({ method: 'POST', type: 'text/plain' })),
    (err) => err.status === 415,
  );
  assert.throws(
    () => guardLocalRequest(req({
      method: 'POST', type: 'application/json', origin: 'https://evil.example',
    })),
    (err) => err.status === 403 && /跨站/.test(err.message),
  );
  assert.throws(
    () => guardLocalRequest(req({
      method: 'POST', type: 'application/json', origin: 'https://127.0.0.1:4173',
    })),
    (err) => err.status === 403,
  );
});

test('真正啟動 HTTP 後，首頁、讀取與寫入路由可用，未知路徑回 404', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cadence-server-'));
  mkdirSync(path.join(dir, 'bank'), { recursive: true });
  writeFileSync(path.join(dir, 'bank', 'cards.json'), JSON.stringify([{
    id: 'v:test', kind: 'vocab-recall', mode: 'self', level: 'A2', freq: 1,
    tags: ['test'], answer: '測試', accept: null, front: { word: 'test', gloss: '測試' },
  }]));
  const app = await serve({ port: 0, dataDir: dir });
  const base = `http://127.0.0.1:${app.port}`;
  try {
    const home = await fetch(`${base}/`);
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-type'), /text\/html/);

    const summary = await fetch(`${base}/api/summary`);
    assert.equal(summary.status, 200);
    assert.equal((await summary.json()).totalCards, 1);

    const settings = await fetch(`${base}/api/settings`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dailyNewLimit: 12 }),
    });
    assert.equal(settings.status, 200);
    assert.equal((await settings.json()).dailyNewLimit, 12);

    assert.equal((await fetch(`${base}/api/not-found`)).status, 404);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    app.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
