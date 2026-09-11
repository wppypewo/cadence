/**
 * API 層。純函式，不碰 HTTP，方便測試。
 * server.mjs 只負責把請求解析成參數、把回傳值變成 JSON。
 */

import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { grade, gradePick, gradeRewrite, gradeNom } from './engine/grade.mjs';
import { simulate, solveDailyNew, ratingDistribution } from './engine/forecast.mjs';
import { buildToday } from './engine/today.mjs';
import { localDay, CHECKIN_SKILLS, LEVELS } from './db.mjs';
import { AttemptLog } from './attempts.mjs';

const KINDS = ['vocab-recall', 'vocab-produce', 'conj', 'connector', 'pick', 'rw', 'nom'];

/**
 * 可以被 /api/doc 讀出去的檔案，白名單寫死。
 *
 * 這是唯一一支「把使用者給的字串變成檔名」的端點，所以不接受路徑、
 * 不接受副檔名，只接受下面那幾個代號。給 id 以外的東西一律 404，
 * 連 `..` 都沒有機會進到 path.join。
 */
/** 搜尋一次最多回傳幾「組」結果（變位卡以動詞為一組）。 */
const SEARCH_GROUPS = 40;
/** 為了湊滿那 40 組，最多從 SQL 撈幾張卡進來分組。 */
const SEARCH_SCAN = 800;

const DOCS = {
  co: { file: 'delf-b1-comprehension-orale.md', title: 'DELF B1 聽力' },
  pe: { file: 'delf-b1-production-ecrite.md', title: 'DELF B1 寫作' },
  po: { file: 'delf-b1-production-orale.md', title: 'DELF B1 口說' },
};

/** study/ 相對於本檔的位置。用 import.meta.url 而不是 dataDir，因為它不會被環境變數改掉。 */
const STUDY_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'study');

export class Api {
  constructor(store) {
    this.store = store;
    this.attempts = new AttemptLog(store.dataDir, store.db);
    this.verbCache = null;
    this.cardTokens = new Map();
    this.tokenCards = new Map();
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
        startLevel: this.store.startLevel,
      },
      meta: this.store.get('bankMeta', null),
    };
  }

  queue(query = {}) {
    const scope = Api.scope(query);
    const limit = clampInt(query.limit, 1, 200, 20);
    const preset = query.preset ? String(query.preset) : null;
    if (preset && preset !== 'weak') throw new HttpError(400, `不認得的練習模式：${preset}`);
    const cards = preset === 'weak'
      ? this.store.queueWeak(limit, scope)
      : this.store.queue({ ...scope, limit });
    return {
      cards: cards.map((c) => this.queueCard(c)),
      remaining: {
        due: this.store.dueCount(scope),
        new: this.store.newCount(scope),
      },
      newToday: this.store.newIntroducedToday(),
      newLimit: this.store.dailyNewLimit,
    };
  }

  /**
   * 看字回想的答案只在使用者翻面後送出。queue 若連中文釋義一起送，
   * 畫面藏得再好也能在 Network 面板先看到，這種自評就失去意義。
   */
  reveal(query = {}) {
    const cardId = this.resolveCard(String(query.id ?? ''));
    const card = this.store.card(cardId);
    if (!card) throw new HttpError(404, `找不到卡片 ${query.id ?? ''}`);
    if (card.kind !== 'vocab-recall' || card.mode !== 'self') {
      throw new HttpError(400, '只有看字回想題可以翻面');
    }
    const f = card.front ?? {};
    return {
      gloss: f.gloss ?? card.answer ?? null,
      en: f.en ?? null,
      glossSource: f.glossSource ?? null,
      // 四個評分各會排到幾天後，印在評分鍵上。只算不寫，不碰 reviews.jsonl。
      intervals: this.store.previewIntervals(cardId),
    };
  }

  /**
   * 批改並記錄。評分規則：
   *   打字題　完全一樣 → Good；只差大小寫 → Hard（算對，但排程收緊）；
   *   　　　　少了重音 → Again（算錯）；其他答錯 → Again
   *   自評題　由前端直接給 1..4
   *
   * **重音算數**，這是 grade.mjs 定下的立場：écrire 打成 ecrire 在考卷上不給分，
   * 這裡也不給。大小寫則放行——考卷上句首大寫不會扣分，但它代表記得不夠精確，
   * 所以降成 Hard 讓下次早一點再問。
   *
   * 方框挑連接詞（pick）走另一支批改：它要分辨省音錯、性數錯、選錯格。
   * 三種都算錯（考卷上也都不給分），分級只影響回饋文字與錯誤統計。
   *
   * 名詞化（nom）同理：冠詞算分，但「只錯冠詞」與「用錯名詞」分開報。
   *
   * 改寫題（rw）是唯一分兩趟的：整句沒有唯一解，只能自評，
   * 但自評必須看得到解答，解答又不能在作答前送到前端。
   *   第一趟 {cardId, answer}：要素有缺 → 當場記錯；要素齊全 → 回 phase:'self'
   *                            附解答與理由，**這一趟不寫進紀錄**。
   *   第二趟 {cardId, answer, rating}：帶著自評分數回來，這時才記。
   * 沒寫進紀錄就代表沒發生：中途關掉視窗不會留下半筆。
   */
  review(body = {}) {
    if (!body.cardId) throw new HttpError(400, '缺少 cardId');
    const cardId = this.resolveCard(String(body.cardId));
    const card = this.store.card(cardId);
    if (!card) throw new HttpError(404, `找不到卡片 ${body.cardId}`);

    const suppliedRating = Number.isInteger(body.rating);
    let rating = body.rating;
    let result = null;
    let correct = null;
    if (card.kind === 'rw') {
      const graded = gradeRewrite(body.answer ?? '', card.must ?? []);
      if (!graded.correct) {
        // 指定的連接詞或語氣缺一 → 直接判錯，不必自評。
        result = graded;
        rating = 1;
        correct = false;
      } else if (!Number.isInteger(body.rating)) {
        return {
          phase: 'self',
          grade: graded,
          answer: card.answer ?? null,
          note: card.note ?? null,
          src: card.front?.src ?? null,
        };
      } else {
        result = graded;
        rating = body.rating;
        // 要素齊全但整句自評「差很多」仍算錯，否則統計會把它當成答對。
        correct = rating > 1;
      }
    } else if (card.kind === 'nom') {
      result = gradeNom(body.answer ?? '', card.accept ?? [card.answer], card.noun ?? '');
      rating = result.correct ? 3 : 1;
    } else if (card.kind === 'pick') {
      result = gradePick(body.answer ?? '', card.answer, card.front?.options ?? []);
      rating = result.correct ? 3 : 1;
    } else if (card.mode === 'typed' || card.mode === 'choice') {
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
      cardId,
      rating,
      answered: body.answer ?? null,
      correct: correct ?? (result ? result.correct : rating > 1),
      reason: result ? result.reason : null,
      ms: Number.isFinite(body.ms) ? Math.round(body.ms) : null,
      selfRated: suppliedRating && (card.mode === 'self' || card.kind === 'rw'),
    });

    return {
      phase: 'done',
      reviewId: state.eventId,
      selfRated: suppliedRating && (card.mode === 'self' || card.kind === 'rw'),
      rating,
      grade: result,
      answer: card.kind === 'vocab-recall' ? card.front?.gloss ?? null : card.answer ?? null,
      en: card.kind === 'vocab-recall' ? card.front?.en ?? null : null,
      glossSource: card.kind === 'vocab-recall' ? card.front?.glossSource ?? null : null,
      accept: card.accept ?? null,
      note: card.note ?? null,
      fn: card.kind === 'connector' ? card.front?.fn ?? null : null,
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

  /**
   * 題庫 id 常直接含答案（例如 v:école|NOM|p），出題時換成執行期隨機代號。
   * 同一張卡沿用同一代號，Map 最多只有題庫張數，不會隨每次刷新一直長大。
   */
  queueCard(card) {
    let token = this.cardTokens.get(card.id);
    if (!token) {
      token = randomUUID();
      this.cardTokens.set(card.id, token);
      this.tokenCards.set(token, card.id);
    }
    return stripAnswer({ ...card, id: token });
  }

  /** 直接呼叫 Api 的測試與本機腳本仍可用真 id；瀏覽器拿到的則只會是代號。 */
  resolveCard(id) {
    return this.tokenCards.get(id) ?? id;
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
      practice: this.attempts.summary({ days: clampInt(query.days, 7, 365, 120) }),
      attemptsJournal: this.attempts.info(),
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

    // 設定成不設上限時沒有「照設定推演」這回事，前端會請使用者自己填一個數；
    // 真的沒填才退回 15，模擬需要一個數字。
    const plan = simulate({ ...base, dailyNew: clampInt(query.new, 0, 200, this.store.dailyNewLimit ?? 15) });
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
    const rows = this.store.db
      .prepare(
        `SELECT c.id, c.level, s.stability, s.difficulty, s.due
         FROM cards c LEFT JOIN states s ON s.card_id = c.id${clause}`,
      )
      .all(...params);
    // 起始等級以下、還沒學過的卡，出題時永遠不會拿出來。推演若把它們當成排隊中的新卡，
    // 會以為考前學得完，實際上一張都不會學——標成 locked，引擎只算不學。
    const fresh = this.store.freshScope(scope).levels;
    if (scope.levels?.length || !fresh?.length) return rows;
    return rows.map((r) => (r.stability == null && !fresh.includes(r.level) ? { ...r, locked: true } : r));
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

  /**
   * 今天四科各要做什麼。所有算術都在 engine/today.mjs，這裡只負責取數字。
   * 刻意不吃 scope：這一頁問的是「今天整體該做什麼」，
   * 被側欄的題型篩選改掉就失去意義了。
   */
  today() {
    const s = this.store.summary();
    const practiceToday = this.attempts.today();
    return buildToday({
      byKind: this.store.byKind(),
      newLimit: this.store.dailyNewLimit,
      newToday: this.store.newIntroducedToday(),
      startLevel: this.store.startLevel,
      examDate: this.store.get('examDate', null),
      reviewsToday: s.todayReviews,
      streakDays: s.streakDays,
      checkins: this.store.checkinState(),
      practiceToday,
    });
  }

  practice(body) {
    try {
      return this.attempts.practice(body ?? {});
    } catch (err) {
      throw new HttpError(400, err.message);
    }
  }

  mock(body) {
    try {
      return this.attempts.mock(body ?? {});
    } catch (err) {
      throw new HttpError(400, err.message);
    }
  }

  async correctReview(body) {
    try {
      return await this.store.correctReview({ id: String(body?.id ?? ''), rating: Number(body?.rating) });
    } catch (err) {
      throw new HttpError(400, err.message);
    }
  }

  /**
   * 手動打卡。回傳整份 today，讓前端直接換掉畫面——
   * 只回 {ok:true} 的話前端得自己猜新的狀態，猜錯就會與伺服器分岔。
   *
   * 只認 skill 與 done 兩個欄位。日期由伺服器決定，不吃前端傳來的 day：
   * 那會讓「補打昨天的卡」變成一個沒人要求過、也沒有畫面的功能，
   * 卻先開了一個可以往事實檔寫任意日期的口。
   */
  checkin(body) {
    const skill = String(body?.skill ?? '');
    if (!CHECKIN_SKILLS.includes(skill)) {
      throw new HttpError(400, `只有 ${CHECKIN_SKILLS.join('／')} 可以打卡，收到 ${skill || '空值'}`);
    }
    this.store.checkin({ skill, done: body.done !== false });
    return this.today();
  }

  /** 讀 study/ 底下的一份文件。回純文字，Markdown 由前端的 markdown.mjs 渲染。 */
  async doc(query = {}) {
    const entry = DOCS[String(query.id ?? '')];
    if (!entry) throw new HttpError(404, `沒有這份文件：${query.id}`);
    let text;
    try {
      text = await readFile(path.join(STUDY_DIR, entry.file), 'utf8');
    } catch {
      throw new HttpError(404, `找不到 study/${entry.file}——這個檔跟著 repo 走，被刪掉就要從版控還原`);
    }
    return { id: query.id, title: entry.title, path: `study/${entry.file}`, text };
  }

  settings(body) {
    if (body) {
      if (body.desiredRetention !== undefined) {
        const r = Number(body.desiredRetention);
        if (!(r >= 0.7 && r <= 0.98)) throw new HttpError(400, '目標記憶率請落在 0.70–0.98');
        this.store.set('desiredRetention', r);
      }
      if (body.dailyNewLimit !== undefined) {
        // null 是「不設上限」，要原樣存下來。不能丟給 clampInt：Number(null) 是 0，
        // 那會把「不設上限」存成「一張都不給」，剛好相反。
        this.store.set('dailyNewLimit', body.dailyNewLimit === null ? null : clampInt(body.dailyNewLimit, 0, 200, 15));
      }
      if (body.examDate !== undefined) {
        const v = body.examDate;
        if (v !== null && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new HttpError(400, '考試日期格式需為 YYYY-MM-DD');
        this.store.set('examDate', v);
      }
      if (body.startLevel !== undefined) {
        const v = body.startLevel;
        if (v !== null && !LEVELS.includes(v)) throw new HttpError(400, `起始等級只能是 ${LEVELS.join('／')} 或留空`);
        this.store.set('startLevel', v);
      }
    }
    return {
      desiredRetention: this.store.desiredRetention,
      dailyNewLimit: this.store.dailyNewLimit,
      examDate: this.store.get('examDate', null),
      startLevel: this.store.startLevel,
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
  /**
   * 題庫搜尋。
   *
   * 兩件事要一起處理，不然結果會騙人：
   *
   *  1. **中文查得到。** 除了 answer／tags／id，也比對 search 欄——那一欄在灌
   *     題庫時把各題型的中文釋義攤平進去（見 db.mjs 的 searchText）。沒有它的話
   *     「迎接」會回 0 筆，可是題庫裡有 40 張卡的釋義寫著迎接。
   *  2. **上限套在收合後的組數上。** 同一個動詞的六個時態是 36 張卡，前端會收成
   *     一列。上限若套在卡上，查 avoir 的 40 個名額會被 avoir 自己吃掉 36 個，
   *     只剩 4 筆別的東西。所以先多撈一些、在這裡分好組，再數組數。
   */
  search(query = {}) {
    const q = String(query.q ?? '').trim();
    if (q.length < 1) return { hits: [], total: 0, groups: 0, truncated: false };
    const like = `%${q}%`;
    const where = `WHERE c.answer LIKE ? OR c.tags LIKE ? OR c.id LIKE ? OR c.search LIKE ?`;
    const args = [like, like, like, like];

    const total = this.store.db
      .prepare(`SELECT COUNT(*) n FROM cards c ${where}`)
      .get(...args).n;

    // 掃描上限。一個動詞最多 36 張變位卡，SCAN 要夠大才裝得下 40 組，
    // 又不能大到把整個題庫撈進記憶體。
    const rows = this.store.db
      .prepare(
        `SELECT c.payload, s.stability, s.due, s.lapses
         FROM cards c LEFT JOIN states s ON s.card_id = c.id
         ${where}
         ORDER BY CASE
           WHEN c.headword = ? COLLATE NOCASE THEN 0
           WHEN c.answer = ? COLLATE NOCASE THEN 1
           WHEN c.headword LIKE ? COLLATE NOCASE THEN 2
           ELSE 3
         END, c.freq DESC, c.id ASC LIMIT ?`,
      )
      .all(...args, q, q, `${q}%`, SEARCH_SCAN);

    const hits = [];
    const seenGroups = new Set();
    for (const r of rows) {
      const card = JSON.parse(r.payload);
      // 變位卡以動詞為一組，其餘每張卡自成一組。
      const key = card.kind === 'conj' && card.front?.verb ? `verb:${card.front.verb}` : `card:${card.id}`;
      if (!seenGroups.has(key)) {
        if (seenGroups.size >= SEARCH_GROUPS) continue;
        seenGroups.add(key);
      }
      hits.push({
        card,
        state: r.stability == null ? null : { stability: r.stability, due: r.due, lapses: r.lapses },
      });
    }

    return {
      hits,
      total,
      groups: seenGroups.size,
      truncated: total > rows.length || seenGroups.size >= SEARCH_GROUPS,
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
  // must 是改寫題的必要要素、noun 是名詞化題的名詞本體，兩者都是答案片段，跟 answer 一起拿掉。
  const { answer, accept, note, must, noun, tags, ...rest } = card;
  if (keepAnswer) return { ...rest, answer, note };

  const front = { ...(rest.front ?? {}) };
  if (card.kind === 'vocab-recall') {
    delete front.gloss;
    delete front.en;
    delete front.glossSource;
  }
  if (card.kind === 'vocab-produce') delete front.word;
  if (card.kind === 'connector') {
    // moodRaw 是答案本身，fn 則常能直接推出答案；兩者都在作答後由 review 回應提供。
    delete front.moodRaw;
    delete front.fn;
  }
  return { ...rest, front };
}

function clampInt(raw, min, max, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.round(n), min), max);
}
