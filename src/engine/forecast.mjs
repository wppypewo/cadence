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

/**
 * 一次考前推演。
 *
 * @param {object} opts
 * @param {Array<{id:string, stability?:number, difficulty?:number, due?:string}>} opts.cards
 *        在範圍內的卡。沒有 state 的卡就是還沒學過的新卡。
 * @param {Date}   opts.from        起算日
 * @param {Date}   opts.examDate    考試日
 * @param {number} opts.dailyLimit  每天最多做幾張（含新卡）
 * @param {number} opts.dailyNew    每天最多學幾張新卡
 * @param {number} opts.desiredRetention
 * @param {{hard:number,good:number,easy:number}|null} opts.ratings
 * @param {number} opts.secondsPerCard 每張卡的平均作答秒數，用來換算時間成本
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
  const secondsPerCard = opts.secondsPerCard ?? null;

  // 卡片狀態的可變副本。不動呼叫端傳進來的物件。
  const seen = [];
  const fresh = [];
  for (const c of opts.cards) {
    if (c.stability != null && c.difficulty != null) {
      seen.push({ id: c.id, s: c.stability, d: c.difficulty, due: startOfDay(new Date(c.due)).getTime(), last: new Date(c.due).getTime() });
    } else {
      fresh.push({ id: c.id, s: null, d: null, due: null, last: null });
    }
  }
  // 到期早的先做。逾期越久的卡遺忘越深，優先處理。
  seen.sort((a, b) => a.due - b.due);

  const days = [];
  let freshIdx = 0;
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
      const rating = rnd() < r ? successRating(ratings, rnd) : RATING.AGAIN;
      if (rating === RATING.AGAIN) lapsesToday += 1;
      const next = scheduler.review({ stability: card.s, difficulty: card.d }, rating, Math.max(0, elapsed));
      card.s = next.stability;
      card.d = next.difficulty;
      card.last = dayStart;
      card.due = dayStart + next.intervalDays * DAY_MS;
    }

    // 剩餘額度拿來學新卡。新卡當天必定是第一次見，用 Good 起手；
    // 這一步不抽樣，因為初次評分反映的是使用者當下的自我判斷，不是記憶狀態。
    const room = Math.min(dailyLimit - doing.length, dailyNew, fresh.length - freshIdx);
    let learned = 0;
    for (let i = 0; i < room; i += 1) {
      const card = fresh[freshIdx];
      freshIdx += 1;
      const next = scheduler.review(null, RATING.GOOD, 0);
      card.s = next.stability;
      card.d = next.difficulty;
      card.last = dayStart;
      card.due = dayStart + next.intervalDays * DAY_MS;
      seen.push(card);
      learned += 1;
    }

    const count = doing.length + learned;
    totalReviews += count;
    totalLapses += lapsesToday;
    days.push({
      day: isoDay(new Date(dayStart)),
      due: overdue,
      reviews: doing.length,
      learned,
      deferred,
      lapses: lapsesToday,
      minutes: secondsPerCard ? Math.round((count * secondsPerCard) / 60) : null,
    });
    seen.sort((a, b) => a.due - b.due);
  }

  // 考試當天：把每張卡的可提取度算出來，加總就是期望答對數。
  const examTime = exam.getTime();
  let expectedRecall = 0;
  let studiedCount = 0;
  const buckets = { strong: 0, shaky: 0, weak: 0, untouched: fresh.length - freshIdx };
  for (const card of seen) {
    if (card.s == null) continue;
    studiedCount += 1;
    const r = scheduler.retrievability(card.s, Math.max(0, (examTime - card.last) / DAY_MS));
    expectedRecall += r;
    if (r >= 0.9) buckets.strong += 1;
    else if (r >= 0.7) buckets.shaky += 1;
    else buckets.weak += 1;
  }

  const inScope = opts.cards.length;
  return {
    examDate: isoDay(exam),
    daysUntilExam: totalDays,
    cardsInScope: inScope,
    ratingModel: ratings ? 'observed' : 'assumed-good',
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
    studiedByExam: studiedCount,
    coverage: inScope ? studiedCount / inScope : 0,
    buckets,
  };
}

/**
 * 反推：在每天最多做 dailyLimit 張的前提下，
 * 每天要學幾張新卡才能讓考試當天的期望答對率達到目標。
 *
 * 二分搜尋。單調性不是嚴格保證的（新卡學太多會排擠複習，反而更差），
 * 所以最後補一輪線性掃描確認，並回報實際找到的最佳值而不是二分終點。
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
      studied: result.studiedByExam,
      reviews: result.totalReviews,
      peak: result.peakDay ? result.peakDay.reviews + result.peakDay.learned : 0,
      backlogPeak: result.backlogPeak,
      result,
    };
    tried.push(entry);
    return entry;
  };

  let lo = 0;
  let hi = maxNew;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (run(mid).rate >= target) lo = mid;
    else hi = mid - 1;
  }
  run(lo);
  tried.sort((a, b) => a.dailyNew - b.dailyNew);
  const feasible = tried.filter((t) => t.rate >= target);
  const best = tried.reduce((a, b) => (b.rate > a.rate ? b : a));
  return {
    target,
    achievable: feasible.length > 0,
    // 達標的話取能達標的最大新卡量（學得多又達標）；達不到就給最接近的
    recommended: feasible.length ? feasible[feasible.length - 1] : best,
    ceiling: best,
    tried: tried.map(({ result, ...rest }) => rest),
  };
}

function successRating(ratings, rnd) {
  if (!ratings) return RATING.GOOD;
  const x = rnd();
  if (x < ratings.hard) return RATING.HARD;
  if (x < ratings.hard + ratings.good) return RATING.GOOD;
  return RATING.EASY;
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
