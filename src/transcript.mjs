// 從原始 jsonl 重建可讀的對話。索引不存全文，這裡直接讀檔以保留完整細節。
import { readJsonl } from './jsonl.mjs';

/**
 * @param {string} file  session 的 jsonl 路徑
 * @param {object} [opts]
 * @param {boolean} [opts.thinking]   保留思考內容
 * @param {boolean} [opts.tools]      保留工具呼叫與結果（預設 true）
 * @param {boolean} [opts.sidechain]  保留子代理訊息
 * @param {boolean} [opts.meta]       保留系統提醒等雜訊
 * @param {number}  [opts.toolChars]  單一工具結果最多保留幾個字元
 */
export async function readTranscript(file, opts = {}) {
  const {
    thinking = false, tools = true, sidechain = false, meta = false, toolChars = 2000,
  } = opts;
  const turns = [];
  const info = { title: null, cwd: null, versions: new Set(), first: null, last: null };

  for await (const rec of readJsonl(file)) {
    if (!rec.ok) continue;
    const o = rec.value;
    if (o.timestamp) { info.first ??= o.timestamp; info.last = o.timestamp; }
    if (o.cwd) info.cwd = o.cwd;
    if (o.version) info.versions.add(o.version);
    if (o.type === 'custom-title' && o.customTitle) info.title = o.customTitle;
    if (o.type === 'ai-title' && o.aiTitle && !info.title) info.title = o.aiTitle;

    if (o.type !== 'user' && o.type !== 'assistant') continue;
    if (o.isSidechain && !sidechain) continue;

    const blocks = [];
    const content = o.message?.content;
    if (typeof content === 'string') {
      if (content.trim()) blocks.push({ type: 'text', text: content });
    } else if (Array.isArray(content)) {
      for (const b of content) {
        if (!b || typeof b !== 'object') continue;
        switch (b.type) {
          case 'text':
            if (b.text?.trim()) blocks.push({ type: 'text', text: b.text });
            break;
          case 'thinking':
            if (thinking && b.thinking?.trim()) blocks.push({ type: 'thinking', text: b.thinking });
            break;
          case 'tool_use':
            if (tools) blocks.push({ type: 'tool_use', name: b.name, input: b.input });
            break;
          case 'tool_result':
            if (tools) {
              blocks.push({
                type: 'tool_result',
                isError: Boolean(b.is_error),
                text: clip(flattenResult(b.content), toolChars),
              });
            }
            break;
          case 'image':
            blocks.push({ type: 'image' });
            break;
          default:
            break;
        }
      }
    }
    if (blocks.length === 0) continue;

    const onlyNoise = blocks.every((b) => b.type === 'text' && isNoise(b.text));
    if (onlyNoise && !meta) continue;

    turns.push({
      uuid: o.uuid,
      role: o.type,
      ts: o.timestamp || null,
      model: o.message?.model || null,
      sidechain: Boolean(o.isSidechain),
      blocks: meta ? blocks : blocks.filter((b) => !(b.type === 'text' && isNoise(b.text))),
    });
  }
  return { turns, info: { ...info, versions: [...info.versions] } };
}

function flattenResult(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content === undefined ? '' : JSON.stringify(content);
  return content
    .map((b) => (b?.type === 'text' ? b.text : b?.type === 'image' ? '[影像]' : ''))
    .filter(Boolean)
    .join('\n');
}

function clip(s, max) {
  const str = String(s ?? '');
  if (max <= 0 || str.length <= max) return str;
  return `${str.slice(0, max)}\n…（截斷，原長 ${str.length} 字元）`;
}

const NOISE_PREFIXES = [
  '<system-reminder>',
  '<command-name>',
  '<local-command-stdout>',
  'Caveat: The messages below were generated',
  '[Request interrupted',
];

export function isNoise(text) {
  const t = String(text || '').trimStart();
  if (!t) return true;
  return NOISE_PREFIXES.some((p) => t.startsWith(p));
}
