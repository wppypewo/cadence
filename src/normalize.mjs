// 把 Claude Code 的原始存檔記錄正規化成統一的訊息模型，並做位元組歸因。
import crypto from 'node:crypto';

/** 位元組歸因的類別。順序即報表顯示順序。 */
export const BYTE_CATEGORIES = [
  'text',            // 真正的對話文字（人看得到的內容）
  'thinking',        // 思考內容本文
  'signature',       // 思考區塊的加密簽章，純機器用，占比常被低估
  'tool_use',        // 工具呼叫參數
  'tool_result',     // 工具結果區塊
  'tool_result_dup', // toolUseResult 欄位：與 tool_result 區塊重複的第二份
  'image',           // 內嵌影像的 base64
  'attachment',      // attachment 型別的行（含 deferred_tools_delta 之類的清單）
  'usage',           // token 計量遙測（含 iterations 明細）
  'ids',             // uuid、requestId 等識別碼
  'context',         // cwd、version、entrypoint 等每行重複的環境欄位
  'envelope',        // JSON 結構本身：鍵名、括號、逗號
];

/** 各類別的人類說明，報表與 CLI 共用。 */
export const CATEGORY_LABELS = {
  text: '對話文字',
  thinking: '思考內容',
  signature: '思考簽章',
  tool_use: '工具呼叫',
  tool_result: '工具結果',
  tool_result_dup: '工具結果副本',
  image: '影像',
  attachment: '附加清單',
  usage: 'token 計量',
  ids: '識別碼',
  context: '環境欄位',
  envelope: 'JSON 結構',
};

/** 頂層欄位 → 類別。未列出的欄位歸入 context。 */
const FIELD_CATEGORY = {
  uuid: 'ids', parentUuid: 'ids', sessionId: 'ids', requestId: 'ids', promptId: 'ids',
  leafUuid: 'ids', sourceToolAssistantUUID: 'ids', sourceToolUseID: 'ids', toolUseID: 'ids',
  logicalParentUuid: 'ids',
  attachment: 'attachment',
  toolUseResult: 'tool_result_dup',
};

const EMPTY_BYTES = () => Object.fromEntries(BYTE_CATEGORIES.map((c) => [c, 0]));

/** 把 message.content 攤平成純文字，供全文檢索與匯出使用。 */
export function contentToText(content, { includeThinking = false } = {}) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    switch (b.type) {
      case 'text': if (b.text) parts.push(b.text); break;
      case 'thinking': if (includeThinking && b.thinking) parts.push(b.thinking); break;
      case 'tool_use': parts.push(`[工具呼叫 ${b.name}]`); break;
      case 'tool_result': parts.push(toolResultText(b.content)); break;
      case 'image': parts.push('[影像]'); break;
      default: break;
    }
  }
  return parts.filter(Boolean).join('\n');
}

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b?.type === 'text' ? b.text : b?.type === 'image' ? '[影像]' : '')).filter(Boolean).join('\n');
}

/** 估算 JSON 序列化後的位元組數。用於歸因，不要求與原始行完全一致。 */
function jsonBytes(v) {
  if (v === undefined) return 0;
  try { return Buffer.byteLength(JSON.stringify(v), 'utf8'); } catch { return 0; }
}

/**
 * 對單行做位元組歸因。先逐欄位歸類，再把 message.content 拆進內容類別，
 * 剩下的差額（鍵名、括號、逗號）算進 envelope，確保加總等於該行實際位元組數。
 */
export function attributeBytes(rec) {
  const b = EMPTY_BYTES();
  const o = rec.value;
  if (!rec.ok || !o) { b.envelope = rec.bytes; return b; }

  for (const [k, v] of Object.entries(o)) {
    if (k === 'message') continue;
    b[FIELD_CATEGORY[k] || 'context'] += jsonBytes(v);
  }
  const msg = o.message;
  if (msg && typeof msg === 'object') {
    for (const [k, v] of Object.entries(msg)) {
      if (k === 'content') continue;
      b[k === 'usage' ? 'usage' : k === 'id' ? 'ids' : 'context'] += jsonBytes(v);
    }
    attributeContent(msg.content, b);
  }

  const accounted = BYTE_CATEGORIES.reduce((s, k) => s + b[k], 0);
  b.envelope += Math.max(0, rec.bytes - accounted);
  return b;
}

function attributeContent(content, b) {
  if (typeof content === 'string') { b.text += jsonBytes(content); return; }
  if (!Array.isArray(content)) { b.envelope += jsonBytes(content); return; }
  for (const blk of content) {
    if (!blk || typeof blk !== 'object') { b.envelope += jsonBytes(blk); continue; }
    switch (blk.type) {
      case 'text': b.text += jsonBytes(blk.text); break;
      case 'thinking':
        b.thinking += jsonBytes(blk.thinking);
        b.signature += jsonBytes(blk.signature);
        break;
      case 'redacted_thinking': b.signature += jsonBytes(blk.data); break;
      case 'tool_use': b.tool_use += jsonBytes(blk.input) + jsonBytes(blk.name); break;
      case 'tool_result': {
        const { imageBytes, restBytes } = splitImages(blk.content);
        b.image += imageBytes;
        b.tool_result += restBytes;
        break;
      }
      case 'image': b.image += jsonBytes(blk.source); break;
      default: b.envelope += jsonBytes(blk); break;
    }
  }
}

function splitImages(content) {
  let imageBytes = 0, restBytes = 0;
  if (typeof content === 'string') return { imageBytes: 0, restBytes: Buffer.byteLength(content, 'utf8') };
  if (!Array.isArray(content)) return { imageBytes: 0, restBytes: jsonBytes(content) };
  for (const b of content) {
    if (b?.type === 'image') imageBytes += jsonBytes(b.source);
    else restBytes += jsonBytes(b);
  }
  return { imageBytes, restBytes };
}

/** 正規化一則對話訊息（type 為 user / assistant）。非對話行回傳 null。 */
export function normalizeMessage(rec, seq) {
  const o = rec.value;
  if (!rec.ok || !o) return null;
  if (o.type !== 'user' && o.type !== 'assistant') return null;
  const msg = o.message || {};
  const content = msg.content;
  const text = contentToText(content);
  const toolNames = [];
  if (Array.isArray(content)) {
    for (const b of content) if (b?.type === 'tool_use' && b.name) toolNames.push(b.name);
  }
  const isMeta = Boolean(o.isMeta) || isSystemNoise(text);
  return {
    uuid: o.uuid || null,
    parentUuid: o.parentUuid ?? null,
    seq,
    role: o.type,
    ts: o.timestamp || null,
    model: msg.model || null,
    isSidechain: Boolean(o.isSidechain),
    isMeta,
    isCompactSummary: Boolean(o.isCompactSummary),
    text,
    textLen: text.length,
    toolNames,
    bytes: rec.bytes,
    usage: msg.usage ? pickUsage(msg.usage) : null,
    hash: text ? crypto.createHash('sha1').update(text).digest('hex').slice(0, 16) : null,
  };
}

const SYSTEM_NOISE = [
  '<system-reminder>',
  'Caveat: The messages below were generated',
  '[Request interrupted',
];
function isSystemNoise(text) {
  if (!text) return false;
  const head = text.slice(0, 200);
  return SYSTEM_NOISE.some((p) => head.includes(p));
}

function pickUsage(u) {
  return {
    input: u.input_tokens || 0,
    output: u.output_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
    cacheWrite: u.cache_creation_input_tokens || 0,
    thinking: u.output_tokens_details?.thinking_tokens || 0,
  };
}

/** 抽出 session 層級的中繼資料行（標題、模式、PR 連結等）。 */
export function sessionMeta(o) {
  switch (o?.type) {
    case 'custom-title': return { title: o.customTitle, titleSource: 'custom' };
    case 'ai-title': return { title: o.aiTitle, titleSource: 'ai' };
    case 'summary': return { title: o.summary, titleSource: 'summary' };
    default: return null;
  }
}
