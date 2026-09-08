// 建索引：掃描 → 解析 → 寫入 SQLite → 重算分岔關係。支援增量（size+mtime 未變就跳過）。
import fs from 'node:fs';
import path from 'node:path';
import {
  listProjects, listSessionFiles, listSidecars, dirUsage, parseSession,
} from './scan.mjs';
import {
  openDb, upsertProject, replaceSession, deleteSession, replaceSidecars,
  replaceLineage, setMeta, allSessions,
} from './store.mjs';
import { buildLineage, findContentEchoes } from './lineage.mjs';
import { claudeRoot, dbPath } from './paths.mjs';

/**
 * @param {object} opts
 * @param {string} [opts.root]  存檔根目錄
 * @param {string} [opts.out]   索引輸出目錄
 * @param {boolean} [opts.full] 忽略增量，全部重掃
 * @param {(e:object)=>void} [opts.onProgress]
 */
export async function buildIndex(opts = {}) {
  const root = claudeRoot(opts.root);
  const file = dbPath(opts.out);
  const db = openDb(file);
  const t0 = Date.now();

  const projects = listProjects(root);
  const known = new Map(
    db.prepare('SELECT id, size, mtime FROM sessions').all().map((r) => [r.id, r]),
  );
  const seen = new Set();
  const stats = { projects: projects.length, scanned: 0, skipped: 0, removed: 0, bytes: 0, badLines: 0 };

  for (const p of projects) {
    upsertProject(db, p);
    const files = listSessionFiles(p);
    for (const entry of files) {
      seen.add(entry.id);
      stats.bytes += entry.size;
      const prev = known.get(entry.id);
      if (!opts.full && prev && prev.size === entry.size && prev.mtime === entry.mtime) {
        stats.skipped++;
        continue;
      }
      const { session, messages } = await parseSession(entry);
      db.exec('BEGIN');
      try {
        replaceSession(db, session, messages);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      stats.scanned++;
      stats.badLines += session.badLines;
      opts.onProgress?.({ kind: 'session', id: entry.id, project: p.name, size: entry.size, done: stats.scanned + stats.skipped });
    }
  }

  // 已從磁碟消失的 session 要從索引移除
  for (const id of known.keys()) {
    if (!seen.has(id)) { deleteSession(db, id); stats.removed++; }
  }

  // sidecar（工具結果快取目錄）
  const sidecarRows = [];
  for (const p of projects) {
    for (const sc of listSidecars(p)) {
      const usage = dirUsage(sc.dir);
      sidecarRows.push({
        id: sc.id,
        project: p.name,
        dir: sc.dir,
        bytes: usage.bytes,
        files: usage.files,
        newest: usage.newest,
        hasSession: fs.existsSync(path.join(p.dir, `${sc.id}.jsonl`)),
      });
    }
  }
  replaceSidecars(db, sidecarRows);

  refreshLineage(db);

  setMeta(db, 'root', root);
  setMeta(db, 'scanned_at', new Date().toISOString());
  setMeta(db, 'scan_ms', String(Date.now() - t0));
  db.close();
  return { ...stats, root, db: file, ms: Date.now() - t0, sidecars: sidecarRows.length };
}

/** 重算分岔關係（scan 之後一定要跑，因為關係是跨檔案的）。 */
export function refreshLineage(db) {
  const sessions = allSessions(db);
  const rows = db.prepare('SELECT session_id, uuid, bytes FROM messages WHERE uuid IS NOT NULL').all();
  const bySession = new Map();
  for (const r of rows) {
    let list = bySession.get(r.session_id);
    if (!list) { list = []; bySession.set(r.session_id, list); }
    list.push({ uuid: r.uuid, bytes: r.bytes });
  }
  const { rows: lineageRows } = buildLineage(sessions, bySession);
  replaceLineage(db, lineageRows);

  // 內容層級的疑似同源：只看使用者訊息的雜湊，compact 續接會把 uuid 全換掉，
  // 單靠 uuid 交集抓不到，所以另外算一份當提示。
  const promptRows = db.prepare("SELECT session_id, hash FROM messages WHERE role = 'user' AND hash IS NOT NULL AND is_meta = 0").all();
  const hashesBySession = new Map();
  for (const r of promptRows) {
    let list = hashesBySession.get(r.session_id);
    if (!list) { list = []; hashesBySession.set(r.session_id, list); }
    list.push(r.hash);
  }
  const echoes = findContentEchoes(sessions, hashesBySession, lineageRows);
  setMeta(db, 'echoes', JSON.stringify(echoes.slice(0, 200)));

  return lineageRows;
}
