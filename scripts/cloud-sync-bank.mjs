/**
 * 把本機重建後的題庫同步到 Supabase：只動 cards 與 reference_entries，
 * 不碰 review_events、card_states、user_settings。
 *
 * 為什麼不用 cloud-import.mjs：它依賴的 RPC cadence_import_batch 在 2026-09-26 已不存在
 * （public schema 查無任何 import 函式），而且它會連記憶狀態一起送。雲端作答直接寫雲端的表，
 * 不會回到本機 reviews.jsonl（當天實測雲端 573 筆、本機 569 筆），用本機算出的狀態覆寫
 * 會把只在雲端作答過的卡退回舊進度。
 *
 * 身分：用擁有者帳密向 Supabase Auth 換權杖，之後每個請求都受 RLS 限制在本人的列，
 * 不需要 service role 金鑰。密碼從 CADENCE_PASSWORD 讀，沒設就在終端機隱藏輸入。
 *
 * 預設只預演（會登入、讀雲端現況、印出差異，但不寫入）；加 --apply 才寫。
 *
 *   node scripts/cloud-sync-bank.mjs --env .env.cloud            # 預演
 *   node scripts/cloud-sync-bank.mjs --env .env.cloud --apply    # 寫入
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { cardRow, inList, referenceRows, uploadableCards } from '../src/cloud/bank-rows.mjs';

const args = parseArgs(process.argv.slice(2));
const dataDir = args.data ?? 'data';
const apply = args.apply === true;
const env = { ...(args.env ? parseEnv(args.env) : {}), ...process.env };
const url = String(env.SUPABASE_URL ?? '').replace(/\/$/, '');
const key = String(env.SUPABASE_PUBLISHABLE_KEY ?? '');
const ownerEmail = String(env.CADENCE_OWNER_EMAIL ?? '').trim().toLowerCase();
if (!/^https:\/\/[^/]+$/.test(url) || !key || !ownerEmail) {
  fail('需要 SUPABASE_URL、SUPABASE_PUBLISHABLE_KEY、CADENCE_OWNER_EMAIL（--env 檔或環境變數）');
}

const bankDir = path.join(dataDir, 'bank');
const meta = readJson(path.join(bankDir, 'meta.json'));
const allCards = readJson(path.join(bankDir, 'cards.json'));
const connectors = readJson(path.join(bankDir, 'connectors.json'));
const bankVersion = String(meta.sourceFingerprint);
const cards = uploadableCards(allCards);

const password = env.CADENCE_PASSWORD || await promptHidden(`${ownerEmail} 的密碼：`);
const session = await signIn(password);
const owner = session.user.id;
if (String(session.user.email ?? '').toLowerCase() !== ownerEmail) fail('登入帳號不是 CADENCE_OWNER_EMAIL');

const cloudIds = new Set(await readColumn('cards', 'id'));
const reviewed = new Set([
  ...await readColumn('review_events', 'card_id', 'card_id=not.is.null'),
  ...await readColumn('card_states', 'card_id'),
]);
const cloudConnectors = await readColumn('reference_entries', 'entry_key', 'entry_type=eq.connector');

const localIds = new Set(cards.map((card) => card.id));
const stale = [...cloudIds].filter((id) => !localIds.has(id));
// card_states 對 cards 是 on delete cascade，刪卡會連進度一起刪；review_events 沒有 cascade，
// 刪了會被外鍵擋下。兩種都只能留著。
const staleKept = stale.filter((id) => reviewed.has(id));
const staleDrop = stale.filter((id) => !reviewed.has(id));
const connectorKeys = new Set(connectors.map((entry) => entry.connector));
const staleConnectors = cloudConnectors.filter((k) => !connectorKeys.has(k));

console.log(JSON.stringify({
  mode: apply ? 'apply' : 'dry-run',
  bankVersion,
  local: { cards: cards.length, excludedConj: allCards.length - cards.length, connectors: connectors.length },
  cloud: { cards: cloudIds.size, reviewedCards: reviewed.size, connectors: cloudConnectors.length },
  upsert: {
    cards: cards.length,
    newCards: cards.filter((card) => !cloudIds.has(card.id)).length,
    references: connectors.length + 1,
  },
  delete: { cards: staleDrop.length, connectors: staleConnectors.length },
  keptStaleReviewed: staleKept,
  expectedCloudCards: cards.length + staleKept.length,
  sampleDeletes: staleDrop.slice(0, 20),
}, null, 2));

if (!apply) {
  console.log('預演結束，沒有寫入。確認無誤後加 --apply。');
  process.exit(0);
}

for (let at = 0; at < cards.length; at += 200) {
  const batch = cards.slice(at, at + 200).map((card) => cardRow(card, owner, bankVersion));
  await rest('POST', 'cards?on_conflict=owner_id,id', batch, 'resolution=merge-duplicates,return=minimal');
  progress('cards', Math.min(at + 200, cards.length), cards.length);
}
const refs = referenceRows({
  connectors, meta, owner, bankVersion, cardCount: cards.length, allCardCount: allCards.length,
});
await rest('POST', 'reference_entries?on_conflict=owner_id,entry_type,entry_key', refs,
  'resolution=merge-duplicates,return=minimal');
console.log(JSON.stringify({ references: refs.length }));

// 先寫後刪：中途失敗時雲端最多多出舊卡，不會少卡。重跑是冪等的。
for (let at = 0; at < staleDrop.length; at += 50) {
  const ids = staleDrop.slice(at, at + 50);
  await rest('DELETE', `cards?owner_id=eq.${owner}&id=${encodeURIComponent(inList(ids))}`);
}
if (staleConnectors.length) {
  await rest('DELETE', `reference_entries?owner_id=eq.${owner}&entry_type=eq.connector&entry_key=${encodeURIComponent(inList(staleConnectors))}`);
}

const after = await readColumn('cards', 'id');
const expected = cards.length + staleKept.length;
console.log(JSON.stringify({ completed: true, cloudCards: after.length, expected }));
if (after.length !== expected) fail(`雲端卡數 ${after.length} 與預期 ${expected} 不符`);

async function signIn(pw) {
  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: key, 'content-type': 'application/json' },
    body: JSON.stringify({ email: ownerEmail, password: pw }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.access_token) fail(`登入失敗（HTTP ${res.status}）`);
  return body;
}

/** Supabase 預設每次最多回 1,000 列，不分頁會靜默截斷。 */
async function readColumn(table, column, filter = '') {
  const out = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const query = `${table}?select=${column}${filter ? `&${filter}` : ''}&order=${column}`;
    const res = await fetch(`${url}/rest/v1/${query}`, {
      headers: { ...authHeaders(), range: `${from}-${from + page - 1}` },
    });
    if (!res.ok) fail(`讀取 ${table} 失敗（HTTP ${res.status}）：${await res.text()}`);
    const rows = await res.json();
    out.push(...rows.map((row) => row[column]));
    if (rows.length < page) break;
  }
  return [...new Set(out)];
}

async function rest(method, query, body, prefer) {
  const headers = authHeaders();
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (prefer) headers.prefer = prefer;
  const res = await fetch(`${url}/rest/v1/${query}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) fail(`${method} ${query.split('?')[0]} 失敗（HTTP ${res.status}）：${await res.text()}`);
}

function authHeaders() {
  return { apikey: key, authorization: `Bearer ${session.access_token}` };
}

function progress(label, done, total) {
  if (done === total || done % 2000 === 0) console.log(JSON.stringify({ [label]: `${done}/${total}` }));
}

function promptHidden(label) {
  if (!process.stdin.isTTY) fail('非互動終端機；請改設 CADENCE_PASSWORD');
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

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function parseEnv(file) {
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

function parseArgs(values) {
  const out = {};
  for (let i = 0; i < values.length; i += 1) {
    if (!values[i].startsWith('--')) fail(`未知參數：${values[i]}`);
    const name = values[i].slice(2);
    if (name === 'apply') out.apply = true;
    else out[name] = values[++i];
  }
  return out;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
