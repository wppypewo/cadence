/**
 * FSRS-6 排程引擎（純函數，無狀態）
 *
 * 移植自官方參考實作 py-fsrs（MIT）的 fsrs/scheduler.py，
 * 2026-09-08 取自 open-spaced-repetition/py-fsrs @ main 逐行核對。
 *
 * 為什麼不自己發明間隔表：Leitner 的 0/1/2/4/8/21 天對每張卡一視同仁，
 * 而「être 的 subjonctif」跟「abondant 的中文意思」根本不是同一種難度。
 * FSRS 為每張卡各自估一組 (S, D)，間隔由「你要幾成把握記得」反推。
 * 這個計算人腦做不到，是本工具存在的主要理由之一。
 *
 * 三個量：
 *   S 穩定度 — 從剛複習完到 retrievability 掉至 90% 所需的天數
 *   D 難度   — 1..10，這張卡對「你」有多難，會隨每次評分緩慢修正
 *   R 可提取性 — 此刻若考你，答得出來的機率
 *
 * 評分 1..4 對應 Again / Hard / Good / Easy。
 */

/** 官方預設參數。w[20] 是 DECAY，其餘 20 個是模型權重。 */
export const DEFAULT_PARAMETERS = Object.freeze([
  0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001,
  1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014,
  1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
]);

export const RATING = Object.freeze({ AGAIN: 1, HARD: 2, GOOD: 3, EASY: 4 });

const MIN_DIFFICULTY = 1.0;
const MAX_DIFFICULTY = 10.0;
const STABILITY_MIN = 0.001;

/** 間隔上限。10 年後才複習的卡等同沒在複習，但也沒必要更短。 */
const DEFAULT_MAXIMUM_INTERVAL = 3650;

/** 銀行家捨入（round half to even），對齊 Python 內建的 round()。 */
function roundHalfToEven(x) {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

const clampDifficulty = (d) => Math.min(Math.max(d, MIN_DIFFICULTY), MAX_DIFFICULTY);
const clampStability = (s) => Math.max(s, STABILITY_MIN);

/**
 * 建立一組排程器。參數與目標保留率固定後，所有計算都是純函數。
 *
 * @param {object} [opts]
 * @param {number[]} [opts.parameters] 21 個 FSRS-6 參數
 * @param {number} [opts.desiredRetention] 目標保留率（0..1），排程間隔由它反推
 * @param {number} [opts.maximumInterval] 間隔上限（天）
 */
export function createScheduler(opts = {}) {
  const w = opts.parameters ?? DEFAULT_PARAMETERS;
  if (w.length !== 21) {
    throw new Error(`FSRS-6 需要 21 個參數，收到 ${w.length} 個`);
  }
  const desiredRetention = opts.desiredRetention ?? 0.9;
  if (!(desiredRetention > 0 && desiredRetention < 1)) {
    throw new Error(`desiredRetention 必須落在 (0, 1)，收到 ${desiredRetention}`);
  }
  const maximumInterval = opts.maximumInterval ?? DEFAULT_MAXIMUM_INTERVAL;

  const DECAY = -w[20];
  const FACTOR = Math.pow(0.9, 1 / DECAY) - 1;

  /** 遺忘曲線。elapsedDays 天沒複習後，還記得的機率。 */
  function retrievability(stability, elapsedDays) {
    if (stability == null || elapsedDays == null) return 0;
    if (elapsedDays <= 0) return 1;
    return Math.pow(1 + (FACTOR * elapsedDays) / stability, DECAY);
  }

  /**
   * 由穩定度反推「掉到 desiredRetention 需要幾天」，即下次複習日。
   *
   * 取整用 roundHalfToEven 而非 Math.round：參考實作是 Python，
   * 內建 round() 為銀行家捨入。剛好落在 x.5 的機率極低，但只要不一致，
   * tests/fsrs.test.mjs 的黃金值就對不上，也就失去了「可對照參考實作」的意義。
   */
  function nextInterval(stability) {
    const raw = (stability / FACTOR) * (Math.pow(desiredRetention, 1 / DECAY) - 1);
    return Math.min(Math.max(roundHalfToEven(raw), 1), maximumInterval);
  }

  const initialStability = (rating) => clampStability(w[rating - 1]);

  function initialDifficulty(rating, clamp = true) {
    const d = w[4] - Math.exp(w[5] * (rating - 1)) + 1;
    return clamp ? clampDifficulty(d) : d;
  }

  /**
   * 難度更新。兩段：先線性阻尼（越接近 10 越難再變難），
   * 再向 D0(Easy) 均值回歸（避免難度單調累積、永遠回不來）。
   *
   * 已知後果：D 剛好等於 10 時 (10 - D) 歸零，四種評分算出同一個值 9.9852，
   * 答 Easy 也拉不下來。這是 FSRS-6 本身的性質，已與參考實作逐位元核對，
   * 不在此「修正」——改了就不再是 FSRS。tests/fsrs.test.mjs 有把這件事釘住。
   */
  function nextDifficulty(difficulty, rating) {
    const deltaD = -(w[6] * (rating - 3));
    const damped = difficulty + ((10.0 - difficulty) * deltaD) / 9.0;
    const target = initialDifficulty(RATING.EASY, false);
    return clampDifficulty(w[7] * target + (1 - w[7]) * damped);
  }

  /** 同一天內再答一次（間隔 < 1 天）走這條，不套遺忘曲線。 */
  function shortTermStability(stability, rating) {
    let inc = Math.exp(w[17] * (rating - 3 + w[18])) * Math.pow(stability, -w[19]);
    if (rating >= RATING.HARD) inc = Math.max(inc, 1.0);
    return clampStability(stability * inc);
  }

  function forgetStability(difficulty, stability, r) {
    const longTerm =
      w[11] *
      Math.pow(difficulty, -w[12]) *
      (Math.pow(stability + 1, w[13]) - 1) *
      Math.exp((1 - r) * w[14]);
    // 遺忘後的穩定度不該高於「同日重答一次」能到的值，取小者。
    const shortTerm = stability / Math.exp(w[17] * w[18]);
    return Math.min(longTerm, shortTerm);
  }

  function recallStability(difficulty, stability, r, rating) {
    const hardPenalty = rating === RATING.HARD ? w[15] : 1;
    const easyBonus = rating === RATING.EASY ? w[16] : 1;
    return (
      stability *
      (1 +
        Math.exp(w[8]) *
          (11 - difficulty) *
          Math.pow(stability, -w[9]) *
          (Math.exp((1 - r) * w[10]) - 1) *
          hardPenalty *
          easyBonus)
    );
  }

  function nextStability(difficulty, stability, r, rating) {
    const s =
      rating === RATING.AGAIN
        ? forgetStability(difficulty, stability, r)
        : recallStability(difficulty, stability, r, rating);
    return clampStability(s);
  }

  /**
   * 複習一張卡，回傳新的記憶狀態。
   *
   * card 為 null／未複習過時走初始公式；elapsedDays < 1 走同日公式；
   * 其餘走遺忘曲線 + 長期公式。這三條分支的界線與 py-fsrs 一致。
   *
   * @param {{stability:number, difficulty:number}|null} card
   * @param {number} rating 1..4
   * @param {number} elapsedDays 距上次複習的天數（新卡傳 0）
   * @returns {{stability:number, difficulty:number, intervalDays:number, retrievabilityBefore:number}}
   */
  function review(card, rating, elapsedDays) {
    if (!Number.isInteger(rating) || rating < 1 || rating > 4) {
      throw new Error(`rating 必須是 1..4 的整數，收到 ${rating}`);
    }
    let stability;
    let difficulty;
    let rBefore = 0;

    if (!card || card.stability == null || card.difficulty == null) {
      stability = initialStability(rating);
      difficulty = initialDifficulty(rating, true);
    } else if (elapsedDays < 1) {
      rBefore = retrievability(card.stability, elapsedDays);
      stability = shortTermStability(card.stability, rating);
      difficulty = nextDifficulty(card.difficulty, rating);
    } else {
      rBefore = retrievability(card.stability, elapsedDays);
      stability = nextStability(card.difficulty, card.stability, rBefore, rating);
      difficulty = nextDifficulty(card.difficulty, rating);
    }

    return {
      stability,
      difficulty,
      intervalDays: nextInterval(stability),
      retrievabilityBefore: rBefore,
    };
  }

  return {
    DECAY,
    FACTOR,
    desiredRetention,
    parameters: w,
    retrievability,
    nextInterval,
    initialStability,
    initialDifficulty,
    nextDifficulty,
    shortTermStability,
    nextStability,
    review,
  };
}

/** 預設排程器，目標保留率 90%。 */
export const defaultScheduler = createScheduler();
