/**
 * 儲存層：不可重建的事實紀錄，加一份隨時可丟的索引。
 *
 *   data/reviews.jsonl  每次作答一行 JSON，只增不改。進版控，十年後用 cat 就讀得懂，
 *                       不依賴本專案還活著。
 *   data/checkins.jsonl CO／PE／PO 三科的手動打卡，同樣只增不改、同樣進版控。
 *                       這三科都有一件卡片記不到的事：CO／PO 根本沒有卡片，
 *                       PE 有卡片但卡片練的是零件，「寫完一整篇 160 字」不會留下任何一筆作答。
 *   data/attempts.jsonl 四科實作練習與模考，同樣只增不改；音檔不會寫進來。
 *   data/cadence.db     SQLite。題庫、FSRS 記憶狀態、統計都在這裡，
 *                       全部可由上面三個檔重算（cadence reindex），不進版控。
 *
 * 這樣切的理由：SQLite 檔壞掉、schema 改版、或這個專案被丟掉，
 * 使用者練了幾百天的紀錄都還在，而且是人看得懂的格式。
 */

import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync, createReadStream, existsSync, mkdirSync, statSync,
  readFileSync, renameSync, writeFileSync,
} from 'node:fs';
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createScheduler } from './engine/fsrs.mjs';
import { CHECKIN_SKILLS } from './engine/today.mjs';

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
  headword TEXT,
  payload  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS cards_kind ON cards(kind, level);
-- 新卡逐題型各取前幾張（見 queue）。沒有它，每次出題 conj 那九千張都要整批排序一次。
CREATE INDEX IF NOT EXISTS cards_fresh ON cards(kind, freq DESC, id);

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
  event_id  TEXT,
  card_id   TEXT NOT NULL,
  at        TEXT NOT NULL,
  day       TEXT NOT NULL,
  rating    INTEGER NOT NULL,
  elapsed   REAL NOT NULL,
  answered  TEXT,
  correct   INTEGER,
  reason    TEXT,
  ms        INTEGER,
  self_rated INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS reviews_card ON reviews(card_id);
CREATE INDEX IF NOT EXISTS reviews_at ON reviews(at);
CREATE INDEX IF NOT EXISTS reviews_day ON reviews(day);

-- data/checkins.jsonl 的鏡像。這三科各有一件事只有「今天做過了」這一個狀態。
-- 一科一天一列，(skill, day) 為主鍵；撤銷是追加一行 done=0，重放時後寫的蓋過先寫的。
CREATE TABLE IF NOT EXISTS checkins (
  skill TEXT NOT NULL,
  day   TEXT NOT NULL,
  done  INTEGER NOT NULL,
  at    TEXT NOT NULL,
  PRIMARY KEY (skill, day)
);
CREATE INDEX IF NOT EXISTS checkins_day ON checkins(day);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const DAY_MS = 86_400_000;

/** 「穩了」的界線：穩定度 ≥ 21 天，照 FSRS 推算三週後還記得的機率仍有 90%。 */
export const MATURE_DAYS = 21;

/**
 * 可以手動打卡的科目，從 engine/today.mjs 的那張科目表算出來，這裡只轉出去。
 *
 * 為什麼不在這裡直接寫一份清單：這個檔負責的是「什麼准寫進 checkins.jsonl」，
 * 而「哪一科需要打卡」是科目本身的性質，答案在那張表上。兩邊各寫一份的話，
 * 哪天那裡多一科而這裡忘了改，前端會給出一顆按下去必定 400 的鍵。
 *
 * 目前是 CO／PE／PO 三科：CO／PO 沒有卡片，PE 有卡片但卡片練不到整篇寫作。
 * CE 不在其中——它的卡片與它要考的事是同一件事。
 */
export { CHECKIN_SKILLS } from './engine/today.mjs';

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
  let reload = false;
  if (!cols.includes('search')) {
    db.exec('ALTER TABLE cards ADD COLUMN search TEXT');
    reload = true;
  }
  if (!cols.includes('headword')) {
    db.exec('ALTER TABLE cards ADD COLUMN headword TEXT');
    reload = true;
  }
  if (reload) db.exec('DELETE FROM cards');
  db.exec('CREATE INDEX IF NOT EXISTS cards_headword ON cards(headword)');

  // reviews 是可由 JSONL 重建的鏡像，但不能在啟動時清掉；舊資料補 nullable/default 欄位即可。
  const reviewCols = db.prepare('PRAGMA table_info(reviews)').all().map((c) => c.name);
  if (!reviewCols.includes('event_id')) db.exec('ALTER TABLE reviews ADD COLUMN event_id TEXT');
  if (!reviewCols.includes('self_rated')) db.exec('ALTER TABLE reviews ADD COLUMN self_rated INTEGER NOT NULL DEFAULT 0');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS reviews_event ON reviews(event_id) WHERE event_id IS NOT NULL');
  // A1 是否出新卡已改由 ACTIVE_CLAUSE 固定規則管理；舊設定若留著會暗中再縮一次範圍。
  db.exec("DELETE FROM settings WHERE key = 'startLevel'");
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

/** 精確查詢排序用。跟全文 search 分開，才不會把中文釋義或整句題幹誤當詞頭。 */
function searchHeadword(card) {
  const f = card.front ?? {};
  return f.word ?? f.verb ?? f.connector ?? f.base ?? card.answer ?? '';
}

const USER_SETTINGS = ['desiredRetention', 'dailyNewLimit', 'examDate'];

/**
 * 日常學習的單字等級。A1 的單字已經會了，不再出新卡（2026-09-24 使用者決定）。
 * 但這條只管「新單字」：變位題不看動詞等級——être、avoir 被 FLELex 標成 A1，
 * 照等級切的話最常用的動詞一個都練不到；已經學過的 A1 卡也照常到期，
 * 否則實測有 66 張到期卡從 09-12 起就一直藏著沒出現。
 * B2 於 2026-09-26 加入（lexicon/ 補齊 FLELex 5,068 個 B2 實詞）。新卡照 freq 排，
 * 不照等級：terme、réseau、désormais 這類高頻 B2 字比很多 B1 字常用，實測前 300 張新卡裡 B2 佔 16 張。
 */
export const ACTIVE_LEVELS = ['A2', 'B1', 'B2'];

/** scope.active 時接在 WHERE 後面的條件。c 是 cards。 */
const ACTIVE_CLAUSE = `(c.kind = 'conj' OR c.level IN (${ACTIVE_LEVELS.map(() => '?').join(',')})
  OR EXISTS (SELECT 1 FROM states x WHERE x.card_id = c.id))`;

export class Store {
  /**
   * @param {string} dataDir 專案的 data/ 目錄
   */
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.jsonlPath = path.join(dataDir, 'reviews.jsonl');
    this.checkinPath = path.join(dataDir, 'checkins.jsonl');
    this.dbPath = path.join(dataDir, 'cadence.db');
    this.settingsPath = path.join(dataDir, 'settings.json');
    this.bankDir = path.join(dataDir, 'bank');
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec(SCHEMA);
    migrate(this.db);
    this.restoreUserSettings();
    this.scheduler = createScheduler({ desiredRetention: this.desiredRetention });
  }

  close() {
    this.db.close();
  }

  // ---- 設定 -------------------------------------------------------------

  /**
   * cadence.db 可以整個刪掉重建，所以使用者設定另存成一份小 JSON。
   * 舊版只有 DB 時先匯出一次；已有檔案時則以檔案為準把索引補回來。
   */
  restoreUserSettings() {
    const upsert = this.db.prepare(
      'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    if (existsSync(this.settingsPath)) {
      let saved;
      try {
        saved = JSON.parse(readFileSync(this.settingsPath, 'utf8'));
      } catch (err) {
        throw new Error(`讀不到 ${this.settingsPath}：${err.message}`);
      }
      for (const key of USER_SETTINGS) {
        if (Object.hasOwn(saved, key)) upsert.run(key, JSON.stringify(saved[key]));
      }
      // 舊檔的 startLevel 已無效；讀到時順手正規化，避免備份繼續攜帶幽靈設定。
      if (Object.hasOwn(saved, 'startLevel')) this.writeUserSettings();
      return;
    }

    const hasOldSettings = USER_SETTINGS.some((key) => this.db.prepare('SELECT 1 FROM settings WHERE key = ?').get(key));
    if (hasOldSettings) this.writeUserSettings();
  }

  writeUserSettings() {
    const saved = {
      desiredRetention: this.get('desiredRetention', 0.9),
      dailyNewLimit: this.get('dailyNewLimit', 15),
      examDate: this.get('examDate', null),
    };
    const temp = `${this.settingsPath}.tmp`;
    writeFileSync(temp, `${JSON.stringify(saved, null, 2)}\n`, 'utf8');
    renameSync(temp, this.settingsPath);
  }

  get(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : fallback;
  }

  set(key, value) {
    this.db
      .prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
    if (USER_SETTINGS.includes(key)) this.writeUserSettings();
    if (key === 'desiredRetention') {
      this.scheduler = createScheduler({ desiredRetention: value });
    }
  }

  get desiredRetention() {
    return this.get('desiredRetention', 0.9);
  }

  /** 每日新卡上限。null 代表不設上限——存成 null 而不是一個很大的數，畫面才知道要改說法。 */
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
    this.lexiconCache = null;
    const insert = this.db.prepare(
      'INSERT INTO cards(id, kind, mode, level, freq, tags, answer, accept, search, headword, payload) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
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
          searchHeadword(c),
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
      type: 'review',
      id: randomUUID(),
      card: input.cardId,
      at: at.toISOString(),
      day: localDay(at),
      rating: input.rating,
      elapsed: Number(elapsed.toFixed(6)),
      answered: input.answered ?? null,
      correct: input.correct ?? null,
      reason: input.reason ?? null,
      ms: input.ms ?? null,
      selfRated: input.selfRated === true,
    };
    appendFileSync(this.jsonlPath, `${JSON.stringify(entry)}\n`, 'utf8');

    this.applyReview(entry);
    return { ...this.state(input.cardId), eventId: entry.id };
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
    // reindex 外面已經有一層交易，SAVEPOINT 在兩種情況都能用；其中一張表寫失敗時，
    // 另一張也必須退回，否則即時畫面會拿到一份 JSONL 與兩張索引彼此矛盾的狀態。
    this.db.exec('SAVEPOINT apply_review');
    try {
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
        .prepare('INSERT INTO reviews(event_id, card_id, at, day, rating, elapsed, answered, correct, reason, ms, self_rated) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(
          entry.id ?? null, entry.card, entry.at, entry.day ?? localDay(new Date(entry.at)), entry.rating, entry.elapsed,
          entry.answered ?? null,
          entry.correct === null || entry.correct === undefined ? null : Number(entry.correct),
          entry.reason ?? null, entry.ms ?? null, entry.selfRated ? 1 : 0,
        );
      this.db.exec('RELEASE apply_review');
    } catch (err) {
      this.db.exec('ROLLBACK TO apply_review');
      this.db.exec('RELEASE apply_review');
      throw err;
    }
    return next;
  }

  state(cardId) {
    return this.db.prepare('SELECT * FROM states WHERE card_id = ?').get(cardId) ?? null;
  }

  /** 假設現在給 1..4 分，各會排到幾天後。算法與 review() 相同，但不寫紀錄也不動索引。 */
  previewIntervals(cardId, at = new Date()) {
    const prev = this.state(cardId);
    const elapsed = prev ? (at - new Date(prev.last_review)) / DAY_MS : 0;
    const base = prev ? { stability: prev.stability, difficulty: prev.difficulty } : null;
    return [1, 2, 3, 4].map((r) => this.scheduler.review(base, r, elapsed).intervalDays);
  }

  /**
   * 更正剛才的人工評分。更正本身也是一行事件；重放時用最新更正覆蓋該筆的評分，
   * 因而不會多算一次作答，也不必回頭改掉已存在的 JSONL。
   */
  async correctReview({ id, rating }) {
    if (!id) throw new Error('缺少要更正的作答 id');
    if (!Number.isInteger(rating) || rating < 1 || rating > 4) throw new Error('rating 必須是 1..4 的整數');
    const latest = this.db.prepare('SELECT event_id, card_id, self_rated FROM reviews ORDER BY seq DESC LIMIT 1').get();
    if (!latest || latest.event_id !== id) throw new Error('只能更正剛才那一筆作答');
    if (latest.self_rated !== 1) throw new Error('自動批改的答案不能改成人工評分');
    const entry = { v: 2, type: 'rating-correction', id: randomUUID(), target: id, rating, at: new Date().toISOString() };
    appendFileSync(this.jsonlPath, `${JSON.stringify(entry)}\n`, 'utf8');
    const rebuilt = await this.reindex();
    const state = this.state(latest.card_id);
    return {
      id: entry.id, target: id, rating,
      state: {
        stability: state.stability, difficulty: state.difficulty, due: state.due,
        reps: state.reps, lapses: state.lapses,
        intervalDays: Math.round((new Date(state.due) - new Date(state.last_review)) / DAY_MS),
      },
      rebuilt: rebuilt.applied,
    };
  }

  // ---- CO／PE／PO 的手動打卡 ---------------------------------------------
  //
  // CO／PO 沒有卡片：題庫裡沒有音檔，也沒有東西能判斷一段口說講得好不好。
  // PE 有卡片，但那些卡練的是零件，考的是 45 分鐘寫成一篇 160 字，
  // 那一篇寫了沒有，卡片的紀錄裡看不出來。
  // 系統評量不了「做得如何」，但「今天做了沒有」是使用者自己知道的事，
  // 而它不寫下來就會消失——隔天翻不出任何痕跡，等於昨天沒發生過。
  //
  // **為什麼另開一個檔，不塞進 reviews.jsonl**：那個檔的每一行都必須對應一張卡，
  // reindex 會拿 rating 去跑 FSRS。塞一行沒有卡片的紀錄進去，不是重建時報錯，
  // 就是憑空產生一份假的記憶狀態。
  //
  // **為什麼不存進 settings**：settings 在 cadence.db 裡，那個檔隨時可以刪掉重建。
  // 打卡紀錄重建不出來，等級與 reviews.jsonl 相同，所以走同一套辦法：
  // JSONL 是事實，SQLite 只是查得快的鏡像。
  //
  // **撤銷也是追加**：按錯了就再寫一行 done:false，同一科同一天以最後一行為準。
  // 不回頭改既有的行，理由與 reviews.jsonl 一樣——事實檔只增不改。

  /**
   * 記一次打卡。與 review() 同樣是先寫 JSONL 再更新索引。
   * @param {{skill:string, day?:string, done?:boolean, at?:Date}} input
   */
  checkin(input) {
    if (!CHECKIN_SKILLS.includes(input.skill)) {
      throw new Error(`不是可打卡的科目：${input.skill}`);
    }
    const at = input.at ?? new Date();
    const entry = {
      v: 1,
      skill: input.skill,
      day: input.day ?? localDay(at),
      done: input.done !== false,
      at: at.toISOString(),
    };
    appendFileSync(this.checkinPath, `${JSON.stringify(entry)}\n`, 'utf8');
    this.applyCheckin(entry);
    return entry;
  }

  /** 把一筆打卡套進索引。reindex 會照檔案順序重跑，所以後寫的自然蓋過先寫的。 */
  applyCheckin(entry) {
    this.db
      .prepare(
        `INSERT INTO checkins(skill, day, done, at) VALUES(?,?,?,?)
         ON CONFLICT(skill, day) DO UPDATE SET done = excluded.done, at = excluded.at`,
      )
      .run(entry.skill, entry.day, entry.done ? 1 : 0, entry.at);
  }

  /**
   * 一科的打卡狀況。
   * recent 是「最近 window 天裡打了幾天」——它要回答的是隔天早上那個問題：
   * 昨天到底做了沒有。單看今天有沒有打卡答不了這件事。
   */
  checkinSummary(skill, { window = 7, now = new Date() } = {}) {
    const today = localDay(now);
    const from = localDay(new Date(now.getTime() - (window - 1) * DAY_MS));
    const recent = this.db
      .prepare('SELECT COUNT(*) n FROM checkins WHERE skill = ? AND done = 1 AND day BETWEEN ? AND ?')
      .get(skill, from, today).n;
    const last = this.db
      .prepare('SELECT day FROM checkins WHERE skill = ? AND done = 1 ORDER BY day DESC LIMIT 1')
      .get(skill);
    const row = this.db
      .prepare('SELECT done FROM checkins WHERE skill = ? AND day = ?')
      .get(skill, today);
    return { done: row?.done === 1, lastDay: last?.day ?? null, recent, window };
  }

  /** 每一科各一份，給 /api/today 用。 */
  checkinState(opts = {}) {
    return Object.fromEntries(CHECKIN_SKILLS.map((s) => [s, this.checkinSummary(s, opts)]));
  }

  /**
   * 從作答與打卡兩個 JSONL 重算各自索引；attempts.jsonl 由 attempts.mjs 接著重建。
   * 壞掉的行不會讓整個重建失敗，會被計數回報——寧可救回 99% 也不要全丟。
   */
  async reindex(onProgress = () => {}) {
    this.db.exec('DELETE FROM states');
    this.db.exec('DELETE FROM reviews');
    this.db.exec('DELETE FROM checkins');
    const reviews = await this.reindexReviews(onProgress);
    const checkins = await this.replayFile(this.checkinPath, (entry) => {
      if (!entry.skill || !entry.day) throw new Error('缺必要欄位');
      this.applyCheckin(entry);
    });
    return {
      applied: reviews.applied,
      corrections: reviews.corrections,
      checkins: checkins.applied,
      skipped: reviews.skipped + checkins.skipped,
      bad: [...reviews.bad, ...checkins.bad.map((b) => ({ ...b, file: 'checkins.jsonl' }))],
    };
  }

  /** reviews.jsonl 同時容納作答與後寫的評分更正，先折疊更正再照原順序重放作答。 */
  async reindexReviews(onProgress = () => {}) {
    const journal = await readReviewEvents(this.jsonlPath);
    this.db.exec('BEGIN');
    let applied = 0;
    try {
      for (const item of journal.reviews) {
        try {
          const correction = journal.corrections.get(item.entry.id);
          const entry = correction
            ? { ...item.entry, rating: correction.rating, correct: correction.rating > 1 }
            : item.entry;
          this.applyReview(entry);
          applied += 1;
          if (applied % 500 === 0) onProgress(applied);
        } catch (err) {
          journal.bad.push({ line: item.line, error: err.message });
        }
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return { applied, corrections: journal.corrections.size, skipped: journal.bad.length, bad: journal.bad };
  }

  /** 逐行重放一個 JSONL。檔案不存在視為零行，不是錯誤——打卡檔要等第一次打卡才出現。 */
  async replayFile(file, apply, onProgress = () => {}) {
    if (!existsSync(file)) return { applied: 0, skipped: 0, bad: [] };
    const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
    let applied = 0;
    let lineNo = 0;
    const bad = [];
    this.db.exec('BEGIN');
    try {
      for await (const line of rl) {
        lineNo += 1;
        if (!line.trim()) continue;
        try {
          apply(JSON.parse(line));
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

  /** 作答與打卡事實檔的體積與行數，doctor 用。 */
  journalInfo() {
    if (!existsSync(this.jsonlPath)) return { exists: false, bytes: 0 };
    return { exists: true, bytes: statSync(this.jsonlPath).size };
  }

  checkinInfo() {
    if (!existsSync(this.checkinPath)) return { exists: false, bytes: 0 };
    return { exists: true, bytes: statSync(this.checkinPath).size };
  }

  /**
   * 逐筆核對 reviews.jsonl 與 SQLite 鏡像。只比行數抓不到「少一筆又多一筆」的等量錯列，
   * 所以連欄位與順序一起比；bad 保留原始行號，讓 doctor 能直接指出修復位置。
   */
  async auditJournal() {
    const info = this.journalInfo();
    const indexed = this.db
      .prepare('SELECT card_id, at, day, rating, elapsed, answered, correct, reason, ms FROM reviews ORDER BY seq')
      .all();
    const journal = await readReviewEvents(this.jsonlPath);
    const expected = journal.reviews.map(({ line, entry }) => {
      const correction = journal.corrections.get(entry.id);
      const effective = correction ? { ...entry, rating: correction.rating, correct: correction.rating > 1 } : entry;
      return { line, row: reviewMirror(effective) };
    });

    const at = firstRowDifference(expected.map((x) => x.row), indexed);
    return {
      ...info,
      lines: journal.lines,
      valid: expected.length,
      corrections: journal.corrections.size,
      indexed: indexed.length,
      bad: journal.bad,
      mismatchAt: at === null ? null : (expected[at]?.line ?? at + 1),
      inSync: journal.bad.length === 0 && at === null,
    };
  }

  /** checkins.jsonl 是事件流，先按最後一筆折疊，再與 SQLite 的當日狀態逐列比對。 */
  async auditCheckins() {
    const info = this.checkinInfo();
    const folded = new Map();
    const bad = [];
    let lines = 0;

    if (info.exists) {
      const rl = createInterface({ input: createReadStream(this.checkinPath, 'utf8'), crlfDelay: Infinity });
      let lineNo = 0;
      for await (const line of rl) {
        lineNo += 1;
        if (!line.trim()) continue;
        lines += 1;
        try {
          const entry = JSON.parse(line);
          if (!entry.skill || !entry.day || !entry.at) throw new Error('缺必要欄位');
          const row = {
            skill: String(entry.skill), day: String(entry.day),
            done: entry.done === false ? 0 : 1, at: String(entry.at),
          };
          folded.set(`${row.skill}\0${row.day}`, row);
        } catch (err) {
          bad.push({ line: lineNo, error: err.message });
        }
      }
    }

    const expected = [...folded.values()].sort((a, b) => binaryCompare(a.skill, b.skill) || binaryCompare(a.day, b.day));
    const indexed = this.db.prepare('SELECT skill, day, done, at FROM checkins ORDER BY skill, day').all();
    const at = firstRowDifference(expected, indexed);
    return {
      ...info,
      lines,
      valid: lines - bad.length,
      states: expected.length,
      indexed: indexed.length,
      bad,
      mismatchAt: at === null ? null : at + 1,
      inSync: bad.length === 0 && at === null,
    };
  }

  /** 題庫檔、meta 計數與 SQLite payload 三邊對帳，筆數相同但卡片被換掉也會被抓到。 */
  async auditBank(meta = null) {
    const cards = JSON.parse(await readFile(path.join(this.bankDir, 'cards.json'), 'utf8'));
    const expected = cards
      .map((card) => ({ id: String(card.id), payload: JSON.stringify(card) }))
      .sort((a, b) => binaryCompare(a.id, b.id));
    const indexed = this.db.prepare('SELECT id, payload FROM cards ORDER BY id').all();
    const at = firstRowDifference(expected, indexed);
    const metaCards = meta?.counts?.cards ?? null;
    return {
      cards: cards.length,
      metaCards,
      indexed: indexed.length,
      mismatchAt: at === null ? null : at + 1,
      inSync: at === null && (metaCards === null || metaCards === cards.length),
    };
  }
}

/** 讀完整條作答事件流；更正只能指向前面一筆可人工評分且有 id 的作答。 */
async function readReviewEvents(file) {
  if (!existsSync(file)) return { lines: 0, reviews: [], corrections: new Map(), bad: [] };
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  const reviews = [];
  const byId = new Map();
  const eventIds = new Set();
  const corrections = new Map();
  const bad = [];
  let lines = 0;
  let lineNo = 0;
  for await (const line of rl) {
    lineNo += 1;
    if (!line.trim()) continue;
    lines += 1;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'rating-correction') {
        if (!entry.id || !entry.target || !entry.at || !Number.isInteger(entry.rating)
          || entry.rating < 1 || entry.rating > 4) throw new Error('評分更正缺必要欄位');
        if (eventIds.has(entry.id)) throw new Error('事件 id 重複');
        const target = byId.get(entry.target);
        if (!target) throw new Error('評分更正找不到原作答');
        if (!target.selfRated) throw new Error('評分更正只能套用到人工評分');
        eventIds.add(entry.id);
        corrections.set(entry.target, entry);
        continue;
      }
      if (!entry.card || !entry.at || !entry.rating || !Number.isFinite(Number(entry.elapsed))) {
        throw new Error('缺必要欄位');
      }
      if (entry.id && eventIds.has(entry.id)) throw new Error('事件 id 重複');
      if (entry.id) {
        eventIds.add(entry.id);
        byId.set(entry.id, entry);
      }
      reviews.push({ line: lineNo, entry });
    } catch (err) {
      bad.push({ line: lineNo, error: err.message });
    }
  }
  return { lines, reviews, corrections, bad };
}

function reviewMirror(entry) {
  return {
    card_id: String(entry.card),
    at: String(entry.at),
    day: String(entry.day ?? localDay(new Date(entry.at))),
    rating: Number(entry.rating),
    elapsed: Number(entry.elapsed),
    answered: entry.answered ?? null,
    correct: entry.correct === null || entry.correct === undefined ? null : Number(entry.correct),
    reason: entry.reason ?? null,
    ms: entry.ms ?? null,
  };
}

function firstRowDifference(expected, actual) {
  const n = Math.max(expected.length, actual.length);
  for (let i = 0; i < n; i += 1) {
    if (JSON.stringify(expected[i] ?? null) !== JSON.stringify(actual[i] ?? null)) return i;
  }
  return null;
}

/** SQLite 預設 BINARY collation；localeCompare 會把 accéder 排到 accueillir 前面，不能拿來對帳。 */
function binaryCompare(a, b) {
  return a < b ? -1 : (a > b ? 1 : 0);
}

// ---- 出題佇列 -----------------------------------------------------------
//
// 排序邏輯刻意寫在 SQL 裡：16,401 張卡若先撈進 JS 再篩，每次出題都要動到幾 MB
// 的物件；交給 SQLite 走索引，記憶體佔用與題庫大小無關。

/** 建立 kind / level 的 WHERE 片段。回傳 [sql, params]。 */
export function scopeClause(scope = {}) {
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
  // 側欄明確勾了等級就只照勾的；沒勾才套日常範圍（見 ACTIVE_LEVELS）。
  if (scope.active && !scope.levels?.length) {
    where.push(ACTIVE_CLAUSE);
    params.push(...ACTIVE_LEVELS);
  }
  return [where.length ? ` AND ${where.join(' AND ')}` : '', params];
}

/**
 * 看字回想與中翻法是同一個字的兩面（id 只差結尾的 |r／|p）。兩條題型各按頻率排，
 * 同一個高頻字在兩條都排第一，輪流取就會一前一後貼著出——第二張的答案就寫在第一張上。
 */
const SIBLING_WINDOW = 4;
const siblingKey = (card) => (card.kind === 'vocab-recall' || card.kind === 'vocab-produce'
  ? card.id.replace(/\|[rp]$/, '')
  : card.id);

/**
 * 中翻法的新卡要等同一個字的看字回想答過至少一次才放出來（2026-09-11 使用者決定）。
 * 實測第一次見到的字直接考中翻法，答對率只有 38–40%：還沒認得這個字就要拼出來。
 * 接在 WHERE 後面用，c 是 cards。同一個字若根本沒有 |r 卡，不擋，否則那張 |p 永遠出不來。
 * 側欄只勾中翻法時也照擋——順序是這個決定本身，不是範圍的問題。
 */
const PRODUCE_GATE = ` AND (c.kind <> 'vocab-produce' OR c.id NOT LIKE '%|p'
  OR EXISTS (SELECT 1 FROM states g WHERE g.card_id = substr(c.id, 1, length(c.id) - 1) || 'r')
  OR NOT EXISTS (SELECT 1 FROM cards g2 WHERE g2.id = substr(c.id, 1, length(c.id) - 1) || 'r'))`;

/**
 * 變位新卡的順序（2026-09-24 使用者決定「動詞輪替，一次一個時態」）。
 *
 * 舊版照 freq DESC, id ASC 排：同一個動詞的 36 張卡 freq 相同，於是按 id 的字母序出——
 * être 第一張是條件式（cond 排在 pres 前面），而且要把 être 六個時態全做完才輪到 avoir。
 *
 * 現在的排序鍵是「動詞頻率排名 + 時態序」，時態序依 CONJ_TENSES。同一個鍵值裡先高頻動詞。
 * 效果是一條對角線：être 現在式 → être 複合過去式、avoir 現在式 → être 未完成過去式、avoir 複合過去式、
 * faire 現在式……每一輪多一個新動詞，已經開始的動詞各往下推一個時態，一次一個時態的 6 格。
 *
 * 兩個數都是**絕對**的：排名算的是範圍內所有動詞（含已學完的），時態序也不看還剩哪些。
 * 若改用「剩下的」重算，être 做完現在式後它的下一個時態又變成序 0，
 * 永遠排在 avoir 前面，結果退化成一個動詞整組做完才換下一個。
 * scope 片段出現兩次（動詞排名一次、撈卡一次），參數也要傳兩份。
 */
const CONJ_TENSES = ['pres', 'pc', 'imp', 'fut', 'cond', 'subj'];
// id 不是 c:動詞|時態|人稱 的（測試卡、手寫卡）整個 id 當一個動詞，排序就退回照頻率。
const CONJ_VERB = "CASE WHEN c.id LIKE 'c:%|%' THEN substr(c.id, 3, instr(c.id, '|') - 3) ELSE c.id END";
const CONJ_TENSE_IDX = `CASE ${CONJ_TENSES.map((t, i) => `WHEN c.id LIKE 'c:%|${t}|%' THEN ${i}`).join(' ')} ELSE ${CONJ_TENSES.length} END`;
const CONJ_FRESH_SQL = (clause) => `
  WITH v AS (
    SELECT ${CONJ_VERB} verb, ROW_NUMBER() OVER (ORDER BY MAX(c.freq) DESC, ${CONJ_VERB} ASC) rk
    FROM cards c WHERE c.kind = 'conj'${clause} GROUP BY verb
  )
  SELECT c.payload FROM cards c
  JOIN v ON v.verb = ${CONJ_VERB}
  LEFT JOIN states s ON s.card_id = c.id
  WHERE s.card_id IS NULL AND c.kind = 'conj'${clause}
  ORDER BY v.rk + ${CONJ_TENSE_IDX}, v.rk, ${CONJ_TENSE_IDX}, c.id
  LIMIT ?`;

/**
 * 仍以到期時間／頻率為主序，只在同題型已連續兩張時往後找最近的其他題型。
 * 這樣不會把新卡插到到期卡前面，也不會讓二十張一輪被九千張變位卡整批佔滿。
 * 另外避開最近 SIBLING_WINDOW 張裡出現過的同一個字；找不到才依序退讓：
 * 先只求不緊貼，再退回原本的題型規則。
 */
function limitKindRuns(candidates, limit, seed = []) {
  const pool = [...candidates];
  const out = [];
  let lastKind = null;
  let run = 0;
  for (let i = seed.length - 1; i >= 0 && seed[i].kind === seed.at(-1)?.kind; i -= 1) run += 1;
  if (seed.length) lastKind = seed.at(-1).kind;
  const recent = seed.slice(-SIBLING_WINDOW).map(siblingKey);

  while (out.length < limit && pool.length) {
    const kindOk = (card) => run < 2 || card.kind !== lastKind;
    let at = pool.findIndex((card) => kindOk(card) && !recent.includes(siblingKey(card)));
    if (at < 0) at = pool.findIndex((card) => kindOk(card) && siblingKey(card) !== recent.at(-1));
    if (at < 0) at = run >= 2 ? Math.max(0, pool.findIndex((card) => card.kind !== lastKind)) : 0;
    const [card] = pool.splice(at, 1);
    if (card.kind === lastKind) run += 1;
    else {
      lastKind = card.kind;
      run = 1;
    }
    recent.push(siblingKey(card));
    if (recent.length > SIBLING_WINDOW) recent.shift();
    out.push(card);
  }
  return out;
}

function queueScan(limit) {
  return Math.min(2_000, Math.max(limit, limit * 8));
}

/**
 * 每個題型各排好一條（題型內按頻率），再一輪一張輪流取。
 * 開頭頻率高的題型排在每一輪的前面，所以最常見的詞仍然最先出現。
 */
function interleaveKinds(lanes, limit) {
  const order = lanes
    .filter((lane) => lane.length)
    .sort((a, b) => (b[0].freq ?? 0) - (a[0].freq ?? 0) || a[0].kind.localeCompare(b[0].kind));
  const out = [];
  for (let i = 0; out.length < limit; i += 1) {
    let took = false;
    for (const lane of order) {
      if (i >= lane.length) continue;
      out.push(lane[i]);
      took = true;
      if (out.length >= limit) break;
    }
    if (!took) break;
  }
  return out;
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

  /** 還沒複習過、而且會被拿出來當新卡的數量。 */
  newCount(scope = {}) {
    const [clause, params] = scopeClause(scope);
    return this.db
      .prepare(
        `SELECT COUNT(*) n FROM cards c LEFT JOIN states s ON s.card_id = c.id
         WHERE s.card_id IS NULL${clause}${PRODUCE_GATE}`,
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

    const dueCandidates = this.db
      .prepare(
        `SELECT c.payload, s.due, s.stability, s.difficulty, s.reps, s.lapses
         FROM states s JOIN cards c ON c.id = s.card_id
         WHERE s.due < ?${clause}
         ORDER BY s.due ASC LIMIT ?`,
      )
      .all(endOfLocalDay(now), ...params, queueScan(limit))
      .map((r) => ({ ...JSON.parse(r.payload), state: { due: r.due, stability: r.stability, difficulty: r.difficulty, reps: r.reps, lapses: r.lapses } }));
    const due = limitKindRuns(dueCandidates, limit);

    const room = limit - due.length;
    if (room <= 0) return due;

    // 呼叫端明確傳 newLimit: null 也代表不設上限，所以用 hasOwn 而不是 ??。
    const cap = Object.hasOwn(opts, 'newLimit') ? opts.newLimit : this.dailyNewLimit;
    const budget = cap === null ? Infinity : Math.max(0, cap - this.newIntroducedToday());
    if (budget <= 0) return due;
    const want = Math.min(room, budget);

    // 新卡在題型內按 FLELex 頻率由高到低——先學常見詞，投報率最高。
    // 但**跨題型不能直接比頻率**：連接詞、挑連接詞、改寫三種是手寫題，建卡時 freq 一律是 0。
    // 舊版把全部題型混在一起排，那 213 張卡排在第 12,637 名之後，
    // 每天 15 張的速度要兩年多才輪得到，等於永遠不會出現。所以改成每個題型各取一條再輪流。
    const [freshClause, freshParams] = scopeClause(opts);
    const kinds = this.db
      .prepare(`SELECT DISTINCT c.kind FROM cards c WHERE 1 = 1${freshClause}`)
      .all(...freshParams)
      .map((r) => r.kind);
    const lane = this.db.prepare(
      `SELECT c.payload FROM cards c LEFT JOIN states s ON s.card_id = c.id
       WHERE s.card_id IS NULL AND c.kind = ?${freshClause}${PRODUCE_GATE}
       ORDER BY c.freq DESC, c.id ASC LIMIT ?`,
    );
    const conjLane = this.db.prepare(CONJ_FRESH_SQL(freshClause));
    const lanes = kinds.map((kind) => (kind === 'conj'
      ? conjLane.all(...freshParams, ...freshParams, want)
      : lane.all(kind, ...freshParams, want)
    ).map((r) => ({ ...JSON.parse(r.payload), state: null })));
    const fresh = limitKindRuns(interleaveKinds(lanes, want), want, due);

    return [...due, ...fresh];
  },

  /** 從統計頁開出的有限弱點批次。只取曾答錯的舊卡，不補新卡，也不受到期日限制。 */
  queueWeak(limit = 20, scope = {}) {
    const [clause, params] = scopeClause(scope);
    const candidates = this.db.prepare(
      `SELECT c.payload, s.due, s.stability, s.difficulty, s.reps, s.lapses
       FROM states s JOIN cards c ON c.id = s.card_id
       WHERE s.lapses > 0${clause}
       ORDER BY s.lapses DESC, s.difficulty DESC, s.last_review ASC LIMIT ?`,
    ).all(...params, queueScan(limit)).map((row) => ({
      ...JSON.parse(row.payload),
      state: {
        due: row.due, stability: row.stability, difficulty: row.difficulty,
        reps: row.reps, lapses: row.lapses,
      },
    }));
    return limitKindRuns(candidates, limit);
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
    // 連續天數不吃 scope：「今天有沒有練」是人的事，不是題型的事。
    // 吃 scope 時，側欄縮到只剩看字回想，今天答了 21 題連接詞仍顯示 0 天（2026-09-11 實測）。
    const streak = this.streak({}, now);
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
    // 中翻法尚未解鎖的不算新卡；等級範圍已由 scopeClause 統一處理。
    return this.db
      .prepare(
        `SELECT c.kind,
                COUNT(*) total,
                SUM(CASE WHEN s.card_id IS NOT NULL THEN 1 ELSE 0 END) seen,
                SUM(CASE WHEN s.stability >= 21 THEN 1 ELSE 0 END) mature,
                SUM(CASE WHEN s.due < ? THEN 1 ELSE 0 END) due,
                SUM(CASE WHEN s.card_id IS NULL${PRODUCE_GATE} THEN 1 ELSE 0 END) fresh
         FROM cards c LEFT JOIN states s ON s.card_id = c.id
         WHERE 1 = 1${clause}
         GROUP BY c.kind ORDER BY c.kind`,
      )
      .all(endOfLocalDay(now), ...params)
      .map((r) => ({ kind: r.kind, total: r.total, seen: r.seen, mature: r.mature, due: r.due, fresh: r.fresh }));
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

  // ---- 讀句子、穩了的卡 ------------------------------------------------

  /**
   * 題庫收了哪些字、每個變位形是哪個動詞。今天頁「這句你認得幾個字」用。
   *
   * 算一次約一萬兩千列，存在 instance 上；loadBank() 換題庫時清掉。
   * 字只取看字回想卡：那一頁問的是「讀得懂」，對應的就是看法文說中文那個方向。
   *
   * 變位卡的答案有 1,514 張是兩個字（ai été、me suis levé）。前面那幾個是助動詞或代名詞，
   * 它們自己的變位卡會提供，這裡只取最後一個字（過去分詞）對到這個動詞；
   * 而且先收單字答案再收複合答案，免得 ai 被 avoir été 那張搶去對到 être。
   */
  lexicon() {
    if (this.lexiconCache) return this.lexiconCache;
    const words = new Set(
      this.db
        .prepare("SELECT DISTINCT lower(headword) w FROM cards WHERE kind = 'vocab-recall' AND headword IS NOT NULL")
        .all()
        .map((r) => r.w),
    );
    const verbs = new Map();
    const conj = this.db.prepare("SELECT headword, answer FROM cards WHERE kind = 'conj' AND answer IS NOT NULL").all();
    for (const compound of [false, true]) {
      for (const r of conj) {
        const parts = r.answer.toLowerCase().split(/[\s']+/).filter(Boolean);
        if ((parts.length > 1) !== compound) continue;
        const form = parts.at(-1);
        if (!verbs.has(form)) verbs.set(form, r.headword.toLowerCase());
      }
    }
    this.lexiconCache = {
      has: (w) => words.has(w),
      verbOf: (form) => verbs.get(form) ?? null,
    };
    return this.lexiconCache;
  },

  /**
   * 每個字學到哪。同一個字可能有好幾張看字回想卡（不同詞性），任一張穩了就算穩了、
   * 任一張答過就算學過——讀句子時不會先判斷詞性。
   */
  wordStatus() {
    const rows = this.db
      .prepare(
        `SELECT lower(c.headword) w, MAX(s.stability) stability
         FROM states s JOIN cards c ON c.id = s.card_id
         WHERE c.kind = 'vocab-recall' GROUP BY lower(c.headword)`,
      )
      .all();
    const best = new Map(rows.map((r) => [r.w, r.stability]));
    return (word) => {
      if (!best.has(word)) return 'fresh';
      return best.get(word) >= MATURE_DAYS ? 'mature' : 'seen';
    };
  },

  /**
   * 可以拿來讀的法文句子。
   *
   * 挑連接詞的題目本身就是一句法文，空格藏著答案，放出來不洩題。
   * 改寫整句的法文句子是**解答**，只有那張卡已經答過才放——否則今天頁先讓你讀完解答，
   * 複習頁再考同一題，那題就廢了。
   */
  readingSentences() {
    const rows = this.db
      .prepare(
        `SELECT c.id, c.kind, c.payload, s.card_id IS NOT NULL seen
         FROM cards c LEFT JOIN states s ON s.card_id = c.id
         WHERE c.kind IN ('pick', 'rw') ORDER BY c.kind, c.id`,
      )
      .all();
    const out = [];
    for (const r of rows) {
      const card = JSON.parse(r.payload);
      if (r.kind === 'pick' && card.front?.prompt) {
        out.push({ id: r.id, kind: r.kind, text: card.front.prompt, src: card.front.src ?? null });
      } else if (r.kind === 'rw' && r.seen && card.answer) {
        out.push({ id: r.id, kind: r.kind, text: card.answer, src: card.front?.src ?? null });
      }
    }
    return out;
  },

  /**
   * 最近 days 天內「第一次跨過穩定度 21 天」、而且現在仍在 21 天以上的卡。
   *
   * reviews 表沒存每次作答後的穩定度，只能拿那張卡的作答照順序重跑一次 FSRS 找出跨線那一天。
   * 重跑用的是 reviews 表而不是 JSONL：評分更正已經反映在表上，跟 states 算出來的是同一條路徑。
   * 候選只有現在穩定度 ≥ 21 的卡，所以要重跑的量很小（2026-09-16 真實資料只有 1 張）。
   *
   * 中途忘記又重新穩回來的卡，算的是**第一次**跨線：它在窗口之前就穩過一次，這週不是「剛學會」。
   */
  maturedRecently({ days = 7, now = new Date() } = {}) {
    const from = new Date(now);
    from.setDate(from.getDate() - (days - 1));
    const fromDay = localDay(from);
    const candidates = this.db
      .prepare(
        `SELECT s.card_id, s.stability, c.kind, c.headword, c.answer, c.payload
         FROM states s JOIN cards c ON c.id = s.card_id
         WHERE s.stability >= ?`,
      )
      .all(MATURE_DAYS);
    const history = this.db.prepare('SELECT at, day, rating, elapsed FROM reviews WHERE card_id = ? ORDER BY seq');
    const out = [];
    for (const c of candidates) {
      let prev = null;
      let crossed = null;
      for (const r of history.all(c.card_id)) {
        prev = this.scheduler.review(prev, r.rating, r.elapsed);
        if (prev.stability >= MATURE_DAYS) {
          crossed = r;
          break;
        }
      }
      if (!crossed || crossed.day < fromDay) continue;
      out.push({
        id: c.card_id,
        kind: c.kind,
        headword: c.headword,
        answer: c.answer,
        card: JSON.parse(c.payload),
        day: crossed.day,
        at: crossed.at,
        stability: c.stability,
      });
    }
    return out.sort((a, b) => (a.at < b.at ? 1 : -1));
  },

  /** 最近 days 天（含今天）一共答了幾題。今天頁的推演拿它當「照這個節奏」的節奏。 */
  reviewsSince({ days = 7, now = new Date() } = {}) {
    const from = new Date(now);
    from.setDate(from.getDate() - (days - 1));
    return this.db.prepare('SELECT COUNT(*) n FROM reviews WHERE day >= ?').get(localDay(from)).n;
  },

  /** 所有有狀態的卡，forecast 模擬用。只取數字，不取 payload。 */
  allStates() {
    return this.db.prepare('SELECT card_id, stability, difficulty, due, last_review FROM states').all();
  },
});
