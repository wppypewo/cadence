/**
 * Gemini API 的最小包裝。只用 Node 內建 fetch，維持零依賴；fetchImpl 可注入，
 * 測試不必真的打到 Google。
 *
 * 結構化輸出用 generationConfig.responseFormat.text：這是官方 REST 範例的寫法
 * （aistudio.google.com/docs/structured-output?generate-content=true，2026-11-25 讀）。
 * 同日實測 responseMimeType＋responseJsonSchema 也會過，但文件只列前者，跟著文件走。
 */

import { CloudError } from './supabase.mjs';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
// 3.8 Flash 是 2026-11 文件標 Stable 的 Flash 版本，支援結構化輸出與 thinkingLevel。
// 換模型只改環境變數，不必改程式。
const DEFAULT_MODEL = 'gemini-3.8-flash';
// Vercel 函式上限設 60 秒（api/router.mjs），這裡留 15 秒給登入、讀資料與回應。
const TIMEOUT_MS = 45_000;

export function geminiConfig(env = process.env) {
  const apiKey = String(env.GEMINI_API_KEY ?? '').trim();
  if (!apiKey) throw new CloudError(503, '還沒設定 GEMINI_API_KEY，AI 功能停用中');
  const model = String(env.GEMINI_MODEL ?? '').trim() || DEFAULT_MODEL;
  // 模型名會拼進網址路徑，先擋掉斜線與問號這類能改變路徑的字元。
  if (!/^[a-z0-9.-]+$/i.test(model)) throw new CloudError(503, 'GEMINI_MODEL 的格式不對');
  return { apiKey, model };
}

/**
 * 送一次 generateContent，要求照 schema 回 JSON，回傳解析後的物件。
 * thinking 是 3.8 Flash 支援的 low／medium／high；它不支援 minimal（文件的 thinking 表）。
 */
export async function generateJson({ env, system, prompt, schema, thinking = 'medium', maxOutputTokens = 8192, fetchImpl = fetch }) {
  const { data, candidate, model } = await callGemini({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      thinkingConfig: { thinkingLevel: thinking },
      maxOutputTokens,
      responseFormat: { text: { mimeType: 'APPLICATION_JSON', schema } },
    },
  }, env, fetchImpl);
  // MAX_TOKENS 代表 JSON 被截斷；SAFETY 等其他理由則可能整段是空的。兩種都不能拿去解析。
  if (candidate.finishReason !== 'STOP') throw incomplete(candidate, data);
  try {
    return { value: JSON.parse(answerText(candidate)), model: data.modelVersion ?? model, usage: data.usageMetadata ?? null };
  } catch {
    throw new CloudError(502, 'Gemini 回傳的 JSON 不完整');
  }
}

/**
 * 多輪對話，回純文字。contents 是 [{ role: 'user' | 'model', text, signature? }]，
 * 由呼叫端整理好、保證 user／model 交替且最後一則是 user。
 *
 * REST 是無狀態的，每一輪都要把整段歷史送回去。Gemini 3 系列的回應會帶 thoughtSignature，
 * 文件要求下一輪把它原樣放回同一個 part；純文字回應漏帶不會被拒，但推理品質可能變差
 * （ai.google.dev/gemini-api/docs/thought-signatures，2026-11-25 讀）。
 * 所以這裡把簽章回給前端，前端下一輪連同那則回覆一起送回來。
 */
export async function generateChat({ env, system, contents, thinking = 'low', maxOutputTokens = 8192, fetchImpl = fetch }) {
  const { data, candidate, model } = await callGemini({
    systemInstruction: { parts: [{ text: system }] },
    contents: contents.map(({ role, text, signature }) => ({
      role,
      parts: [signature ? { text, thoughtSignature: signature } : { text }],
    })),
    generationConfig: { thinkingConfig: { thinkingLevel: thinking }, maxOutputTokens },
  }, env, fetchImpl);
  const text = answerText(candidate).trim();
  // 對話被截斷還有前半段可讀，照樣回給畫面並標記；JSON 被截斷就整個不能用，兩者處理不同。
  const truncated = candidate.finishReason === 'MAX_TOKENS';
  if (!text || (candidate.finishReason !== 'STOP' && !truncated)) throw incomplete(candidate, data);
  // 簽章通常掛在最後一個 part；回覆拆成好幾段時取最後一個有簽章的。
  const signature = (candidate.content?.parts ?? []).filter((part) => typeof part.thoughtSignature === 'string')
    .map((part) => part.thoughtSignature).pop() ?? null;
  return { text, signature, truncated, model: data.modelVersion ?? model, usage: data.usageMetadata ?? null };
}

async function callGemini(body, env, fetchImpl) {
  const { apiKey, model } = geminiConfig(env);
  let res;
  try {
    res = await fetchImpl(`${ENDPOINT}/${model}:generateContent`, {
      method: 'POST',
      // key 放標頭不放網址：網址會進 Vercel 與 Google 兩邊的存取紀錄。
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new CloudError(504, 'Gemini 回應逾時，再按一次');
    }
    throw new CloudError(502, '連不上 Gemini');
  }

  // 只記狀態碼。回應內容可能夾著送出去的作文原文，不該進 Vercel 的紀錄。
  if (res.status === 429) throw new CloudError(429, 'Gemini 的呼叫次數或額度暫時用完，稍後再試');
  if (!res.ok) throw new CloudError(502, `Gemini 拒絕了這次請求（HTTP ${res.status}）`);

  let data;
  try {
    data = await res.json();
  } catch {
    throw new CloudError(502, 'Gemini 回了不是 JSON 的東西');
  }
  const candidate = data?.candidates?.[0];
  if (!candidate) throw incomplete(candidate, data);
  return { data, candidate, model };
}

// 開了 thinking 時 parts 可能夾帶 thought 摘要；只取正文。
function answerText(candidate) {
  return (candidate.content?.parts ?? [])
    .filter((part) => typeof part.text === 'string' && !part.thought)
    .map((part) => part.text).join('');
}

function incomplete(candidate, data) {
  return new CloudError(502, `Gemini 沒有完整回應（${candidate?.finishReason ?? data?.promptFeedback?.blockReason ?? '無候選'}）`);
}
