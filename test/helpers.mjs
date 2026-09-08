// 測試用的假存檔產生器。所有測試都只在 os.tmpdir() 底下建檔，
// 不會碰到真的 ~/.claude。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let counter = 0;

export function tmpRoot(label = 'ccarchive') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  return dir;
}

export function uuid(n) {
  const s = String(n).padStart(12, '0');
  return `00000000-0000-4000-8000-${s}`;
}

/** 產生一則使用者訊息列。 */
export function userLine({ id, parent, text, ts, session, sidechain = false }) {
  return {
    type: 'user', uuid: id, parentUuid: parent ?? null, sessionId: session,
    timestamp: ts, isSidechain: sidechain, cwd: '/tmp/demo', version: '2.0.0',
    message: { role: 'user', content: [{ type: 'text', text }] },
  };
}

/** 產生一則助手訊息列，可帶思考與工具呼叫。 */
export function asstLine({ id, parent, text, ts, session, thinking, tool }) {
  const content = [];
  if (thinking) content.push({ type: 'thinking', thinking, signature: 'x'.repeat(64) });
  if (text) content.push({ type: 'text', text });
  if (tool) content.push({ type: 'tool_use', id: `toolu_${counter++}`, name: tool.name, input: tool.input || {} });
  return {
    type: 'assistant', uuid: id, parentUuid: parent ?? null, sessionId: session,
    timestamp: ts, cwd: '/tmp/demo', version: '2.0.0',
    message: {
      role: 'assistant', model: 'claude-opus-5', content,
      usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100 },
    },
  };
}

/**
 * 在 root 底下寫一個 session 檔。
 * @param {string} root  假的 projects 根目錄
 * @param {string} projectDir  編碼過的專案目錄名，例如 -tmp-demo
 * @param {string} sessionId
 * @param {Array<object>} records
 */
export function writeSession(root, projectDir, sessionId, records) {
  const dir = path.join(root, projectDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
  return file;
}

/** 產生一段線性對話，回傳記錄陣列（uuid 由 from 開始編號）。 */
export function conversation({ session, from = 0, turns = 3, prefix = '訊息' }) {
  const out = [];
  let parent = null;
  for (let i = 0; i < turns; i++) {
    const uId = uuid(from + i * 2);
    const aId = uuid(from + i * 2 + 1);
    const ts = new Date(Date.UTC(2026, 0, 1, 0, from + i)).toISOString();
    out.push(userLine({ id: uId, parent, text: `${prefix}：使用者第 ${i + 1} 句`, ts, session }));
    out.push(asstLine({ id: aId, parent: uId, text: `${prefix}：助手第 ${i + 1} 句`, ts, session }));
    parent = aId;
  }
  return out;
}

/** 建一個 sidecar 快取目錄。 */
export function writeSidecar(root, projectDir, id, files = 2, size = 512) {
  const dir = path.join(root, projectDir, id);
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < files; i++) {
    fs.writeFileSync(path.join(dir, `cache-${i}.json`), 'x'.repeat(size));
  }
  return dir;
}

export function rm(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}
