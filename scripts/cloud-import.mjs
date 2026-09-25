/**
 * 一次性把本機事實資料搬到 Supabase。只透過短效匯入權杖呼叫資料庫 RPC，
 * 不需要 service role，也不會把 Verbiste 衍生的變位題庫帶出 data/bank/。
 */

import { createHash } from 'node:crypto';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/db.mjs';

const args = parseArgs(process.argv.slice(2));
const dataDir = required(args, 'data');
const ownerId = required(args, 'owner');
const envFile = required(args, 'env');
const manifestOnly = args['manifest-only'] === true;
const tokenFile = manifestOnly ? null : required(args, 'token-file');

const env = { ...parseEnv(envFile), ...process.env };
const supabaseUrl = String(env.SUPABASE_URL ?? '').replace(/\/$/, '');
const publishableKey = String(env.SUPABASE_PUBLISHABLE_KEY ?? '');
if (!/^https:\/\/[^/]+$/.test(supabaseUrl) || !publishableKey) {
  throw new Error('env 檔缺少 SUPABASE_URL 或 SUPABASE_PUBLISHABLE_KEY');
}

const snapshotDir = mkdtempSync(path.join(tmpdir(), 'cadence-cloud-import-'));
let store;
try {
  copySnapshot(dataDir, snapshotDir);
  const prepared = await prepare(snapshotDir, ownerId);
  console.log(JSON.stringify(prepared.manifest));
  if (!manifestOnly) {
    const token = readFileSync(tokenFile, 'utf8').trim();
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('匯入權杖格式錯誤');
    await sendAll({ supabaseUrl, publishableKey, token }, prepared);
    console.log(JSON.stringify({ completed: true, counts: prepared.manifest.counts }));
  }
} finally {
  store?.close();
  rmSync(snapshotDir, { recursive: true, force: true });
}

async function prepare(dir, owner) {
  const bankDir = path.join(dir, 'bank');
  const meta = JSON.parse(readFileSync(path.join(bankDir, 'meta.json'), 'utf8'));
  const allCards = JSON.parse(readFileSync(path.join(bankDir, 'cards.json'), 'utf8'));
  const connectors = JSON.parse(readFileSync(path.join(bankDir, 'connectors.json'), 'utf8'));
  const settings = JSON.parse(readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  const reviewLines = readFileSync(path.join(dir, 'reviews.jsonl'), 'utf8')
    .split('\n').map((line) => line.trim()).filter(Boolean);
  const reviewRows = reviewLines.map((line) => JSON.parse(line));

  const safeCards = allCards.filter((card) => card.kind !== 'conj');
  const safeIds = new Set(safeCards.map((card) => card.id));
  const bankVersion = String(meta.sourceFingerprint);

  store = new Store(dir);
  await store.loadBank();
  const rebuilt = await store.reindex();
  if (rebuilt.bad.length !== 0 || rebuilt.applied !== reviewRows.length) {
    throw new Error(`複習紀錄重建不完整：${JSON.stringify(rebuilt)}`);
  }

  const cards = safeCards.map((card) => ({
    owner_id: owner,
    id: card.id,
    kind: card.kind,
    mode: card.mode,
    level: card.level,
    freq: card.freq ?? 0,
    tags: card.tags ?? [],
    answer: card.answer ?? null,
    accept: card.accept ?? null,
    search: searchText(card),
    headword: searchHeadword(card),
    payload: card,
    bank_version: bankVersion,
  }));

  const states = store.db.prepare(
    `SELECT s.card_id, s.stability, s.difficulty, s.due, s.last_review, s.reps, s.lapses
     FROM states s JOIN cards c ON c.id = s.card_id
     WHERE c.kind <> 'conj' ORDER BY s.card_id`,
  ).all().map((row) => ({ owner_id: owner, ...row, version: 1 }));

  const reviews = reviewRows.map((entry, index) => ({
    owner_id: owner,
    event_id: entry.id ?? deterministicUuid(`review\0${index}\0${reviewLines[index]}`),
    event_type: entry.type ?? 'review',
    target_event_id: entry.target ?? null,
    card_id: safeIds.has(entry.card) ? entry.card : null,
    at: entry.at,
    study_day: entry.day,
    rating: entry.rating ?? null,
    elapsed_days: entry.elapsed ?? null,
    answered: entry.answered ?? null,
    correct: entry.correct ?? null,
    reason: entry.reason ?? null,
    response_ms: entry.ms ?? null,
    self_rated: entry.selfRated === true,
    payload: entry,
  }));

  const references = connectors.map((entry) => ({
    owner_id: owner,
    entry_type: 'connector',
    entry_key: entry.connector,
    payload: entry,
    bank_version: bankVersion,
  }));
  references.push({
    owner_id: owner,
    entry_type: 'meta',
    entry_key: 'bank',
    payload: {
      builtAt: meta.builtAt,
      sourceFingerprint: bankVersion,
      counts: { cards: safeCards.length, connectors: connectors.length },
      excluded: {
        conjugationCards: allCards.length - safeCards.length,
        verbTables: meta.counts?.verbTables ?? null,
        reason: 'Verbiste 衍生資料依 GPL-2.0 隔離，未上傳。',
      },
    },
    bank_version: bankVersion,
  });

  const settingRows = [{
    owner_id: owner,
    desired_retention: settings.desiredRetention,
    daily_new_limit: settings.dailyNewLimit,
    exam_date: settings.examDate,
    start_level: settings.startLevel,
    timezone: 'Asia/Taipei',
  }];

  const sourceHash = hashFiles([
    path.join(bankDir, 'cards.json'),
    path.join(bankDir, 'connectors.json'),
    path.join(bankDir, 'meta.json'),
    path.join(dir, 'reviews.jsonl'),
    path.join(dir, 'settings.json'),
  ]);
  const excludedReviews = reviews.filter((row) => row.card_id === null).length;
  const manifest = {
    sourceHash,
    bankVersion,
    counts: {
      cards: cards.length,
      states: states.length,
      reviews: reviews.length,
      references: references.length,
      settings: settingRows.length,
      reviewsWithoutUploadedCard: excludedReviews,
    },
  };
  return { manifest, cards, states, reviews, references, settings: settingRows };
}

async function sendAll(config, prepared) {
  for (const [kind, rows, size] of [
    ['cards', prepared.cards, 200],
    ['states', prepared.states, 400],
    ['reviews', prepared.reviews, 400],
    ['references', prepared.references, 400],
    ['settings', prepared.settings, 1],
  ]) {
    let sent = 0;
    for (let at = 0; at < rows.length; at += size) {
      const batch = rows.slice(at, at + size);
      const response = await fetch(`${config.supabaseUrl}/rest/v1/rpc/cadence_import_batch`, {
        method: 'POST',
        headers: {
          apikey: config.publishableKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ p_token: config.token, p_kind: kind, p_rows: batch }),
      });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`${kind} 第 ${at + 1} 筆起匯入失敗（HTTP ${response.status}）：${body}`);
      }
      sent += batch.length;
    }
    console.log(JSON.stringify({ kind, sent }));
  }
}

function copySnapshot(from, to) {
  mkdirSync(path.join(to, 'bank'), { recursive: true });
  for (const name of ['cards.json', 'connectors.json', 'meta.json']) {
    copyFileSync(path.join(from, 'bank', name), path.join(to, 'bank', name));
  }
  for (const name of ['reviews.jsonl', 'settings.json']) {
    copyFileSync(path.join(from, name), path.join(to, name));
  }
  for (const name of ['checkins.jsonl', 'attempts.jsonl']) {
    if (existsSync(path.join(from, name))) copyFileSync(path.join(from, name), path.join(to, name));
  }
}

function searchText(card) {
  const front = card.front ?? {};
  return [front.gloss, front.zh, front.prompt, front.verb, front.base, front.connector, front.word]
    .filter((value) => typeof value === 'string' && value.trim()).join(' ');
}

function searchHeadword(card) {
  const front = card.front ?? {};
  return front.word ?? front.verb ?? front.connector ?? front.base ?? card.answer ?? '';
}

function deterministicUuid(input) {
  const hex = createHash('sha256').update(input).digest('hex').slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const joined = hex.join('');
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}

function hashFiles(files) {
  const hash = createHash('sha256');
  for (const file of files) hash.update(readFileSync(file));
  return hash.digest('hex');
}

function parseEnv(file) {
  const out = {};
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    if (at < 1) continue;
    const key = line.slice(0, at).trim();
    let value = line.slice(at + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function parseArgs(values) {
  const out = {};
  for (let i = 0; i < values.length; i += 1) {
    const key = values[i];
    if (!key.startsWith('--')) throw new Error(`未知參數：${key}`);
    const name = key.slice(2);
    if (name === 'manifest-only') out[name] = true;
    else out[name] = values[++i];
  }
  return out;
}

function required(object, key) {
  const value = object[key];
  if (!value) throw new Error(`缺少 --${key}`);
  return value;
}
