// SQLite 索引。用 Node 內建的 node:sqlite，不引入任何第三方套件。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ensureDir } from './paths.mjs';

export const SCHEMA_VERSION = 4;

const DDL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT
);

CREATE TABLE IF NOT EXISTS projects (
  name TEXT PRIMARY KEY,
  cwd  TEXT NOT NULL,
  exact INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  cwd TEXT,
  file TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  lines INTEGER NOT NULL,
  bad_lines INTEGER NOT NULL,
  msgs INTEGER NOT NULL,
  user_msgs INTEGER NOT NULL,
  asst_msgs INTEGER NOT NULL,
  sidechain_msgs INTEGER NOT NULL DEFAULT 0,
  compact_summaries INTEGER NOT NULL DEFAULT 0,
  first_ts TEXT,
  last_ts TEXT,
  title TEXT,
  title_source TEXT,
  first_prompt TEXT,
  bytes_by TEXT NOT NULL,
  tools TEXT NOT NULL,
  models TEXT NOT NULL,
  tokens TEXT NOT NULL,
  versions TEXT NOT NULL,
  branches TEXT NOT NULL,
  entrypoints TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_project ON sessions(project);
CREATE INDEX IF NOT EXISTS sessions_last_ts ON sessions(last_ts);

CREATE TABLE IF NOT EXISTS messages (
  rowid INTEGER PRIMARY KEY,
  uuid TEXT,
  session_id TEXT NOT NULL,
  parent_uuid TEXT,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  ts TEXT,
  model TEXT,
  sidechain INTEGER NOT NULL DEFAULT 0,
  is_meta INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL,
  text_len INTEGER NOT NULL,
  tools TEXT,
  hash TEXT
);
CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS messages_uuid ON messages(uuid);
CREATE INDEX IF NOT EXISTS messages_hash ON messages(hash);

-- trigram 分詞器同時支援中文與英文子字串比對；unicode61 對中文無效。
CREATE VIRTUAL TABLE IF NOT EXISTS msg_fts USING fts5(
  text,
  tokenize='trigram'
);

CREATE TABLE IF NOT EXISTS sidecars (
  id TEXT NOT NULL,
  project TEXT NOT NULL,
  dir TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  files INTEGER NOT NULL,
  newest INTEGER NOT NULL,
  has_session INTEGER NOT NULL,
  PRIMARY KEY (project, id)
);

CREATE TABLE IF NOT EXISTS lineage (
  session_id TEXT PRIMARY KEY,
  group_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  shared_msgs INTEGER NOT NULL,
  unique_msgs INTEGER NOT NULL,
  shared_bytes INTEGER NOT NULL,
  unique_bytes INTEGER NOT NULL,
  redundant_bytes INTEGER NOT NULL,
  relatives TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS lineage_group ON lineage(group_id);
`;

export function openDb(file, { create = true } = {}) {
  if (create) ensureDir(path.dirname(file));
  else if (!fs.existsSync(file)) throw new Error(`索引不存在：${file}\n請先執行 ccarchive scan`);
  const db = new DatabaseSync(file);
  db.exec(DDL);
  const cur = getMeta(db, 'schema_version');
  if (cur && Number(cur) !== SCHEMA_VERSION) {
    db.close();
    throw new Error(`索引 schema 版本為 ${cur}，本版需要 ${SCHEMA_VERSION}。請刪除 ${file} 後重新 scan。`);
  }
  setMeta(db, 'schema_version', String(SCHEMA_VERSION));
  return db;
}

export function getMeta(db, k) {
  const row = db.prepare('SELECT v FROM meta WHERE k = ?').get(k);
  return row ? row.v : null;
}

export function setMeta(db, k, v) {
  db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, String(v));
}

export function upsertProject(db, p) {
  db.prepare('INSERT INTO projects (name, cwd, exact) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET cwd = excluded.cwd, exact = excluded.exact')
    .run(p.name, p.cwd, p.exact ? 1 : 0);
}

const SESSION_COLS = [
  'id', 'project', 'cwd', 'file', 'size', 'mtime', 'lines', 'bad_lines', 'msgs', 'user_msgs',
  'asst_msgs', 'sidechain_msgs', 'compact_summaries', 'first_ts', 'last_ts', 'title',
  'title_source', 'first_prompt', 'bytes_by', 'tools', 'models', 'tokens', 'versions',
  'branches', 'entrypoints',
];

export function replaceSession(db, s, messages) {
  db.prepare('DELETE FROM msg_fts WHERE rowid IN (SELECT rowid FROM messages WHERE session_id = ?)').run(s.id);
  db.prepare('DELETE FROM messages WHERE session_id = ?').run(s.id);
  db.prepare(`INSERT OR REPLACE INTO sessions (${SESSION_COLS.join(', ')}) VALUES (${SESSION_COLS.map(() => '?').join(', ')})`)
    .run(
      s.id, s.projectName, s.projectCwd, s.file, s.size, s.mtime, s.lines, s.badLines, s.msgs,
      s.userMsgs, s.asstMsgs, s.sidechainMsgs, s.compactSummaries, s.firstTs, s.lastTs, s.title,
      s.titleSource, s.firstUserText, JSON.stringify(s.bytesBy), JSON.stringify(s.tools),
      JSON.stringify(s.models), JSON.stringify(s.tokens), JSON.stringify(s.versions),
      JSON.stringify(s.branches), JSON.stringify(s.entrypoints),
    );

  const insMsg = db.prepare(`INSERT INTO messages
    (uuid, session_id, parent_uuid, seq, role, ts, model, sidechain, is_meta, bytes, text_len, tools, hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insFts = db.prepare('INSERT INTO msg_fts (rowid, text) VALUES (?, ?)');
  for (const m of messages) {
    const info = insMsg.run(
      m.uuid, s.id, m.parentUuid, m.seq, m.role, m.ts, m.model,
      m.isSidechain ? 1 : 0, m.isMeta ? 1 : 0, m.bytes, m.textLen,
      m.toolNames.length ? m.toolNames.join(',') : null, m.hash,
    );
    if (m.text) insFts.run(Number(info.lastInsertRowid), m.text);
  }
}

export function deleteSession(db, id) {
  db.prepare('DELETE FROM msg_fts WHERE rowid IN (SELECT rowid FROM messages WHERE session_id = ?)').run(id);
  db.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
  db.prepare('DELETE FROM lineage WHERE session_id = ?').run(id);
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

export function replaceSidecars(db, rows) {
  db.exec('DELETE FROM sidecars');
  const ins = db.prepare('INSERT INTO sidecars (id, project, dir, bytes, files, newest, has_session) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const r of rows) ins.run(r.id, r.project, r.dir, r.bytes, r.files, r.newest, r.hasSession ? 1 : 0);
}

export function replaceLineage(db, rows) {
  db.exec('DELETE FROM lineage');
  const ins = db.prepare(`INSERT INTO lineage
    (session_id, group_id, role, shared_msgs, unique_msgs, shared_bytes, unique_bytes, redundant_bytes, relatives)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const r of rows) {
    ins.run(r.sessionId, r.groupId, r.role, r.sharedMsgs, r.uniqueMsgs, r.sharedBytes, r.uniqueBytes, r.redundantBytes, JSON.stringify(r.relatives));
  }
}

/** 讀回 session 列，並把 JSON 欄位解開。 */
export function allSessions(db, { where = '', params = [] } = {}) {
  const rows = db.prepare(`SELECT * FROM sessions ${where} ORDER BY last_ts DESC`).all(...params);
  return rows.map(hydrateSession);
}

export function getSession(db, id) {
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  return row ? hydrateSession(row) : null;
}

/** 支援用 id 前綴查詢，省得每次貼完整 UUID。 */
export function resolveSessionId(db, prefix) {
  const exact = db.prepare('SELECT id FROM sessions WHERE id = ?').get(prefix);
  if (exact) return exact.id;
  const rows = db.prepare('SELECT id FROM sessions WHERE id LIKE ? LIMIT 5').all(`${prefix}%`);
  if (rows.length === 1) return rows[0].id;
  if (rows.length === 0) return null;
  const err = new Error(`session 前綴 "${prefix}" 對應到多筆：\n  ${rows.map((r) => r.id).join('\n  ')}`);
  err.ambiguous = true;
  throw err;
}

function hydrateSession(row) {
  return {
    ...row,
    bytesBy: safeJson(row.bytes_by, {}),
    tools: safeJson(row.tools, {}),
    models: safeJson(row.models, {}),
    tokens: safeJson(row.tokens, {}),
    versions: safeJson(row.versions, []),
    branches: safeJson(row.branches, []),
    entrypoints: safeJson(row.entrypoints, []),
  };
}

function safeJson(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}
