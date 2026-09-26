/**
 * API 層。純函式，不碰 HTTP，方便測試。
 * server.mjs 只負責把請求解析成參數、把回傳值變成 JSON。
 */

import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { grade, gradePick, gradeRewrite, gradeNom } from './engine/grade.mjs';
import { simulate, solveDailyNew, ratingModel, firstRatingModel, FIRST_RATING_MIN } from './engine/forecast.mjs';
import { buildToday } from './engine/today.mjs';
import { localDay, CHECKIN_SKILLS, MATURE_DAYS, ACTIVE_LEVELS, scopeClause } from './db.mjs';
import { readCheck } from './engine/lexicon.mjs';
import { AttemptLog } from './attempts.mjs';
import { backupBundle, backupStatus } from './backup.mjs';

const KINDS = ['vocab-recall', 'vocab-produce', 'conj', 'connector', 'pick', 'rw', 'nom'];
export { ACTIVE_LEVELS };

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
    return { kinds: pick(query.kinds, KINDS), levels: pick(query.levels, ACTIVE_LEVELS) };
  }

  /**
   * 學習、統計和推演用的範圍。A1 單字不出新卡，但變位題與學過的 A1 卡照常，
   * 條件寫在 db.mjs 的 ACTIVE_CLAUSE；側欄明確勾了等級時只照勾的。
   */
  static activeScope(scope = {}) {
    return { ...scope, levels: scope.levels ?? [], active: true };
  }

  summary() {
    const scope = Api.activeScope();
    const s = this.store.summary(scope);
    return {
      ...s,
      byKind: this.store.byKind(scope),
      streakDays: this.attempts.activityStreak(),
      backup: backupStatus(this.store.dataDir),
      settings: {
        desiredRetention: this.store.desiredRetention,
        dailyNewLimit: this.store.dailyNewLimit,
        examDate: this.store.get('examDate', null),
      },
      meta: this.store.get('bankMeta', null),
    };
  }

  queue(query = {}) {
    const scope = Api.activeScope(Api.scope(query));
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
      examples: f.examples ?? [],
      // 四個評分各會排到幾天後，印在評分鍵上。只算不寫，不碰 reviews.jsonl。
      intervals: this.store.previewIntervals(cardId),
    };
  }

  /**
   * 名詞化與改寫整句的新卡，第一次出現時先給看解答（2026-09-24 使用者決定）。
   * 實測這兩種題第一次見就要憑空寫出來，答錯的多半不是忘了，是從來沒學過規則。
   *
   * 只讀，不寫任何紀錄：看過解答不算作答，排程從之後那次真正的考試才開始。
   * 只放行「還沒有排程狀態」的卡——學過的卡拿得到解答就等於考前偷看。
   */
  preview(query = {}) {
    const cardId = this.resolveCard(String(query.id ?? ''));
    const card = this.store.card(cardId);
    if (!card) throw new HttpError(404, `找不到卡片 ${query.id ?? ''}`);
    if (card.kind !== 'nom' && card.kind !== 'rw') {
      throw new HttpError(400, '只有名詞化與改寫整句的新卡可以先看解答');
    }
    if (this.store.state(cardId)) throw new HttpError(400, '這張卡已經學過，不能先看解答');
    // must 不給：那是批改用的比對片段（例如 sans qu 同時接住 que／qu'），印出來反而看不懂。
    return { answer: card.answer ?? null, note: card.note ?? null };
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
      examples: card.kind === 'vocab-recall' || card.kind === 'vocab-produce' ? card.front?.examples ?? [] : [],
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
    const days = clampInt(query.days, 7, 365, 120);
    const scope = Api.activeScope(Api.scope(query));
    const summary = this.store.summary(scope);
    return {
      scope,
      periodDays: days,
      summary: { ...summary, streakDays: this.attempts.activityStreak() },
      byKind: this.store.byKind(scope),
      daily: this.store.daily(days, scope),
      upcoming: this.store.upcoming(clampInt(query.upcoming, 7, 180, 30), scope),
      weakest: this.store.weakest(clampInt(query.weakest, 1, 100, 24), scope).map((w) => ({
        ...w,
        card: stripAnswer(w.card, true),
      })),
      errorProfile: this.store.errorProfile(scope),
      // 紀錄檔是整份 JSONL，不隨 scope 變——它量的是磁碟，不是題庫子集。
      journal: this.store.journalInfo(),
      practice: this.attempts.summary({ days }),
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

    const scope = Api.activeScope(Api.scope(query));
    const cards = this.scopedStates(scope);
    const models = this.forecastModels();

    const base = {
      cards,
      from: today,
      examDate: exam,
      dailyLimit: clampInt(query.limit, 5, 500, 60),
      desiredRetention: this.store.desiredRetention,
      ratings: models.ratings,
      firstRatings: models.firstRatings,
      secondsPerCard: models.secondsPerCard,
      secondsByKind: models.secondsByKind,
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
        ratingSample: models.ratings.default?.sample ?? 0,
        ratingKinds: Object.fromEntries(Object.entries(models.ratings.byKind).map(([kind, value]) => [kind, value.sample])),
        firstRatingKinds: Object.fromEntries(Object.entries(models.firstRatings.byKind).map(([kind, value]) => [kind, value.sample])),
        firstRatingMin: FIRST_RATING_MIN,
        secondsPerCard: models.secondsPerCard,
        secondsByKind: models.secondsByKind,
        secondsSource: models.secondsPerCard === DEFAULT_SECONDS ? 'default' : 'observed',
        scope,
      },
    };
  }

  /** 範圍內每張卡的 FSRS 狀態。沒練過的卡沒有狀態，模擬時當新卡。 */
  scopedStates(scope) {
    const [where, params] = scopeClause(scope);
    const clause = ` WHERE 1 = 1${where}`;
    const rows = this.store.db
      .prepare(
        `SELECT c.id, c.kind, c.level, s.stability, s.difficulty, s.due,
                EXISTS (SELECT 1 FROM states g
                  WHERE g.card_id = substr(c.id, 1, length(c.id) - 1) || 'r') recall_seen,
                EXISTS (SELECT 1 FROM cards g2
                  WHERE g2.id = substr(c.id, 1, length(c.id) - 1) || 'r') recall_exists
         FROM cards c LEFT JOIN states s ON s.card_id = c.id${clause}`,
      )
      .all(...params);
    // 起始等級以下、還沒學過的卡，出題時永遠不會拿出來。推演若把它們當成排隊中的新卡，
    // 會以為考前學得完，實際上一張都不會學——標成 locked，引擎只算不學。
    return rows.map(({ recall_seen, recall_exists, ...row }) => {
      const produceLocked = row.stability == null && row.kind === 'vocab-produce'
        && row.id.endsWith('|p') && recall_exists === 1 && recall_seen === 0;
      return produceLocked ? { ...row, prerequisite: `${row.id.slice(0, -1)}r` } : row;
    });
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

  /** 推演分題型取樣；題型樣本不夠時各自退回全體資料或明示的預設值。 */
  forecastModels() {
    const correct = this.store.db.prepare(
      `SELECT c.kind, r.rating FROM reviews r JOIN cards c ON c.id = r.card_id
       WHERE r.correct = 1`,
    ).all();
    const first = this.store.db.prepare(
      `SELECT c.kind, r.rating FROM reviews r JOIN cards c ON c.id = r.card_id
       WHERE r.seq = (SELECT MIN(r2.seq) FROM reviews r2 WHERE r2.card_id = r.card_id)`,
    ).all();
    const timed = this.store.db.prepare(
      `SELECT c.kind, r.ms FROM reviews r JOIN cards c ON c.id = r.card_id
       WHERE r.ms BETWEEN 500 AND 120000 ORDER BY c.kind, r.ms`,
    ).all();
    const secondsPerCard = this.medianSeconds();
    const secondsByKind = {};
    for (const kind of KINDS) {
      const values = timed.filter((row) => row.kind === kind).map((row) => row.ms);
      if (values.length >= 10) secondsByKind[kind] = Math.round((values[Math.floor(values.length / 2)] / 1000) * 10) / 10;
    }
    return {
      ratings: ratingModel(correct),
      firstRatings: firstRatingModel(first),
      secondsPerCard,
      secondsByKind,
    };
  }

  /**
   * 今天四科各要做什麼。所有算術都在 engine/today.mjs，這裡只負責取數字。
   * 刻意不吃 scope：這一頁問的是「今天整體該做什麼」，
   * 被側欄的題型篩選改掉就失去意義了。
   */
  today() {
    const scope = Api.activeScope();
    const s = this.store.summary(scope);
    const practiceToday = this.attempts.today();
    return buildToday({
      byKind: this.store.byKind(scope),
      newLimit: this.store.dailyNewLimit,
      newToday: this.store.newIntroducedToday(),
      examDate: this.store.get('examDate', null),
      reviewsToday: s.todayReviews,
      streakDays: this.attempts.activityStreak(),
      checkins: this.store.checkinState(),
      practiceToday,
    });
  }

  /**
   * 今天頁那一行推演：照最近 7 天的節奏一路做到考試，那天大約記得幾張；完全停下來又剩幾張。
   *
   * 不併進 /api/today：一次模擬約 30ms、範圍內一萬張卡撈狀態約 60ms，
   * 併進去的話每次打開今天頁、每按一次打卡都要多等這段時間。分開撈，列表先出來。
   *
   * 節奏用「答題數 ÷ 7」而不是「有練的日子的平均」：隔一天沒做，這個數字就該掉，
   * 那正是這一行存在的理由。結果以（日期、作答總數、設定）為鍵快取，答了一題才重算。
   */
  outlook() {
    const examDate = this.store.get('examDate', null);
    const exam = examDate ? new Date(`${examDate}T00:00:00`) : null;
    const now = new Date();
    if (!exam || Number.isNaN(exam.getTime()) || exam < new Date(`${localDay(now)}T00:00:00`)) {
      return { examDate: null };
    }
    const reviewsTotal = this.store.db.prepare('SELECT COUNT(*) n FROM reviews').get().n;
    const key = [localDay(now), examDate, reviewsTotal, this.store.desiredRetention, this.store.dailyNewLimit].join('|');
    if (this.outlookCache?.key === key) return this.outlookCache.value;

    const windowReviews = this.store.reviewsSince({ days: OUTLOOK_WINDOW, now });
    const pace = Math.round(windowReviews / OUTLOOK_WINDOW);
    const models = this.forecastModels();
    const base = {
      cards: this.scopedStates(Api.activeScope()),
      from: now,
      examDate: exam,
      desiredRetention: this.store.desiredRetention,
      ratings: models.ratings,
      firstRatings: models.firstRatings,
      secondsPerCard: models.secondsPerCard,
      secondsByKind: models.secondsByKind,
    };
    // 新卡設成不設上限時，新卡就吃掉整個節奏裡複習沒用完的額度，模擬裡本來就是這樣分的。
    const dailyNew = Math.min(this.store.dailyNewLimit ?? pace, pace);
    const going = simulate({ ...base, dailyLimit: pace, dailyNew });
    const stopped = simulate({ ...base, dailyLimit: 0, dailyNew: 0 });
    const value = {
      examDate,
      daysUntilExam: going.daysUntilExam,
      window: OUTLOOK_WINDOW,
      windowReviews,
      pace,
      cardsInScope: going.cardsInScope,
      expectedRecall: Math.round(going.expectedRecall),
      studiedByExam: going.studiedByExam,
      stoppedRecall: Math.round(stopped.expectedRecall),
    };
    this.outlookCache = { key, value };
    return value;
  }

  /**
   * 「這句你認得幾個字」。句子依日期固定挑一句，重新整理不會換；?i= 可以指定第幾句（換一句用）。
   */
  sentence(query = {}) {
    const pool = this.store.readingSentences();
    if (!pool.length) return { total: 0, sentence: null };
    const seed = [...localDay()].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) % 100_003, 7);
    const wanted = query.i === undefined ? seed : Number.parseInt(query.i, 10);
    if (!Number.isInteger(wanted)) throw new HttpError(400, 'i 需要是整數');
    const index = ((wanted % pool.length) + pool.length) % pool.length;
    const pick = pool[index];
    const { tokens, counts } = readCheck(pick.text, this.store.lexicon(), this.store.wordStatus());
    return {
      total: pool.length,
      index,
      sentence: { id: pick.id, kind: pick.kind, src: pick.src, tokens, counts },
    };
  }

  /** 最近 7 天第一次跨過穩定度 21 天的卡。 */
  weekly() {
    const now = new Date();
    const from = new Date(now);
    from.setDate(from.getDate() - (WEEKLY_WINDOW - 1));
    const items = this.store.maturedRecently({ days: WEEKLY_WINDOW, now }).map((row) => ({
      id: row.id,
      kind: row.kind,
      day: row.day,
      stability: Math.round(row.stability),
      ...maturedLabel(row),
    }));
    const matureTotal = this.store.db
      .prepare('SELECT COUNT(*) n FROM states WHERE stability >= ?')
      .get(MATURE_DAYS).n;
    return { window: WEEKLY_WINDOW, from: localDay(from), to: localDay(now), items, matureTotal };
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

  backup() {
    return backupBundle(this.store.dataDir);
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
        if (v !== null) throw new HttpError(400, 'A1 已退出日常學習，起始等級不再需要設定');
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

/** 推演節奏取最近幾天的平均。 */
const OUTLOOK_WINDOW = 7;
/**
 * 「這週穩了」看最近幾天。用滾動 7 天而不是週一起算的日曆週：
 * 日曆週在週一幾乎永遠是空的，那天打開今天頁只會看到一塊空白。
 */
const WEEKLY_WINDOW = 7;

/**
 * 穩了的卡怎麼顯示。每種題型「那張卡在考什麼」不同，一律印 headword 的話
 * 變位卡只會出現一整排 être，改寫題會印出整句解答。
 */
function maturedLabel(row) {
  const f = row.card.front ?? {};
  switch (row.kind) {
    case 'vocab-recall':
    case 'vocab-produce':
      return { label: f.word, sub: f.gloss || null };
    case 'conj':
      return { label: `${f.pronoun} ${row.answer}`, sub: `${f.verb}・${f.tenseZh}` };
    case 'nom':
      return { label: `${f.base} → ${row.answer}`, sub: f.gloss || null };
    case 'connector':
      return { label: f.connector, sub: f.zh || null };
    case 'pick':
      return { label: row.answer, sub: f.src || null };
    case 'rw':
      return { label: f.tool, sub: f.prompt || null };
    default:
      return { label: row.headword ?? row.id, sub: null };
  }
}

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
  // 例句裡就是答案本身（寫），或帶著中文翻譯（認），兩種單字卡都等作答後才給。
  if (card.kind === 'vocab-recall' || card.kind === 'vocab-produce') delete front.examples;
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
