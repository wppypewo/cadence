/**
 * 儲存層：一份不可重建的事實紀錄，加一份隨時可丟的索引。
 *
 *   data/reviews.jsonl  每次作答一行 JSON，只增不改。這是唯一的事實來源，
 *                       進版控，十年後用 cat 就讀得懂，不依賴本專案還活著。
 *   data/cadence.db     SQLite。題庫、FSRS 記憶狀態、統計都在這裡，
 *                       全部可由上面那個檔重算（cadence reindex），不進版控。
 *
 * 這樣切的理由：SQLite 檔壞掉、schema 改版、或這個專案被丟掉，
 * 使用者練了幾百天的紀錄都還在，而且是人看得懂的格式。
 */

import { DatabaseSync } from 'node:sqlite';
import { appendFileSync, createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createScheduler } from './engine/fsrs.mjs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cards (
  id       TEXT PRIMARY KEY,
  kind     TEXT NOT NULL,
  mode     TEXT NOT NULL,
  level    TEXT NOT NULL,
  freq     REAL NOT NULL DEFAULT 0,
  tags     TEXT NOT NULL,
  answer   TEXT,
  accept   TEXT,
  search   TEXT,
  payload  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS cards_kind ON cards(kind, level);

-- 每張卡的 FSRS 記憶狀態。完全由 reviews 推導，reindex 會整個重算。
CREATE TABLE IF NOT EXISTS states (
  card_id     TEXT PRIMARY KEY,
  stability   REAL NOT NULL,
  difficulty  REAL NOT NULL,
  due         TEXT NOT NULL,
  last_review TEXT NOT NULL,
  reps        INTEGER NOT NULL DEFAULT 0,
  lapses      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS states_due ON states(due);

-- reviews.jsonl 的鏡像，供統計查詢。壞了就重建，不是事實來源。
CREATE TABLE IF NOT EXISTS reviews (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id   TEXT NOT NULL,
  at        TEXT NOT NULL,
  day       TEXT NOT NULL,
  rating    INTEGER NOT NULL,
  elapsed   REAL NOT NULL,
  answered  TEXT,
  correct   INTEGER,
  reason    TEXT,
  ms        INTEGER
);
CREATE INDEX IF NOT EXISTS reviews_card ON reviews(card_id);
CREATE INDEX IF NOT EXISTS reviews_at ON reviews(at);
CREATE INDEX IF NOT EXISTS reviews_day ON reviews(day);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const DAY_MS = 86_400_000;

/** 以本地時區算「哪一天」。用 UTC 會讓深夜複習被算到隔天，統計就對不上感覺。 */
export function localDay(date = new Date()) {
  const d = new Date(date);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}

/**
 * 本地時區「今天結束」的那一瞬間，也就是明天 00:00。
 *
 * 「到期」在這個專案裡一律是天為單位的概念：排程只排到日，使用者問的也是
 * 「今天該做幾張」。之前 dueCount 用 `due <= now` 比瞬間、upcoming 用 localDay
 * 比日，同一份資料會得出兩個數字——統計頁曾同時顯示「現在到期 0／沒有欠帳」
 * 跟「另有 9 張已經到期還沒做」。所有到期查詢都改成跟這個界線比。
 */
export function endOfLocalDay(now = new Date()) {
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return d.toISOString();
}

/**
 * 小幅 schema 演進。cards 整張表都是可重建資料（來源是 data/bank/cards.json），
 * 所以加欄位時直接清空，交給下一次 loadBank 重灌，不需要回填腳本。
 * states 與 reviews 不能這樣處理，那兩張表若要改結構得另外寫遷移。
 */
function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(cards)').all().map((c) => c.name);
  if (!cols.includes('search')) {
    db.exec('ALTER TABLE cards ADD COLUMN search TEXT');
    db.exec('DELETE FROM cards');
  }
}

/**
 * 一張卡在搜尋時該被哪些字命中。
 *
 * answer 是法文答案、tags 是分類，兩者都不含中文——但中翻法那 3,474 張卡的
 * 題面本身就是中文，使用者查「迎接」會一筆都找不到。中文釋義只存在 payload
 * 的 front 裡，而且各題型放的欄位不一樣（gloss／zh／prompt），所以在灌題庫時
 * 攤平成一欄，讓 SQL 直接 LIKE 得到，不必掃 payload。
 *
 * 刻意不收 posZh、tenseZh 這類分類詞：搜「動詞」會命中九千多張，等於沒搜。
 */
function searchText(card) {
  const f = card.front ?? {};
  return [f.gloss, f.zh, f.prompt, f.verb, f.base, f.connector, f.word]
    .filter((x) => typeof x === 'string' && x.trim())
    .join(' ');
}

export class Store {
  /**
   * @param {string} dataDir 專案的 data/ 目錄
   */
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.jsonlPath = path.join(dataDir, 'reviews.jsonl');
    this.dbPath = path.join(dataDir, 'cadence.db');
    this.bankDir = path.join(dataDir, 'bank');
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec(SCHEMA);
    migrate(this.db);
    this.scheduler = createScheduler({ desiredRetention: this.desiredRetention });
  }

  close() {
    this.db.close();
  }

  // ---- 設定 -------------------------------------------------------------

  get(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : fallback;
  }

  set(key, value) {
    this.db
      .prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
    if (key === 'desiredRetention') {
      this.scheduler = createScheduler({ desiredRetention: value });
    }
  }

  get desiredRetention() {
    return this.get('desiredRetention', 0.9);
  }

  get dailyNewLimit() {
    return this.get('dailyNewLimit', 15);
  }

  // ---- 題庫 -------------------------------------------------------------

  /** 把 data/bank/cards.json 灌進 SQLite。卡片是可重建資料，整表換掉即可。 */
  async loadBank() {
    const file = path.join(this.bankDir, 'cards.json');
    if (!existsSync(file)) {
      throw new Error(`找不到題庫 ${file}。先跑 npm run build。`);
    }
    const cards = JSON.parse(await readFile(file, 'utf8'));
    const insert = this.db.prepare(
      'INSERT INTO cards(id, kind, mode, level, freq, tags, answer, accept, search, payload) VALUES(?,?,?,?,?,?,?,?,?,?)',
    );
    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM cards');
      for (const c of cards) {
        insert.run(
          c.id, c.kind, c.mode, c.level, c.freq ?? 0,
          c.tags.join(','), c.answer ?? null,
          c.accept ? JSON.stringify(c.accept) : null,
          searchText(c),
          JSON.stringify(c),
        );
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    // 題庫換過之後，可能有卡片消失了，順手清掉指向不存在卡片的狀態。
    this.db.exec('DELETE FROM states WHERE card_id NOT IN (SELECT id FROM cards)');
    return cards.length;
  }

  cardCount() {
    return this.db.prepare('SELECT COUNT(*) n FROM cards').get().n;
  }

  card(id) {
    const row = this.db.prepare('SELECT payload FROM cards WHERE id = ?').get(id);
    return row ? JSON.parse(row.payload) : null;
  }

  // ---- 寫入複習紀錄 -----------------------------------------------------

  /**
   * 記一次作答。先寫 JSONL（不可重建的那份），再更新索引。
   * 順序刻意如此：中途當掉的話，寧可索引落後，也不要事實紀錄漏掉。
   *
   * @param {{cardId:string, rating:number, answered?:string, correct?:boolean,
   *          reason?:string, ms?:number, at?:Date}} input
   */
  review(input) {
    const card = this.card(input.cardId);
    if (!card) throw new Error(`找不到卡片 ${input.cardId}`);
    const at = input.at ?? new Date();
    const prev = this.state(input.cardId);
    const elapsed = prev ? (at - new Date(prev.last_review)) / DAY_MS : 0;

    const entry = {
      v: 1,
      card: input.cardId,
      at: at.toISOString(),
      day: localDay(at),
      rating: input.rating,
      elapsed: Number(elapsed.toFixed(6)),
      answered: input.answered ?? null,
      correct: input.correct ?? null,
      reason: input.reason ?? null,
      ms: input.ms ?? null,
    };
    appendFileSync(this.jsonlPath, `${JSON.stringify(entry)}\n`, 'utf8');

    this.applyReview(entry);
    return this.state(input.cardId);
  }

  /** 把一筆紀錄套進索引。reindex 會對整個檔案重跑這個函式。 */
  applyReview(entry) {
    const prev = this.state(entry.card);
    const next = this.scheduler.review(
      prev ? { stability: prev.stability, difficulty: prev.difficulty } : null,
      entry.rating,
      entry.elapsed,
    );
    const at = new Date(entry.at);
    const due = new Date(at.getTime() + next.intervalDays * DAY_MS);
    this.db
      .prepare(
        `INSERT INTO states(card_id, stability, difficulty, due, last_review, reps, lapses)
         VALUES(?,?,?,?,?,1,?)
         ON CONFLICT(card_id) DO UPDATE SET
           stability = excluded.stability, difficulty = excluded.difficulty,
           due = excluded.due, last_review = excluded.last_review,
           reps = states.reps + 1, lapses = states.lapses + excluded.lapses`,
      )
      .run(
        entry.card, next.stability, next.difficulty,
        due.toISOString(), entry.at, entry.rating === 1 ? 1 : 0,
      );
    this.db
      .prepare('INSERT INTO reviews(card_id, at, day, rating, elapsed, answered, correct, reason, ms) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(
        entry.card, entry.at, entry.day ?? localDay(new Date(entry.at)), entry.rating, entry.elapsed,
        entry.answered ?? null,
        entry.correct === null || entry.correct === undefined ? null : Number(entry.correct),
        entry.reason ?? null, entry.ms ?? null,
      );
    return next;
  }

  state(cardId) {
    return this.db.prepare('SELECT * FROM states WHERE card_id = ?').get(cardId) ?? null;
  }

  /**
   * 從 reviews.jsonl 整個重算索引。
   * 壞掉的行不會讓整個重建失敗，會被計數回報——寧可救回 99% 也不要全丟。
   */
  async reindex(onProgress = () => {}) {
    this.db.exec('DELETE FROM states');
    this.db.exec('DELETE FROM reviews');
    if (!existsSync(this.jsonlPath)) return { applied: 0, skipped: 0, bad: [] };

    const rl = createInterface({
      input: createReadStream(this.jsonlPath, 'utf8'),
      crlfDelay: Infinity,
    });
    let applied = 0;
    let lineNo = 0;
    const bad = [];
    this.db.exec('BEGIN');
    try {
      for await (const line of rl) {
        lineNo += 1;
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (!entry.card || !entry.at || !entry.rating) throw new Error('缺必要欄位');
          this.applyReview(entry);
          applied += 1;
          if (applied % 500 === 0) onProgress(applied);
        } catch (err) {
          bad.push({ line: lineNo, error: err.message });
        }
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return { applied, skipped: bad.length, bad };
  }

  /** reviews.jsonl 的體積與行數，doctor 用。 */
  journalInfo() {
    if (!existsSync(this.jsonlPath)) return { exists: false, bytes: 0 };
    return { exists: true, bytes: statSync(this.jsonlPath).size };
  }
}

// ---- 出題佇列 -----------------------------------------------------------
//
// 排序邏輯刻意寫在 SQL 裡：16,401 張卡若先撈進 JS 再篩，每次出題都要動到幾 MB
// 的物件；交給 SQLite 走索引，記憶體佔用與題庫大小無關。

/** 建立 kind / level 的 WHERE 片段。回傳 [sql, params]。 */
function scopeClause(scope = {}) {
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
  return [where.length ? ` AND ${where.join(' AND ')}` : '', params];
}

Object.assign(Store.prototype, {
  /** 今天已經第一次見過的新卡數量，用來壓住每日新卡上限。 */
  newIntroducedToday(day = localDay()) {
    return this.db
      .prepare(
        `SELECT COUNT(*) n FROM (
           SELECT card_id, MIN(at) first_at, MIN(day) first_day FROM reviews GROUP BY card_id
         ) WHERE first_day = ?`,
      )
      .get(day).n;
  },

  /** 今天（含今天以前）到期的卡數量，不含新卡。界線見 endOfLocalDay。 */
  dueCount(scope = {}, now = new Date()) {
    const [clause, params] = scopeClause(scope);
    return this.db
      .prepare(`SELECT COUNT(*) n FROM states s JOIN cards c ON c.id = s.card_id WHERE s.due < ?${clause}`)
      .get(endOfLocalDay(now), ...params).n;
  },

  /** 還沒複習過的卡數量。 */
  newCount(scope = {}) {
    const [clause, params] = scopeClause(scope);
    return this.db
      .prepare(
        `SELECT COUNT(*) n FROM cards c LEFT JOIN states s ON s.card_id = c.id
         WHERE s.card_id IS NULL${clause}`,
      )
      .get(...params).n;
  },

  /**
   * 抽出一輪要練的卡。到期的排前面（忘掉的成本最高），新卡按頻率補位。
   *
   * @param {{limit?:number, kinds?:string[], levels?:string[], newLimit?:number}} opts
   */
  queue(opts = {}) {
    const now = opts.now ?? new Date();
    const limit = opts.limit ?? 20;
    const [clause, params] = scopeClause(opts);

    const due = this.db
      .prepare(
        `SELECT c.payload, s.due, s.stability, s.difficulty, s.reps, s.lapses
         FROM states s JOIN cards c ON c.id = s.card_id
         WHERE s.due < ?${clause}
         ORDER BY s.due ASC LIMIT ?`,
      )
      .all(endOfLocalDay(now), ...params, limit)
      .map((r) => ({ ...JSON.parse(r.payload), state: { due: r.due, stability: r.stability, difficulty: r.difficulty, reps: r.reps, lapses: r.lapses } }));

    const room = limit - due.length;
    if (room <= 0) return due;

    const budget = Math.max(0, (opts.newLimit ?? this.dailyNewLimit) - this.newIntroducedToday());
    if (budget <= 0) return due;

    // 新卡按 FLELex 頻率由高到低——先學常見詞，投報率最高。
    const fresh = this.db
      .prepare(
        `SELECT c.payload FROM cards c LEFT JOIN states s ON s.card_id = c.id
         WHERE s.card_id IS NULL${clause}
         ORDER BY c.freq DESC, c.id ASC LIMIT ?`,
      )
      .all(...params, Math.min(room, budget))
      .map((r) => ({ ...JSON.parse(r.payload), state: null }));

    return [...due, ...fresh];
  },

  // ---- 統計 -------------------------------------------------------------

  /**
   * 首頁用的一組數字。全部走索引，不掃全表。
   * 吃 scope——側欄勾了「只練 A2 動詞變位」，這些數字就要是那個範圍內的，
   * 否則畫面會同時聲稱「只練 1 種題型」跟「共 16,401 張」。
   */
  summary(scope = {}, now = new Date()) {
    const [clause, params] = scopeClause(scope);
    const total = this.db
      .prepare(`SELECT COUNT(*) n FROM cards c WHERE 1 = 1${clause}`)
      .get(...params).n;
    const seen = this.db
      .prepare(`SELECT COUNT(*) n FROM states s JOIN cards c ON c.id = s.card_id WHERE 1 = 1${clause}`)
      .get(...params).n;
    const due = this.dueCount(scope, now);
    const reviews = this.db
      .prepare(`SELECT COUNT(*) n FROM reviews r JOIN cards c ON c.id = r.card_id WHERE 1 = 1${clause}`)
      .get(...params).n;
    const todayRow = this.db
      .prepare(
        `SELECT COUNT(*) n, SUM(CASE WHEN r.correct = 1 THEN 1 ELSE 0 END) ok
         FROM reviews r JOIN cards c ON c.id = r.card_id
         WHERE r.day = ?${clause}`,
      )
      .get(localDay(now), ...params);
    // 「已掌握」定義為穩定度 ≥ 21 天，也就是照 FSRS 推算一個月後還記得的機率仍達標。
    const mature = this.db
      .prepare(
        `SELECT COUNT(*) n FROM states s JOIN cards c ON c.id = s.card_id
         WHERE s.stability >= 21${clause}`,
      )
      .get(...params).n;
    const streak = this.streak(scope, now);
    return {
      totalCards: total,
      seenCards: seen,
      newCards: total - seen,
      dueNow: due,
      matureCards: mature,
      totalReviews: reviews,
      todayReviews: todayRow.n,
      todayCorrect: todayRow.ok ?? 0,
      streakDays: streak,
    };
  },

  /** 連續練習天數。中斷就歸零——這個數字要能刺痛人才有用。 */
  streak(scope = {}, now = new Date()) {
    const [clause, params] = scopeClause(scope);
    const days = this.db
      .prepare(
        `SELECT DISTINCT r.day d FROM reviews r JOIN cards c ON c.id = r.card_id
         WHERE 1 = 1${clause} ORDER BY d DESC LIMIT 400`,
      )
      .all(...params)
      .map((r) => r.d);
    if (days.length === 0) return 0;
    const today = localDay(now);
    const yesterday = localDay(new Date(now.getTime() - DAY_MS));
    if (days[0] !== today && days[0] !== yesterday) return 0;
    let streak = 1;
    for (let i = 1; i < days.length; i += 1) {
      const prev = new Date(`${days[i - 1]}T00:00:00Z`).getTime();
      const cur = new Date(`${days[i]}T00:00:00Z`).getTime();
      if (prev - cur !== DAY_MS) break;
      streak += 1;
    }
    return streak;
  },

  /** 近 N 天每天的作答數與正確率，畫熱力圖用。 */
  daily(days = 90, scope = {}, now = new Date()) {
    const [clause, params] = scopeClause(scope);
    const from = localDay(new Date(now.getTime() - (days - 1) * DAY_MS));
    return this.db
      .prepare(
        `SELECT r.day day, COUNT(*) n,
                SUM(CASE WHEN r.correct = 1 THEN 1 ELSE 0 END) ok
         FROM reviews r JOIN cards c ON c.id = r.card_id
         WHERE r.day >= ?${clause}
         GROUP BY r.day ORDER BY r.day ASC`,
      )
      .all(from, ...params)
      .map((r) => ({ day: r.day, count: r.n, correct: r.ok ?? 0 }));
  },

  /**
   * 錯得最多的卡。這是人腦最算不出來的東西之一——
   * 你記得「有幾個字老是寫錯」，記不得是哪幾個、錯了幾次。
   */
  weakest(limit = 20, scope = {}) {
    const [clause, params] = scopeClause(scope);
    return this.db
      .prepare(
        `SELECT c.payload, s.difficulty, s.stability, s.lapses, s.reps,
                (SELECT COUNT(*) FROM reviews r WHERE r.card_id = c.id AND r.correct = 0) wrong,
                (SELECT r2.reason FROM reviews r2 WHERE r2.card_id = c.id AND r2.correct = 0
                   ORDER BY r2.at DESC LIMIT 1) lastReason
         FROM states s JOIN cards c ON c.id = s.card_id
         WHERE s.lapses > 0${clause}
         ORDER BY s.lapses DESC, s.difficulty DESC LIMIT ?`,
      )
      .all(...params, limit)
      .map((r) => ({
        card: JSON.parse(r.payload),
        difficulty: r.difficulty,
        stability: r.stability,
        lapses: r.lapses,
        reps: r.reps,
        wrong: r.wrong,
        lastReason: r.lastReason,
      }));
  },

  /** 錯誤類型分布：純粹拼錯，還是只差一個重音。 */
  errorProfile(scope = {}) {
    const [clause, params] = scopeClause(scope);
    return this.db
      .prepare(
        `SELECT r.reason reason, COUNT(*) n
         FROM reviews r JOIN cards c ON c.id = r.card_id
         WHERE r.correct = 0 AND r.reason IS NOT NULL${clause}
         GROUP BY r.reason ORDER BY n DESC`,
      )
      .all(...params)
      .map((r) => ({ reason: r.reason, count: r.n }));
  },

  /** 每個 kind 的進度。 */
  byKind(scope = {}, now = new Date()) {
    const [clause, params] = scopeClause(scope);
    return this.db
      .prepare(
        `SELECT c.kind,
                COUNT(*) total,
                SUM(CASE WHEN s.card_id IS NOT NULL THEN 1 ELSE 0 END) seen,
                SUM(CASE WHEN s.stability >= 21 THEN 1 ELSE 0 END) mature,
                SUM(CASE WHEN s.due < ? THEN 1 ELSE 0 END) due
         FROM cards c LEFT JOIN states s ON s.card_id = c.id
         WHERE 1 = 1${clause}
         GROUP BY c.kind ORDER BY c.kind`,
      )
      .all(endOfLocalDay(now), ...params)
      .map((r) => ({ kind: r.kind, total: r.total, seen: r.seen, mature: r.mature, due: r.due }));
  },

  /** 未來 N 天的到期量，讓人看得到自己給未來的自己排了多少工作。 */
  upcoming(days = 30, scope = {}, now = new Date()) {
    const [clause, params] = scopeClause(scope);
    const rows = this.db
      .prepare(
        `SELECT s.due due FROM states s JOIN cards c ON c.id = s.card_id
         WHERE s.due <= ?${clause}`,
      )
      .all(new Date(now.getTime() + days * DAY_MS).toISOString(), ...params);
    const today = localDay(now);
    const buckets = new Map();
    let backlog = 0;
    for (const r of rows) {
      const day = localDay(new Date(r.due));
      if (day <= today) backlog += 1;
      else buckets.set(day, (buckets.get(day) ?? 0) + 1);
    }
    const out = [...buckets.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([day, count]) => ({ day, count }));
    return { backlog, days: out };
  },

  /** 所有有狀態的卡，forecast 模擬用。只取數字，不取 payload。 */
  allStates() {
    return this.db.prepare('SELECT card_id, stability, difficulty, due, last_review FROM states').all();
  },
});
