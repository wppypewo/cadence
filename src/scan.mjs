// 掃描存檔根目錄，解析每個 session 檔，產出 session 與 message 記錄。
import fs from 'node:fs';
import path from 'node:path';
import { readJsonl } from './jsonl.mjs';
import { attributeBytes, normalizeMessage, sessionMeta, BYTE_CATEGORIES } from './normalize.mjs';
import { claudeRoot, decodeProjectDir } from './paths.mjs';

/** 這些目錄不是 session 資料，永遠不碰。 */
export const RESERVED_DIRS = new Set(['memory', 'scripts', 'shell-snapshots', 'todos']);

/** 列出所有專案目錄。 */
export function listProjects(root = claudeRoot()) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return []; }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => {
      const dir = path.join(root, e.name);
      const { cwd, exact } = decodeProjectDir(e.name);
      return { name: e.name, dir, cwd, exact };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** 列出某專案目錄下的 session 檔（含大小與 mtime，供增量掃描判斷）。 */
export function listSessionFiles(project) {
  let entries;
  try { entries = fs.readdirSync(project.dir, { withFileTypes: true }); }
  catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
    const file = path.join(project.dir, e.name);
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    out.push({
      id: e.name.replace(/\.jsonl$/, ''),
      file,
      projectName: project.name,
      projectCwd: project.cwd,
      size: st.size,
      mtime: Math.floor(st.mtimeMs),
    });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** 列出某專案目錄下的 sidecar 目錄（session 的工具結果快取）。 */
export function listSidecars(project) {
  let entries;
  try { entries = fs.readdirSync(project.dir, { withFileTypes: true }); }
  catch { return []; }
  return entries
    .filter((e) => e.isDirectory() && !RESERVED_DIRS.has(e.name))
    .map((e) => ({ id: e.name, dir: path.join(project.dir, e.name), projectName: project.name }));
}

/** 遞迴計算目錄大小與檔案數。 */
export function dirUsage(dir) {
  let bytes = 0, files = 0, newest = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      try {
        const st = fs.statSync(p);
        bytes += st.size; files++;
        if (st.mtimeMs > newest) newest = st.mtimeMs;
      } catch { /* 檔案在掃描中途消失，忽略 */ }
    }
  }
  return { bytes, files, newest: Math.floor(newest) };
}

/**
 * 解析單一 session 檔。回傳 { session, messages }。
 * messages 為正規化後的對話訊息陣列（含 sidechain）。
 */
export async function parseSession(entry) {
  const bytesBy = Object.fromEntries(BYTE_CATEGORIES.map((c) => [c, 0]));
  const tools = Object.create(null);
  const models = Object.create(null);
  const versions = new Set();
  const branches = new Set();
  const entrypoints = new Set();
  const messages = [];
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 };

  let lines = 0, badLines = 0, seq = 0;
  let firstTs = null, lastTs = null;
  let title = null, titleSource = null;
  let firstUserText = null;
  let cwd = entry.projectCwd;
  let sidechainMsgs = 0, compactSummaries = 0;

  for await (const rec of readJsonl(entry.file)) {
    lines++;
    if (!rec.ok) { badLines++; bytesBy.envelope += rec.bytes; continue; }
    const o = rec.value;
    const attr = attributeBytes(rec);
    for (const k of BYTE_CATEGORIES) bytesBy[k] += attr[k];

    if (o.timestamp) { firstTs ??= o.timestamp; lastTs = o.timestamp; }
    if (o.cwd) cwd = o.cwd;
    if (o.version) versions.add(o.version);
    if (o.gitBranch) branches.add(o.gitBranch);
    if (o.entrypoint) entrypoints.add(o.entrypoint);

    const meta = sessionMeta(o);
    if (meta?.title) { title = meta.title; titleSource = meta.titleSource; }

    const m = normalizeMessage(rec, seq);
    if (!m) continue;
    seq++;
    if (m.isSidechain) sidechainMsgs++;
    if (m.isCompactSummary) compactSummaries++;
    if (m.role === 'assistant' && m.model) models[m.model] = (models[m.model] || 0) + 1;
    for (const t of m.toolNames) tools[t] = (tools[t] || 0) + 1;
    if (m.usage) for (const k of Object.keys(tokens)) tokens[k] += m.usage[k] || 0;
    if (!firstUserText && m.role === 'user' && !m.isMeta && m.text) firstUserText = m.text;
    messages.push(m);
  }

  const userMsgs = messages.filter((m) => m.role === 'user' && !m.isMeta).length;
  const asstMsgs = messages.filter((m) => m.role === 'assistant').length;

  return {
    session: {
      id: entry.id,
      projectName: entry.projectName,
      projectCwd: cwd,
      file: entry.file,
      size: entry.size,
      mtime: entry.mtime,
      lines,
      badLines,
      msgs: messages.length,
      userMsgs,
      asstMsgs,
      sidechainMsgs,
      compactSummaries,
      firstTs,
      lastTs,
      title: title || derivedTitle(firstUserText),
      titleSource: title ? titleSource : (firstUserText ? 'first-prompt' : 'none'),
      firstUserText: firstUserText ? firstUserText.slice(0, 500) : null,
      bytesBy,
      tools,
      models,
      tokens,
      versions: [...versions],
      branches: [...branches],
      entrypoints: [...entrypoints],
    },
    messages,
  };
}

/** 從第一則使用者訊息生出可讀標題。 */
function derivedTitle(text) {
  if (!text) return null;
  const cleaned = text
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\[[^\]]*\]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  return cleaned.length > 70 ? `${cleaned.slice(0, 70)}…` : cleaned;
}
