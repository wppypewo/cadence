/**
 * API 層。純函式，不碰 HTTP，方便測試。
 * server.mjs 只負責把請求解析成參數、把回傳值變成 JSON。
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { grade } from './engine/grade.mjs';
import { simulate, solveDailyNew, ratingDistribution } from './engine/forecast.mjs';
import { localDay } from './db.mjs';

const KINDS = ['vocab-recall', 'vocab-produce', 'conj', 'connector'];
const LEVELS = ['A1', 'A2', 'B1'];

export class Api {
  constructor(store) {
    this.store = store;
    this.verbCache = null;
  }

  /** 把 query string 的 kinds/levels 轉成通過白名單的陣列。 */
  static scope(query) {
    const pick = (raw, allowed) => {
      if (!raw) return [];
      const list = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
      const bad = list.filter((s) => !allowed.includes(s));
      if (bad.length) throw new HttpError(400, `不認得的參數：${bad.join(', ')}`);
      return list;
    };
    return { kinds: pick(query.kinds, KINDS), levels: pick(query.levels, LEVELS) };
  }

  summary() {
    const s = this.store.summary();
    return {
      ...s,
      byKind: this.store.byKind(),
      settings: {
        desiredRetention: this.store.desiredRetention,
        dailyNewLimit: this.store.dailyNewLimit,
        examDate: this.store.get('examDate', null),
      },
      meta: this.store.get('bankMeta', null),
    };
  }

  queue(query = {}) {
    const scope = Api.scope(query);
    const limit = clampInt(query.limit, 1, 200, 20);
    const cards = this.store.queue({ ...scope, limit });
    return {
      cards: cards.map((c) => stripAnswer(c)),
      remaining: {
        due: this.store.dueCount(scope),
        new: this.store.newCount(scope),
      },
      newToday: this.store.newIntroducedToday(),
      newLimit: this.store.dailyNewLimit,
    };
  }

  /**
   * 批改並記錄。評分規則：
   *   打字題　答對 → Good；只差重音或大小寫 → Hard（算對，但排程要收緊）；答錯 → Again
   *   自評題　由前端直接給 1..4
   * 這樣切的理由：重音錯不是「不會這個字」，但也絕對不是「記得很牢」。
   */
  review(body = {}) {
    if (!body.cardId) throw new HttpError(400, '缺少 cardId');
    const card = this.store.card(body.cardId);
    if (!card) throw new HttpError(404, `找不到卡片 ${body.cardId}`);

    let rating = body.rating;
    let result = null;
    if (card.mode === 'typed' || card.mode === 'choice') {
      const accepted = card.accept ?? [card.answer];
      result = grade(body.answer ?? '', accepted);
      rating = result.correct
        ? (result.reason === 'exact' ? 3 : 2)
        : 1;
    }
    if (!Number.isInteger(rating) || rating < 1 || rating > 4) {
      throw new HttpError(400, 'rating 必須是 1..4 的整數');
    }

    const state = this.store.review({
      cardId: body.cardId,
      rating,
      answered: body.answer ?? null,
      correct: result ? result.correct : rating > 1,
      reason: result ? result.reason : null,
      ms: Number.isFinite(body.ms) ? Math.round(body.ms) : null,
    });

    return {
      rating,
      grade: result,
      answer: card.answer ?? null,
      accept: card.accept ?? null,
      note: card.note ?? null,
      state: {
        stability: state.stability,
        difficulty: state.difficulty,
        due: state.due,
        reps: state.reps,
        lapses: state.lapses,
        intervalDays: Math.round((new Date(state.due) - new Date(state.last_review)) / 86_400_000),
      },
    };
  }

  stats(query = {}) {
    const scope = Api.scope(query);
    return {
      scope,
      summary: this.store.summary(scope),
      byKind: this.store.byKind(scope),
      daily: this.store.daily(clampInt(query.days, 7, 365, 120), scope),
      upcoming: this.store.upcoming(clampInt(query.upcoming, 7, 180, 30), scope),
      weakest: this.store.weakest(clampInt(query.weakest, 1, 100, 24), scope).map((w) => ({
        ...w,
        card: stripAnswer(w.card, true),
      })),
      errorProfile: this.store.errorProfile(scope),
      // 紀錄檔是整份 JSONL，不隨 scope 變——它量的是磁碟，不是題庫子集。
      journal: this.store.journalInfo(),
    };
  }

  /**
   * 考前推演。exam 必填，其餘有預設值。
   * 評分分布優先用使用者自己的歷史，作答秒數也是——推演的每個係數
   * 都盡量來自實測，而不是我編一個看起來合理的數字。
   */
  forecast(query = {}) {
    const exam = query.exam ? new Date(`${query.exam}T00:00:00`) : null;
    if (!exam || Number.isNaN(exam.getTime())) throw new HttpError(400, 'exam 需要 YYYY-MM-DD 格式的日期');
    const today = new Date();
    if (exam < new Date(`${localDay(today)}T00:00:00`)) throw new HttpError(400, '考試日期已經過了');

    const scope = Api.scope(query);
    const cards = this.scopedStates(scope);
    const rows = this.store.db.prepare('SELECT rating FROM reviews WHERE correct = 1').all();
    const ratings = ratingDistribution(rows);
    const secondsPerCard = this.medianSeconds();

    const base = {
      cards,
      from: today,
      examDate: exam,
      dailyLimit: clampInt(query.limit, 5, 500, 60),
      desiredRetention: this.store.desiredRetention,
      ratings,
      secondsPerCard,
    };

    const plan = simulate({ ...base, dailyNew: clampInt(query.new, 0, 200, this.store.dailyNewLimit) });
    const solved = query.target
      ? solveDailyNew({ ...base, target: Number(query.target) })
      : null;

    return {
      plan,
      // recommended / ceiling 內層還掛著整份模擬結果（含 days 陣列），
      // 不剝掉的話一次回應會多出好幾百 KB，而前端一個欄位都用不到。
      solved: solved && {
        ...solved,
        recommended: dropResult(solved.recommended),
        ceiling: dropResult(solved.ceiling),
      },
      inputs: {
        ratingSample: ratings ? ratings.sample : 0,
        secondsPerCard,
        secondsSource: secondsPerCard === DEFAULT_SECONDS ? 'default' : 'observed',
        scope,
      },
    };
  }

  /** 範圍內每張卡的 FSRS 狀態。沒練過的卡沒有狀態，模擬時當新卡。 */
  scopedStates(scope) {
    const where = [];
    const params = [];
    if (scope.kinds?.length) {
      where.push(`c.kind IN (${scope.kinds.map(() => '?').join(',')})`);
      params.push(...scope.kinds);
    }
    if (scope.levels?.length) {
      where.push(`c.level IN (${scope.levels.map(() => '?').join(',')})`);
      params.push(...scope.levels);
    }
    const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    return this.store.db
      .prepare(
        `SELECT c.id, s.stability, s.difficulty, s.due
         FROM cards c LEFT JOIN states s ON s.card_id = c.id${clause}`,
      )
      .all(...params);
  }

  /** 作答時間中位數。用中位數而非平均，因為「開著視窗去吃飯」會把平均拉爛。 */
  medianSeconds() {
    const row = this.store.db
      .prepare(
        `SELECT ms FROM reviews WHERE ms IS NOT NULL AND ms BETWEEN 500 AND 120000
         ORDER BY ms LIMIT 1 OFFSET (
           SELECT COUNT(*) / 2 FROM reviews WHERE ms IS NOT NULL AND ms BETWEEN 500 AND 120000
         )`,
      )
      .get();
    const n = this.store.db
      .prepare('SELECT COUNT(*) n FROM reviews WHERE ms IS NOT NULL AND ms BETWEEN 500 AND 120000')
      .get().n;
    if (!row || n < 30) return DEFAULT_SECONDS;
    return Math.round((row.ms / 1000) * 10) / 10;
  }

  settings(body) {
    if (body) {
      if (body.desiredRetention !== undefined) {
        const r = Number(body.desiredRetention);
        if (!(r >= 0.7 && r <= 0.98)) throw new HttpError(400, '目標記憶率請落在 0.70–0.98');
        this.store.set('desiredRetention', r);
      }
      if (body.dailyNewLimit !== undefined) {
        this.store.set('dailyNewLimit', clampInt(body.dailyNewLimit, 0, 200, 15));
      }
      if (body.examDate !== undefined) {
        const v = body.examDate;
        if (v !== null && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new HttpError(400, '考試日期格式需為 YYYY-MM-DD');
        this.store.set('examDate', v);
      }
    }
    return {
      desiredRetention: this.store.desiredRetention,
      dailyNewLimit: this.store.dailyNewLimit,
      examDate: this.store.get('examDate', null),
    };
  }

  /** 動詞變位全表。1.1MB 的檔只在第一次被要求時載入。 */
  async verb(name) {
    if (!this.verbCache) {
      const file = path.join(this.store.bankDir, 'verbs.json');
      this.verbCache = JSON.parse(await readFile(file, 'utf8'));
    }
    const entry = this.verbCache[name];
    if (!entry) throw new HttpError(404, `題庫裡沒有動詞 ${name}`);
    return entry;
  }

  /** 找卡片。用於「這個字我想現在查一下」。 */
  search(query = {}) {
    const q = String(query.q ?? '').trim();
    if (q.length < 1) return { hits: [] };
    const like = `%${q}%`;
    const rows = this.store.db
      .prepare(
        `SELECT c.payload, s.stability, s.due, s.lapses
         FROM cards c LEFT JOIN states s ON s.card_id = c.id
         WHERE c.answer LIKE ? OR c.tags LIKE ? OR c.id LIKE ?
         ORDER BY c.freq DESC LIMIT 40`,
      )
      .all(like, like, like);
    return {
      hits: rows.map((r) => ({
        card: JSON.parse(r.payload),
        state: r.stability == null ? null : { stability: r.stability, due: r.due, lapses: r.lapses },
      })),
    };
  }
}

const DEFAULT_SECONDS = 8;

/** 去掉候選方案裡的完整模擬結果，只留摘要欄位。 */
function dropResult(entry) {
  if (!entry) return entry;
  const { result, ...rest } = entry;
  return rest;
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** 出題時把答案拿掉，免得在 devtools 的 network 面板就看到解答。 */
function stripAnswer(card, keepAnswer = false) {
  const { answer, accept, note, ...rest } = card;
  return keepAnswer ? { ...rest, answer, note } : rest;
}

function clampInt(raw, min, max, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.round(n), min), max);
}
