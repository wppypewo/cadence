/**
 * 考前推演：把「到那天我大概記得多少」算出來。
 *
 * 這是人腦真的做不到的部分。16,000 張卡各自有自己的穩定度與到期日，
 * 遺忘曲線是冪律不是直線，今天多做 10 張會在三週後變成多少複習量——
 * 這種東西沒有辦法憑感覺估。這支模組就是拿已驗證的 FSRS-6 引擎，
 * 從今天一路模擬到考試那天。
 *
 * 明確聲明模型的假設，因為推演結果只在假設成立時才有意義：
 *
 *  1. 每張卡在模擬中只走一條路徑，成功與否由該卡當下的可提取度 R 決定，
 *     用固定種子的偽隨機數抽樣。卡片數以千計，抽樣誤差會自然被平均掉。
 *  2. 答對時給什麼評分，優先用使用者自己的歷史分布；沒有足夠歷史時
 *     一律當成 Good，並在輸出裡標明 `ratingModel: 'assumed-good'`。
 *     這裡刻意不套用任何來路不明的預設分布。
 *  3. 每天的複習量有上限。超出上限的到期卡會累積到隔天，
 *     這正是「臨時抱佛腳為什麼會崩」的機制。
 *  4. 不模擬使用者中斷、生病、忘記打開這個 App。推演是上限不是預測。
 */

import { createScheduler, RATING } from './fsrs.mjs';

const DAY_MS = 86_400_000;

/** 固定種子的 PRNG（mulberry32）。同樣的輸入必須得到同樣的推演結果。 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 從歷史紀錄推出「答對時給幾分」的分布。
 * 樣本不足時回傳 null，呼叫端就退回「一律 Good」。
 */
export function ratingDistribution(rows, minSample = 50) {
  const counts = { 2: 0, 3: 0, 4: 0 };
  let total = 0;
  for (const r of rows) {
    if (r.rating >= 2 && r.rating <= 4) {
      counts[r.rating] += 1;
      total += 1;
    }
  }
  if (total < minSample) return null;
  return { hard: counts[2] / total, good: counts[3] / total, easy: counts[4] / total, sample: total };
}

/** 各題型分開估計；樣本不足的題型回退到全體分布。 */
export function ratingModel(rows, minKindSample = 20, minGlobalSample = 50) {
  const byKind = {};
  for (const kind of new Set(rows.map((row) => row.kind).filter(Boolean))) {
    const distribution = ratingDistribution(rows.filter((row) => row.kind === kind), minKindSample);
    if (distribution) byKind[kind] = distribution;
  }
  return { default: ratingDistribution(rows, minGlobalSample), byKind };
}

/** 一個題型要有幾張卡的首次作答，才用實測分布取代 Good。推演頁照這個數說明缺多少。 */
export const FIRST_RATING_MIN = 30;

/**
 * 新卡第一次評分包含 Again；只有足夠樣本才取代保守的 Good 假設。
 * 呼叫端應傳入每張卡最早的一筆有效評分，而不是所有複習。
 */
export function firstRatingModel(rows, minKindSample = FIRST_RATING_MIN) {
  const byKind = {};
  for (const kind of new Set(rows.map((row) => row.kind).filter(Boolean))) {
    const items = rows.filter((row) => row.kind === kind && row.rating >= 1 && row.rating <= 4);
    if (items.length < minKindSample) continue;
    const counts = { 1: 0, 2: 0, 3: 0, 4: 0 };
    for (const row of items) counts[row.rating] += 1;
    byKind[kind] = {
      again: counts[1] / items.length,
      hard: counts[2] / items.length,
      good: counts[3] / items.length,
      easy: counts[4] / items.length,
      sample: items.length,
    };
  }
  return { byKind };
}

/**
 * 一次考前推演。
 *
 * @param {object} opts
 * @param {Array<{id:string, level?:string, stability?:number, difficulty?:number, due?:string,locked?:boolean,prerequisite?:string}>} opts.cards
 *        在範圍內的卡。沒有 state 的卡就是還沒學過的新卡。
 * @param {Date}   opts.from        起算日
 * @param {Date}   opts.examDate    考試日
 * @param {number} opts.dailyLimit  每天最多做幾張（含新卡）
 * @param {number} opts.dailyNew    每天最多學幾張新卡
 * @param {number} opts.desiredRetention
 * @param {{hard:number,good:number,easy:number}|{default:Object?,byKind:Object}|null} opts.ratings
 * @param {{byKind:Object}|null} opts.firstRatings 新卡第一次評分分布
 * @param {number} opts.secondsPerCard 每張卡的平均作答秒數，用來換算時間成本
 * @param {Object<string,number>} [opts.secondsByKind] 各題型作答秒數
 */
export function simulate(opts) {
  const scheduler = createScheduler({ desiredRetention: opts.desiredRetention ?? 0.9 });
  const from = startOfDay(opts.from ?? new Date());
  const exam = startOfDay(opts.examDate);
  const totalDays = Math.max(0, Math.round((exam - from) / DAY_MS));
  const dailyLimit = opts.dailyLimit ?? 60;
  const dailyNew = opts.dailyNew ?? 15;
  const rnd = mulberry32(opts.seed ?? 0x5eed);
  const ratings = opts.ratings ?? null;
  const firstRatings = opts.firstRatings ?? null;
  const secondsPerCard = opts.secondsPerCard ?? null;
  const secondsByKind = opts.secondsByKind ?? {};

  // 卡片狀態的可變副本。不動呼叫端傳進來的物件。
  const seen = [];
  const fresh = [];
  // locked：還沒學過、但低於起始等級，出題時永遠不會拿出來的卡。
  // 它們留在分母裡（考試照樣會考），只是不排進新卡隊伍，考試那天算成沒學過。
  let locked = 0;
  for (const c of opts.cards) {
    if (c.stability != null && c.difficulty != null) {
      seen.push({ id: c.id, kind: c.kind, level: c.level, s: c.stability, d: c.difficulty, due: startOfDay(new Date(c.due)).getTime(), last: new Date(c.due).getTime() });
    } else if (c.locked) {
      locked += 1;
    } else {
      fresh.push({ id: c.id, kind: c.kind, level: c.level, prerequisite: c.prerequisite ?? null, s: null, d: null, due: null, last: null });
    }
  }
  // 到期早的先做。逾期越久的卡遺忘越深，優先處理。
  seen.sort((a, b) => a.due - b.due);

  const days = [];
  const seenIds = new Set(seen.map((card) => card.id));
  const available = [];
  const pending = new Map();
  for (const card of fresh) {
    if (!card.prerequisite || seenIds.has(card.prerequisite)) available.push(card);
    else pending.set(card.prerequisite, [...(pending.get(card.prerequisite) ?? []), card]);
  }
  let availableIdx = 0;
  let freshRemaining = fresh.length;
  let backlogPeak = 0;
  let totalReviews = 0;
  let totalLapses = 0;

  for (let dayNo = 0; dayNo <= totalDays; dayNo += 1) {
    const dayStart = from.getTime() + dayNo * DAY_MS;
    const dayEnd = dayStart + DAY_MS;

    // 今天到期（含逾期）的卡。
    const dueToday = seen.filter((c) => c.due < dayEnd);
    const overdue = dueToday.length;
    const doing = dueToday.slice(0, dailyLimit);
    const deferred = overdue - doing.length;
    backlogPeak = Math.max(backlogPeak, deferred);

    let lapsesToday = 0;
    for (const card of doing) {
      const elapsed = (dayStart - card.last) / DAY_MS;
      const r = scheduler.retrievability(card.s, Math.max(0, elapsed));
      const rating = rnd() < r ? successRating(modelFor(ratings, card.kind), rnd) : RATING.AGAIN;
      if (rating === RATING.AGAIN) lapsesToday += 1;
      const next = scheduler.review({ stability: card.s, difficulty: card.d }, rating, Math.max(0, elapsed));
      card.s = next.stability;
      card.d = next.difficulty;
      card.last = dayStart;
      card.due = dayStart + next.intervalDays * DAY_MS;
    }

    // 剩餘額度拿來學新卡。已有足夠的同題型首次作答時照實抽樣，否則用 Good；
    // 不能拿大量、較容易的認讀紀錄替名詞化或改寫假設第一次就會答對。
    const room = Math.min(dailyLimit - doing.length, dailyNew);
    let learned = 0;
    let learnedSeconds = 0;
    while (availableIdx < available.length && learned < room) {
      const card = available[availableIdx];
      availableIdx += 1;
      freshRemaining -= 1;
      const firstRating = anyRating(modelFor(firstRatings, card.kind), rnd);
      if (firstRating === RATING.AGAIN) lapsesToday += 1;
      const next = scheduler.review(null, firstRating, 0);
      card.s = next.stability;
      card.d = next.difficulty;
      card.last = dayStart;
      card.due = dayStart + next.intervalDays * DAY_MS;
      seen.push(card);
      learnedSeconds += secondsByKind[card.kind] ?? secondsPerCard ?? 0;
      seenIds.add(card.id);
      const unlocked = pending.get(card.id);
      if (unlocked) {
        available.push(...unlocked);
        pending.delete(card.id);
      }
      learned += 1;
    }

    const count = doing.length + learned;
    const secondsToday = secondsPerCard == null ? null
      : doing.reduce((sum, card) => sum + (secondsByKind[card.kind] ?? secondsPerCard), learnedSeconds);
    totalReviews += count;
    totalLapses += lapsesToday;
    days.push({
      day: isoDay(new Date(dayStart)),
      due: overdue,
      reviews: doing.length,
      learned,
      deferred,
      lapses: lapsesToday,
      minutes: secondsToday == null ? null : Math.round(secondsToday / 60),
    });
    seen.sort((a, b) => a.due - b.due);
  }

  // 考試當天：把每張卡的可提取度算出來，加總就是期望答對數。
  const examTime = exam.getTime();
  let expectedRecall = 0;
  let studiedCount = 0;
  const buckets = { strong: 0, shaky: 0, weak: 0, untouched: freshRemaining + locked };
  // B2 與 B1 以下分開記（2026-10-12 使用者決定）：B2 一萬多張到考試前大多輪不到，
  // 跟 B1 以下混在同一個分母裡，「輪不到」那個數幾乎全是 B2，看不出 B1 以下還差多少。
  const levels = { core: levelGroup(), b2: levelGroup() };
  for (const c of opts.cards) levels[groupOf(c.level)].cards += 1;
  for (const card of seen) {
    if (card.s == null) continue;
    studiedCount += 1;
    const r = scheduler.retrievability(card.s, Math.max(0, (examTime - card.last) / DAY_MS));
    expectedRecall += r;
    const group = levels[groupOf(card.level)];
    group.studied += 1;
    group.expectedRecall += r;
    if (r >= 0.9) buckets.strong += 1;
    else if (r >= 0.7) buckets.shaky += 1;
    else buckets.weak += 1;
  }

  const inScope = opts.cards.length;
  return {
    examDate: isoDay(exam),
    daysUntilExam: totalDays,
    cardsInScope: inScope,
    ratingModel: hasObserved(ratings) ? 'observed' : 'assumed-good',
    dailyLimit,
    dailyNew,
    days,
    peakDay: days.reduce((best, d) => (d.reviews + d.learned > best.reviews + best.learned ? d : best), days[0] ?? null),
    backlogPeak,
    totalReviews,
    totalLapses,
    // 期望值，不是保證值。分母用範圍內全部的卡，沒學到的卡算 0 分。
    expectedRecall,
    expectedRecallRate: inScope ? expectedRecall / inScope : 0,
    // 分母只算考試前學過的卡。目標比的是這個：全範圍比例在 1.6 萬張卡、
    // 半年的期限下最高只到一成多，拿它當及格線，每個設定都會顯示「達不到」。
    learnedRecallRate: studiedCount ? expectedRecall / studiedCount : 0,
    studiedByExam: studiedCount,
    coverage: inScope ? studiedCount / inScope : 0,
    buckets,
    // 沒學到的＝這組的卡數減掉考前學過的（含 locked），與 buckets.untouched 同口徑。
    levels: Object.fromEntries(Object.entries(levels).map(([key, g]) => [key, { ...g, untouched: g.cards - g.studied }])),
  };
}

function levelGroup() {
  return { cards: 0, studied: 0, expectedRecall: 0 };
}

/** 呼叫端沒帶 level 的卡（舊測試、舊資料）歸 B1 以下，不會被誤算成 B2。 */
function groupOf(level) {
  return level === 'B2' ? 'b2' : 'core';
}

/**
 * 反推：在每天最多做 dailyLimit 張的前提下，
 * 學過的卡考試當天記得的比例（learnedRate）守在目標以上時，每天學幾張新卡
 * 能讓記得的總張數（recall）最多。
 *
 * 目標原本比的是全範圍比例（rate），沒學到的卡算 0 分。那個數字在大範圍下
 * 永遠到不了八成五，反推只會回「達不到」，等於沒有回答問題（2026-10-04 改）。
 * 兩個比例都留在 tried 裡，rate 照舊是全範圍，前端當資訊列出來。
 *
 * **掃描，不做二分。** 新卡量與答對率不是單調關係——新卡學太多會排擠複習，
 * 答對率反而往下掉。二分搜尋的前提在這裡不成立，舊版回報的「上限」其實只是
 * 二分路徑上（0、1、3、7、15、30）的最大值。實測 16,401 張卡推到 233 天後的考試，
 * 舊版說最好是每天 30 張、14.23%，實際掃過一遍是 49 張、14.45%。
 *
 * 一次 simulate 實測約 13ms，掃 0..60 共 61 格約 0.8 秒。使用者按一次「推演」
 * 等這個時間，換一個不會騙人的數字，划算。maxNew 更大時改成等距粗掃再回頭補滿
 * 最好的那一格附近，讓模擬次數維持在約 61 + 2×step。
 */
export function solveDailyNew(opts) {
  const target = opts.target ?? 0.85;
  const maxNew = opts.maxNew ?? opts.dailyLimit ?? 60;
  const tried = [];
  const run = (n) => {
    const hit = tried.find((t) => t.dailyNew === n);
    if (hit) return hit;
    const result = simulate({ ...opts, dailyNew: n });
    const entry = {
      dailyNew: n,
      rate: result.expectedRecallRate,
      learnedRate: result.learnedRecallRate,
      recall: result.expectedRecall,
      studied: result.studiedByExam,
      reviews: result.totalReviews,
      peak: result.peakDay ? result.peakDay.reviews + result.peakDay.learned : 0,
      backlogPeak: result.backlogPeak,
      result,
    };
    tried.push(entry);
    return entry;
  };

  const step = Math.max(1, Math.ceil((maxNew + 1) / 61));
  for (let n = 0; n <= maxNew; n += step) run(n);
  run(maxNew);
  if (step > 1) {
    // 粗掃時最佳值可能落在兩格之間，回頭把那一段補滿。
    const coarse = pick(tried, target).recommended;
    const lo = Math.max(0, coarse.dailyNew - step);
    const hi = Math.min(maxNew, coarse.dailyNew + step);
    for (let n = lo; n <= hi; n += 1) run(n);
  }

  tried.sort((a, b) => a.dailyNew - b.dailyNew);
  const { feasible, recommended, ceiling } = pick(tried, target);
  // 記得張數離最好那格不到 NEAR_BAND 的達標格子，前端寫成「每天 a–b 張」。
  // 每一格是固定種子的一次蒙地卡羅，相鄰兩格的差距大半是抽樣雜訊，只給單一數字是假精確。
  const near = feasible.filter((t) => t.recall >= recommended.recall * (1 - NEAR_BAND));
  return {
    target,
    achievable: feasible.length > 0,
    recommended,
    ceiling,
    band: near.length
      ? { from: near[0].dailyNew, to: near[near.length - 1].dailyNew }
      : { from: recommended.dailyNew, to: recommended.dailyNew },
    // step === 1 代表 0..maxNew 每一格都真的跑過，ceiling 是確定的最大值。
    // step > 1 時是粗掃加局部補滿，ceiling 有可能漏掉格與格之間的尖峰。
    exhaustive: step === 1,
    tried: tried.map(({ result, ...rest }) => rest),
  };
}

// 2026-10-04 實測（A2–B2 全題型、考試 2027-05-01、每天 60 張）：同一個新卡量換 12 個種子，
// 記得張數的變異係數 0.92–1.30%；兩格相減的標準差約 1.4%，兩個標準差約 2.8%。
// 原本設 1% 比雜訊還窄，掃描結果 35／42／47／49 張是 2,799／2,762／2,843／2,794 張來回跳，
// 帶寬根本沒觸發，畫面上只剩一個靠運氣選出來的 47。多種子平均的曲線其實從 35 張起就是平的。
const NEAR_BAND = 0.03;

/**
 * ceiling 是學過的卡記得比例最高的那格；recommended 在達標的格子裡取記得張數最多的，
 * 同張數取新卡少的（工作量小）。達不到目標時 recommended 就是 ceiling，不回沒跑過的數字。
 * 先依 dailyNew 排序，reduce 的嚴格比較才會在平手時留下新卡少的那格。
 */
function pick(tried, target) {
  const ordered = [...tried].sort((a, b) => a.dailyNew - b.dailyNew);
  const feasible = ordered.filter((t) => t.learnedRate >= target);
  const ceiling = ordered.reduce((a, b) => (b.learnedRate > a.learnedRate ? b : a));
  const recommended = feasible.length
    ? feasible.reduce((a, b) => (b.recall > a.recall ? b : a))
    : ceiling;
  return { feasible, recommended, ceiling };
}

function successRating(ratings, rnd) {
  if (!ratings) return RATING.GOOD;
  const x = rnd();
  if (x < ratings.hard) return RATING.HARD;
  if (x < ratings.hard + ratings.good) return RATING.GOOD;
  return RATING.EASY;
}

function anyRating(ratings, rnd) {
  if (!ratings) return RATING.GOOD;
  const x = rnd();
  if (x < ratings.again) return RATING.AGAIN;
  if (x < ratings.again + ratings.hard) return RATING.HARD;
  if (x < ratings.again + ratings.hard + ratings.good) return RATING.GOOD;
  return RATING.EASY;
}

function modelFor(model, kind) {
  if (!model) return null;
  if ('hard' in model) return model;
  return model.byKind?.[kind] ?? model.default ?? null;
}

function hasObserved(model) {
  if (!model) return false;
  if ('hard' in model) return true;
  return Boolean(model.default || Object.keys(model.byKind ?? {}).length);
}

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function isoDay(date) {
  const d = new Date(date);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}
