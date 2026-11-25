/**
 * 兩個用 Gemini 的功能：PE 草稿批改與 7 天學習回顧。
 *
 * 結果都不存資料庫（2026-11-25 使用者決定）：按一次算一次、只回給畫面。
 * 所以這裡不碰任何只增不改的事件表，也不需要 migration。
 * 雲端版只接受 CADENCE_OWNER_EMAIL 一個帳號登入，費用不會被別人刷，因此沒有另做次數上限。
 */

import { CloudError } from './supabase.mjs';
import { generateJson } from './gemini.mjs';
import { cloudStats } from './analytics.mjs';
import { weekly } from './learning.mjs';

// ── PE 批改 ────────────────────────────────────────────────────────────

// 評分格照 study/delf-b1-production-ecrite.md 第二節（FEI 2022-09 起用的現行格）。
export const PE_CRITERIA = [
  'Réalisation de la tâche',
  'Cohérence et cohésion',
  'Adéquation sociolinguistique',
  'Lexique',
  'Morphosyntaxe',
];
const LEVELS = ['未作答／產出不足', '未達 B1', 'B1', 'B1+'];
const POINTS = { '未作答／產出不足': 0, '未達 B1': 1, B1: 3, 'B1+': 5 };
// 79 字以下是 Manque de matière évaluable，全部 0 分（同一份文件第三節）。
const MIN_EVALUABLE = 80;
const MAX_TEXT = 20_000;
const MAX_TASK = 2_000;

const PE_SYSTEM = `你是 DELF B1 tout public 的寫作閱卷官（correcteur），照 FEI 自 2022-09 起使用的現行評分格逐項判定。
講評一律用繁體中文（台灣用語），引用考生原文時保留法文與重音。

評分項只有五項，等級只能是「未作答／產出不足」「未達 B1」「B1」「B1+」四者之一：
- Réalisation de la tâche：能寫出一篇連貫、不複雜、大致滿足題目要求的文章；能表達意見並用幾個例子佐證。
- Cohérence et cohésion：文章連貫、連接詞恰當；版面配置與標點多半得當。
- Adéquation sociolinguistique：用最常見的表達與言語行為，語域大致合乎情境與收件人。
- Lexique：日常主題的常用詞彙夠廣且用得正確；表達較複雜的想法時仍可能有掌握不足與拼字錯誤。
- Morphosyntaxe：掌握簡單的句法結構與語法形式，常見的複雜結構用得相對正確。
以上描述的是「B1」那一格；明顯超出才給 B1+，明顯不足給「未達 B1」。

異常檢查只判這三項（字數與空白卷由程式處理，不用你判）：
- thematique：主題離題。
- discursif：文體不對，例如題目要回信卻寫成論說文、缺稱呼或署名。
- complet：主題與文體都不對。
沒有提供題目時，三項都不要勾，並在 summary 說明無法判斷是否離題。

規則：
- 每一項的 reason 用一句話說明為什麼是這一級，quote 必須逐字引用考生文章裡的字句。
- fixes 只挑最多三個真的會影響評分的地方，不挑無傷大雅的筆誤；original 逐字引用原文。
- vocabulary 列 5–8 個這次明顯缺、但這個話題一定會用到的字或搭配，附中文。
- 不要因為是練習就放寬標準。不要重寫全文，也不要給範文。
- 寫法平實具體，不用「強大、全面、值得注意的是」這類空話。`;

const PE_SCHEMA = {
  type: 'object',
  properties: {
    anomalies: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['thematique', 'discursif', 'complet'] },
          reason: { type: 'string' },
        },
        required: ['type', 'reason'],
      },
    },
    criteria: {
      type: 'array',
      minItems: 5,
      maxItems: 5,
      items: {
        type: 'object',
        properties: {
          criterion: { type: 'string', enum: PE_CRITERIA },
          level: { type: 'string', enum: LEVELS },
          quote: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['criterion', 'level', 'quote', 'reason'],
      },
    },
    fixes: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        properties: {
          original: { type: 'string' },
          corrected: { type: 'string' },
          why: { type: 'string' },
        },
        required: ['original', 'corrected', 'why'],
      },
    },
    vocabulary: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        properties: { fr: { type: 'string' }, zh: { type: 'string' } },
        required: ['fr', 'zh'],
      },
    },
    summary: { type: 'string' },
  },
  required: ['anomalies', 'criteria', 'fixes', 'vocabulary', 'summary'],
};

/** 跟前端 web/js/practice.mjs 的 countWords 同一套：空白分詞，含字母或數字的才算。 */
export function countWords(text) {
  return String(text).trim().split(/\s+/u).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

export async function peFeedback(env, body, fetchImpl = fetch) {
  const text = String(body?.text ?? '').trim();
  const task = String(body?.task ?? '').trim();
  if (text.length > MAX_TEXT) throw new CloudError(400, `草稿超過 ${MAX_TEXT} 字元`);
  if (task.length > MAX_TASK) throw new CloudError(400, `題目超過 ${MAX_TASK} 字元`);
  const words = countWords(text);

  // 空白卷與字數不足是機械判定，結果固定全部 0 分，不必花一次 API 呼叫。
  if (words === 0) return zeroResult(words, 'copie-blanche', '空白卷（Copie blanche）：全部 0 分。');
  if (words < MIN_EVALUABLE) {
    return zeroResult(words, 'matiere', `只有 ${words} 字，不到要求的一半（79 字以下）：Manque de matière évaluable，全部 0 分。`);
  }

  const prompt = [
    task ? `【題目】\n${task}` : '【題目】（考生沒有提供）',
    `【考生文章】（程式計算：${words} 字，要求 160 字）\n${text}`,
  ].join('\n\n');
  const { value, model } = await generateJson({ env, system: PE_SYSTEM, prompt, schema: PE_SCHEMA, thinking: 'medium', fetchImpl });
  return { ...gradePe(value, words), model };
}

function zeroResult(words, rule, summary) {
  return {
    words,
    rule,
    anomalies: [],
    criteria: PE_CRITERIA.map((criterion) => ({
      criterion, level: '未作答／產出不足', points: 0, capped: false, quote: '', reason: '',
    })),
    total: 0,
    fixes: [],
    vocabulary: [],
    summary,
    model: null,
  };
}

/**
 * 把模型的判級整理成分數。分數與異常封頂由這裡算，不讓模型自己加總：
 * 加法與封頂規則是固定的，交給模型只會多一個出錯的地方。
 */
export function gradePe(raw, words) {
  const anomalies = Array.isArray(raw?.anomalies)
    ? raw.anomalies.filter((a) => ['thematique', 'discursif', 'complet'].includes(a?.type))
      .map((a) => ({ type: a.type, reason: String(a.reason ?? '') }))
    : [];
  const flags = new Set(anomalies.map((a) => a.type));
  const byName = new Map((Array.isArray(raw?.criteria) ? raw.criteria : [])
    .filter((c) => PE_CRITERIA.includes(c?.criterion))
    .map((c) => [c.criterion, c]));

  const criteria = PE_CRITERIA.map((criterion, index) => {
    const item = byName.get(criterion);
    if (!item || !LEVELS.includes(item.level)) {
      // 模型漏掉某一項時不替它猜等級，留空並讓總分標成不完整。
      return { criterion, level: null, points: null, capped: false, quote: '', reason: '模型沒有判這一項' };
    }
    const original = POINTS[item.level];
    const cap = capFor(flags, index);
    const points = Math.min(original, cap);
    return {
      criterion,
      level: points === original ? item.level : levelOf(points),
      points,
      capped: points < original,
      quote: String(item.quote ?? ''),
      reason: String(item.reason ?? ''),
    };
  });

  const complete = criteria.every((c) => c.points !== null);
  return {
    words,
    rule: null,
    anomalies,
    criteria,
    total: complete ? criteria.reduce((sum, c) => sum + c.points, 0) : null,
    fixes: (Array.isArray(raw?.fixes) ? raw.fixes : []).slice(0, 3).map((f) => ({
      original: String(f?.original ?? ''), corrected: String(f?.corrected ?? ''), why: String(f?.why ?? ''),
    })),
    vocabulary: (Array.isArray(raw?.vocabulary) ? raw.vocabulary : []).slice(0, 8).map((v) => ({
      fr: String(v?.fr ?? ''), zh: String(v?.zh ?? ''),
    })),
    summary: String(raw?.summary ?? ''),
  };
}

// 封頂規則照 study/delf-b1-production-ecrite.md 第三節的表。
// index 對應 PE_CRITERIA：0 Réalisation、1 Cohérence、2 Adéquation、3 Lexique、4 Morphosyntaxe。
function capFor(flags, index) {
  if (flags.has('complet')) return index <= 2 ? 0 : 3;
  let cap = 5;
  if (flags.has('thematique') && (index === 0 || index === 3)) cap = Math.min(cap, 3);
  if (flags.has('discursif') && (index === 0 || index === 1)) cap = Math.min(cap, 1);
  return cap;
}

function levelOf(points) {
  return Object.keys(POINTS).find((level) => POINTS[level] === points);
}

// ── 7 天學習回顧 ───────────────────────────────────────────────────────

const WEEKLY_SYSTEM = `你是一位法文學習教練，替一位準備 DELF B1 的台灣學習者寫 7 天學習回顧。
只能根據提供的 JSON 數據寫，不得推測或捏造數據裡沒有的數字、單字或事件；數據不足就直說。
用繁體中文（台灣用語），法文單字保留重音。寫法平實具體：用數字與實際的字當例子，
不用「強大、全面、值得注意的是」這類空話，也不用「不僅…更…」這種句型。
headline 一句話總結這 7 天。highlights 與 concerns 各寫 1–3 條，每條一句，帶數字。
nextSteps 寫 1–3 條下週可以直接照做的事，要具體到哪一類卡或哪一科。`;

const WEEKLY_SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string' },
    highlights: { type: 'array', maxItems: 3, items: { type: 'string' } },
    concerns: { type: 'array', maxItems: 3, items: { type: 'string' } },
    nextSteps: { type: 'array', maxItems: 3, items: { type: 'string' } },
  },
  required: ['headline', 'highlights', 'concerns', 'nextSteps'],
};

export async function weeklyBrief(config, auth, env, fetchImpl = fetch) {
  // 先確認 key 有設，沒設就不必去讀一整份統計。
  if (!String(env?.GEMINI_API_KEY ?? '').trim()) throw new CloudError(503, '還沒設定 GEMINI_API_KEY，AI 功能停用中');
  const [stats, matured] = await Promise.all([
    cloudStats(config, auth, { days: 7, weakest: 10, upcoming: 7 }, fetchImpl),
    weekly(config, auth, fetchImpl),
  ]);
  const digest = weeklyDigest(stats, matured);
  const { value, model } = await generateJson({
    env, system: WEEKLY_SYSTEM, prompt: JSON.stringify(digest), schema: WEEKLY_SCHEMA, thinking: 'low', fetchImpl,
  });
  const list = (items) => (Array.isArray(items) ? items.slice(0, 3).map(String) : []);
  return {
    from: digest.period.from,
    to: digest.period.to,
    brief: {
      headline: String(value?.headline ?? ''),
      highlights: list(value?.highlights),
      concerns: list(value?.concerns),
      nextSteps: list(value?.nextSteps),
    },
    model,
  };
}

/**
 * 只把模型需要的數字挑出來。整份 stats 有上萬張卡的分類計數與 120 天的明細，
 * 原樣送出去既貴又會讓模型去引用跟這 7 天無關的數字。
 */
export function weeklyDigest(stats, matured) {
  const daily = stats.daily ?? [];
  const reviews = daily.reduce((sum, d) => sum + d.count, 0);
  const correct = daily.reduce((sum, d) => sum + d.correct, 0);
  return {
    period: { from: matured.from, to: matured.to, days: 7 },
    reviews: {
      total: reviews,
      correct,
      accuracy: reviews ? Math.round((correct / reviews) * 100) / 100 : null,
      activeDays: daily.length,
      daily: daily.map(({ day, count, correct: ok }) => ({ day, count, correct: ok })),
    },
    streakDays: stats.summary?.streakDays ?? null,
    cards: {
      seen: stats.summary?.seenCards ?? null,
      mature: stats.summary?.matureCards ?? null,
      dueNow: stats.summary?.dueNow ?? null,
      dueNext7Days: (stats.upcoming?.days ?? []).reduce((sum, d) => sum + d.count, 0),
      byKind: (stats.byKind ?? []).filter((k) => k.seen > 0)
        .map(({ kind, seen, mature, due }) => ({ kind, seen, mature, due })),
    },
    maturedThisWeek: {
      count: matured.items.length,
      examples: matured.items.slice(0, 15).map((item) => ({ word: item.label, kind: item.kind })),
    },
    errorReasons: (stats.errorProfile ?? []).slice(0, 8),
    weakest: (stats.weakest ?? []).slice(0, 10).map((w) => ({
      word: cardLabel(w.card), kind: w.card?.kind ?? null, lapses: w.lapses, lastReason: w.lastReason,
    })),
    practice: (stats.practice?.bySkill ?? []).filter((s) => s.attempts > 0).map(({ skill, attempts, minutes, average }) => ({
      skill, attempts, minutes, averageScore: average === null ? null : Math.round(average * 100) / 100,
    })),
    // 練習筆記是自己寫的「哪裡卡住」，最能說明數字背後的原因；截短避免整篇作文被送出去。
    practiceNotes: (stats.practice?.recent ?? []).filter((r) => r.notes)
      .slice(0, 5).map((r) => ({ skill: r.skill, day: r.day, notes: String(r.notes).slice(0, 200) })),
  };
}

// 跟 learning.mjs 的 maturedItem 取標籤的順序一致，兩邊顯示同一張卡才會是同一個字。
function cardLabel(card) {
  if (!card) return null;
  const front = card.front ?? {};
  return front.word ?? front.connector ?? front.base ?? card.answer ?? card.id ?? null;
}
