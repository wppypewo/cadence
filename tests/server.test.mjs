/** 本機 HTTP 邊界：惡意網站不能借使用者的瀏覽器改寫 cadence。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { guardLocalRequest } from '../src/server.mjs';

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
