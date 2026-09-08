// 報表資料：全部從索引算，不重讀原始對話檔，也不把對話內容寫進 HTML。
import fs from 'node:fs';
import { openDb, allSessions, getMeta } from '../store.mjs';
import { dbPath, shortProject } from '../paths.mjs';
import { BYTE_CATEGORIES, CATEGORY_LABELS } from '../normalize.mjs';

export function collect({ out, root }) {
  const db = openDb(dbPath(out), { create: false });
  const sessions = allSessions(db);
  const sidecars = db.prepare('SELECT * FROM sidecars').all();
  const lineageRows = db.prepare('SELECT * FROM lineage').all()
    .map((r) => ({ ...r, relatives: safeJson(r.relatives, []) }));
  const msgTs = db.prepare('SELECT ts FROM messages WHERE ts IS NOT NULL').all().map((r) => r.ts);
  const scannedAt = getMeta(db, 'scanned_at');
  const indexedRoot = getMeta(db, 'root');
  const dbSize = fs.existsSync(dbPath(out)) ? fs.statSync(dbPath(out)).size : 0;
  db.close();

  const byId = new Map(sessions.map((s) => [s.id, s]));
  const lin = new Map(lineageRows.map((r) => [r.session_id, r]));

  const totalBytes = sessions.reduce((a, s) => a + s.size, 0);
  const categories = Object.fromEntries(BYTE_CATEGORIES.map((k) => [k, 0]));
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let msgs = 0, userMsgs = 0, asstMsgs = 0, sidechainMsgs = 0, badLines = 0;
  let firstTs = null, lastTs = null;
  for (const s of sessions) {
    for (const k of BYTE_CATEGORIES) categories[k] += s.bytesBy[k] || 0;
    for (const k of Object.keys(tokens)) tokens[k] += s.tokens?.[k] || 0;
    msgs += s.msgs; userMsgs += s.user_msgs; asstMsgs += s.asst_msgs;
    sidechainMsgs += s.sidechain_msgs; badLines += s.bad_lines;
    if (s.first_ts && (!firstTs || s.first_ts < firstTs)) firstTs = s.first_ts;
    if (s.last_ts && (!lastTs || s.last_ts > lastTs)) lastTs = s.last_ts;
  }
  const accounted = Object.values(categories).reduce((a, b) => a + b, 0);

  // 分岔群組
  const groupMap = new Map();
  for (const r of lineageRows) {
    if (r.role === 'solo') continue;
    const g = groupMap.get(r.group_id) || [];
    g.push(r); groupMap.set(r.group_id, g);
  }
  const groups = [...groupMap.entries()].map(([id, members]) => {
    members.sort((a, b) => a.redundant_bytes - b.redundant_bytes || b.unique_msgs - a.unique_msgs);
    return {
      id,
      title: members.map((m) => byId.get(m.session_id)?.title).find(Boolean) || '未命名',
      members: members.map((m) => {
        const s = byId.get(m.session_id) || {};
        return {
          id: m.session_id, role: m.role, title: s.title || '', size: s.size || 0,
          lastTs: s.last_ts || null, uniqueMsgs: m.unique_msgs, sharedMsgs: m.shared_msgs,
          redundantBytes: m.redundant_bytes,
        };
      }),
      bytes: members.reduce((a, m) => a + (byId.get(m.session_id)?.size || 0), 0),
      redundantBytes: members.reduce((a, m) => a + m.redundant_bytes, 0),
    };
  }).sort((a, b) => b.redundantBytes - a.redundantBytes);

  const roles = { solo: 0, fork: 0, primary: 0, subsumed: 0 };
  for (const r of lineageRows) roles[r.role] = (roles[r.role] || 0) + 1;
  const redundantBytes = lineageRows.reduce((a, r) => a + r.redundant_bytes, 0);

  // 專案
  const pm = new Map();
  for (const s of sessions) {
    let r = pm.get(s.project);
    if (!r) r = { name: s.project, label: shortProject(s.project), cwd: s.cwd, sessions: 0, msgs: 0, bytes: 0, lastTs: null, exists: s.cwd ? fs.existsSync(s.cwd) : false };
    r.sessions++; r.msgs += s.msgs; r.bytes += s.size;
    if (s.last_ts && (!r.lastTs || s.last_ts > r.lastTs)) r.lastTs = s.last_ts;
    pm.set(s.project, r);
  }
  const projects = [...pm.values()].sort((a, b) => b.bytes - a.bytes);

  // 工具與模型
  const tm = new Map(), mm = new Map();
  for (const s of sessions) {
    for (const [k, v] of Object.entries(s.tools || {})) tm.set(k, (tm.get(k) || 0) + v);
    for (const [k, v] of Object.entries(s.models || {})) mm.set(k, (mm.get(k) || 0) + v);
  }
  const tools = [...tm].map(([name, calls]) => ({ name, calls })).sort((a, b) => b.calls - a.calls);
  const models = [...mm].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n);

  // 時間分布
  const days = new Map(), months = new Map();
  const hours = new Array(24).fill(0), weekdays = new Array(7).fill(0);
  for (const ts of msgTs) {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) continue;
    const dk = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    days.set(dk, (days.get(dk) || 0) + 1);
    months.set(dk.slice(0, 7), (months.get(dk.slice(0, 7)) || 0) + 1);
    hours[d.getHours()]++;
    weekdays[d.getDay()]++;
  }

  const sidecarBytes = sidecars.reduce((a, r) => a + r.bytes, 0);
  const orphans = sidecars.filter((r) => !r.has_session);

  return {
    generatedAt: new Date().toISOString(),
    root: indexedRoot || root,
    dbSize,
    scannedAt,
    totals: {
      sessions: sessions.length, msgs, userMsgs, asstMsgs, sidechainMsgs, badLines,
      bytes: totalBytes, accounted, firstTs, lastTs, tokens,
      sidecarDirs: sidecars.length, sidecarBytes,
      orphanDirs: orphans.length, orphanBytes: orphans.reduce((a, r) => a + r.bytes, 0),
      activeDays: days.size,
    },
    categories: BYTE_CATEGORIES.map((k) => ({ key: k, label: CATEGORY_LABELS[k] || k, bytes: categories[k] }))
      .filter((r) => r.bytes > 0).sort((a, b) => b.bytes - a.bytes),
    lineage: { roles, groups, redundantBytes },
    projects,
    tools: tools.slice(0, 20),
    models,
    time: {
      months: [...months].sort().map(([k, v]) => ({ k, v })),
      hours: hours.map((v, i) => ({ k: `${pad(i)}`, v })),
      weekdays: weekdays.map((v, i) => ({ k: ['日', '一', '二', '三', '四', '五', '六'][i], v })),
      busiest: [...days].sort((a, b) => b[1] - a[1])[0] || null,
    },
    sessions: sessions.map((s) => ({
      id: s.id, title: s.title || '', project: shortProject(s.project), cwd: s.cwd,
      firstTs: s.first_ts, lastTs: s.last_ts, size: s.size, msgs: s.msgs,
      userMsgs: s.user_msgs, badLines: s.bad_lines,
      role: lin.get(s.id)?.role || 'solo',
      redundantBytes: lin.get(s.id)?.redundant_bytes || 0,
      topCategory: topCat(s.bytesBy),
    })),
  };
}

function topCat(bytesBy) {
  let top = null, v = -1;
  for (const k of BYTE_CATEGORIES) {
    const n = bytesBy[k] || 0;
    if (n > v) { v = n; top = k; }
  }
  return { key: top, label: CATEGORY_LABELS[top] || top, bytes: v };
}

function pad(n) { return String(n).padStart(2, '0'); }
function safeJson(s, d) { try { return JSON.parse(s); } catch { return d; } }
