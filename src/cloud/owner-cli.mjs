/**
 * 給在終端機跑的雲端腳本（cloud-sync-bank、cloud-backup）共用的登入與 REST 呼叫。
 *
 * 用擁有者帳密向 Supabase Auth 換權杖，之後每個請求都受 RLS 限制在本人的列，
 * 不需要 service role 金鑰。密碼從 CADENCE_PASSWORD 讀，沒設就在終端機隱藏輸入，
 * 不寫進任何檔案。
 */

import { readFileSync } from 'node:fs';

export function parseEnv(file) {
  const out = {};
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    if (at < 1) continue;
    let value = line.slice(at + 1).trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    out[line.slice(0, at).trim()] = value;
  }
  return out;
}

/** `--name value` 與布林旗標（flags 裡列的名字不吃下一個參數）。 */
export function parseArgs(values, flags = []) {
  const out = {};
  for (let i = 0; i < values.length; i += 1) {
    if (!values[i].startsWith('--')) throw new Error(`未知參數：${values[i]}`);
    const name = values[i].slice(2);
    if (flags.includes(name)) out[name] = true;
    else out[name] = values[++i];
  }
  return out;
}

export async function ownerSession(envFile) {
  const env = { ...(envFile ? parseEnv(envFile) : {}), ...process.env };
  const url = String(env.SUPABASE_URL ?? '').replace(/\/$/, '');
  const key = String(env.SUPABASE_PUBLISHABLE_KEY ?? '');
  const email = String(env.CADENCE_OWNER_EMAIL ?? '').trim().toLowerCase();
  if (!/^https:\/\/[^/]+$/.test(url) || !key || !email) {
    throw new Error('需要 SUPABASE_URL、SUPABASE_PUBLISHABLE_KEY、CADENCE_OWNER_EMAIL（--env 檔或環境變數）');
  }
  const password = env.CADENCE_PASSWORD || await promptHidden(`${email} 的密碼：`);
  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: key, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json().catch(() => null);
  // 只有狀態碼時，400 分不出是密碼錯、帳號未驗證還是請求格式問題；帶上 Supabase 的錯誤代碼（不含任何密鑰）
  const reason = body?.error_code ?? body?.error ?? '';
  if (!res.ok || !body?.access_token) throw new Error(`登入失敗（HTTP ${res.status}${reason ? ` ${reason}` : ''}）`);
  if (String(body.user?.email ?? '').toLowerCase() !== email) throw new Error('登入帳號不是 CADENCE_OWNER_EMAIL');
  return { url, key, token: body.access_token, owner: body.user.id };
}

/**
 * 分頁讀完整張表。Supabase 預設每次最多回 1,000 列，不分頁會靜默截斷。
 * query 必須自帶能唯一排序的 order，否則翻頁之間可能重複或漏列。
 */
export async function readAll(session, query) {
  const out = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const res = await fetch(`${session.url}/rest/v1/${query}`, {
      headers: { ...authHeaders(session), range: `${from}-${from + page - 1}` },
    });
    if (!res.ok) throw new Error(`讀取 ${query.split('?')[0]} 失敗（HTTP ${res.status}）：${await res.text()}`);
    const rows = await res.json();
    out.push(...rows);
    if (rows.length < page) return out;
  }
}

export async function rest(session, method, query, body, prefer) {
  const headers = authHeaders(session);
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (prefer) headers.prefer = prefer;
  const res = await fetch(`${session.url}/rest/v1/${query}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${query.split('?')[0]} 失敗（HTTP ${res.status}）：${await res.text()}`);
}

function authHeaders(session) {
  return { apikey: session.key, authorization: `Bearer ${session.token}` };
}

function promptHidden(label) {
  if (!process.stdin.isTTY) return Promise.reject(new Error('非互動終端機；請改設 CADENCE_PASSWORD'));
  return new Promise((resolve) => {
    process.stdout.write(label);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0003') { stdin.setRawMode(false); process.stdout.write('\n'); process.exit(130); }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}
