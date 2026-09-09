/**
 * 「今天要做什麼」——把題庫狀態換算成 DELF 四科的當日任務。
 *
 * 為什麼要有這一層：複習頁只知道「卡片」，不知道「科目」。
 * 但考的是 DELF B1 四科，及格條件是四科總分 50/100 **且單科不低於 5/25**，
 * 也就是說任何一科掛零就直接出局。四種題型攤在同一個佇列裡，
 * 練久了會自然全部倒向卡片最多的 conj（9,073 張），另外三科一張卡都沒有。
 * 這支模組存在的唯一理由，就是讓那件事在畫面上藏不住。
 *
 * 這裡是純函式：只吃數字，不碰 DB、不碰時鐘以外的 I/O，所以測得起來。
 *
 * 題型→科目的對應（會被問，所以寫清楚理由）：
 *   CE 閱讀　vocab-recall　　　看法文想意思，就是閱讀的方向。
 *   PE 寫作　其餘六種　　　　　中翻法、變位、連接詞、挑連接詞、改寫、名詞化，
 *   　　　　　　　　　　　　　全都是「自己把法文寫出來」，正是 PE 在考的事。
 *   CO 聽力　無卡片　　　　　　題庫裡沒有音檔，只能指向官方樣題。
 *   PO 口說　無卡片　　　　　　機器判不了發音與互動，指向 GPT 練習用的固定 prompt。
 *
 * CO／PO 兩科**做了沒有系統記不到**。這是誠實的限制，不是待辦——
 * 與其假裝有進度條，不如把當天該做的事寫死在那一列。
 */

const DAY_MS = 86_400_000;

/** 題型歸到哪一科。改這張表等於改整頁的意思，動之前先想清楚。 */
export const SKILL_KINDS = {
  CE: ['vocab-recall'],
  PE: ['vocab-produce', 'conj', 'connector', 'pick', 'rw', 'nom'],
};

/** 四科的固定資料。fr 一併帶著，因為考卷上印的是法文名稱。 */
const SKILLS = [
  {
    id: 'CE', zh: '閱讀理解', fr: 'Compréhension des écrits',
    hint: '看得懂字，閱讀才有得談。這一科的底子就是詞彙量。',
  },
  {
    id: 'PE', zh: '書寫表達', fr: 'Production écrite',
    hint: '寫得出來才算會。變位、連接詞、名詞化都算在這一科。',
  },
  {
    id: 'CO', zh: '聽力理解', fr: 'Compréhension de l’oral',
    hint: '官方樣題聽三輪：先聽、再對答案、最後才看逐字稿。',
    doc: 'study/delf-b1-comprehension-orale.md',
  },
  {
    id: 'PO', zh: '口說表達', fr: 'Production orale',
    hint: '把固定 prompt 貼給 GPT，三個部分一次跑完，再看它給的六項評分。',
    doc: 'study/delf-b1-production-orale.md',
  },
];

/**
 * 距離考試還有幾天。examDate 是 'YYYY-MM-DD'。
 * 用 UTC 午夜相減，不用毫秒差再取整——後者在日光節約或跨時區時會差一天。
 * @returns {number|null} null 表示沒設考試日
 */
export function daysToExam(examDate, now = new Date()) {
  if (!examDate) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(examDate);
  if (!m) return null;
  const exam = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((exam - today) / DAY_MS);
}

/**
 * 算出今天四科各要做什麼。
 *
 * @param {Object}   input
 * @param {Array}    input.byKind    store.byKind() 的輸出：{kind,total,seen,mature,due}
 * @param {number}   input.newLimit  每日新卡上限（store.dailyNewLimit）
 * @param {number}   input.newToday  今天已經引入的新卡數
 * @param {string?}  input.examDate  'YYYY-MM-DD' 或 null
 * @param {number}   input.reviewsToday 今天已作答次數
 * @param {number}   input.streakDays   連續練習天數
 * @param {Date}     [input.now]
 */
export function buildToday(input) {
  const now = input.now ?? new Date();
  const stats = new Map((input.byKind ?? []).map((r) => [r.kind, r]));

  // 新卡上限是**全域共用**的一個數字，不是每科一份。
  // 這裡刻意不把它拆成四份：拆法沒有任何依據，而且拆了會騙人——
  // 實際上先打開哪一科，那一科就把當天的新卡額度吃光。把這件事直說。
  const newBudget = Math.max(0, (input.newLimit ?? 0) - (input.newToday ?? 0));

  const tasks = SKILLS.map((s) => {
    const kinds = SKILL_KINDS[s.id];
    if (!kinds) {
      return {
        id: s.id, zh: s.zh, fr: s.fr, hint: s.hint,
        mode: 'doc', doc: s.doc,
        // 系統記不到 CO／PO 的完成狀態，所以不給 done，也不給假的數字。
        tracked: false,
      };
    }
    const rows = kinds.map((k) => stats.get(k)).filter(Boolean);
    const sum = (f) => rows.reduce((a, r) => a + (r[f] ?? 0), 0);
    const total = sum('total');
    const seen = sum('seen');
    const due = sum('due');
    const unseen = total - seen;
    return {
      id: s.id, zh: s.zh, fr: s.fr, hint: s.hint,
      mode: 'cards', kinds, tracked: true,
      total, seen, unseen, due, mature: sum('mature'),
      // 這一科最多能拿到多少新卡。額度是共用的，所以兩科的 newAvailable 會重疊——
      // 它答的是「先開這一科的話能學幾張新的」，不是「這一科分到幾張」。
      newAvailable: Math.min(newBudget, unseen),
      // 同理，count 是「先開這一科」的單科上限，**不可以跨科相加**。
      // 想要今天的總量請用下面的 dayTotal。
      count: due + Math.min(newBudget, unseen),
    };
  });

  // 全日總量：到期卡逐科相加（各算各的），新卡只加一次共用額度。
  // 沒有這個數字的話，畫面上兩科各寫一個數，讀的人只能自己相加，
  // 而相加出來的答案是錯的——新卡那一段會被重複計算。
  const cardTasks = tasks.filter((t) => t.mode === 'cards');
  const dueTotal = cardTasks.reduce((a, t) => a + t.due, 0);
  const unseenTotal = cardTasks.reduce((a, t) => a + t.unseen, 0);

  return {
    day: localISODay(now),
    dueTotal,
    newAvailable: Math.min(newBudget, unseenTotal),
    dayTotal: dueTotal + Math.min(newBudget, unseenTotal),
    newBudget,
    newLimit: input.newLimit ?? 0,
    newToday: input.newToday ?? 0,
    reviewsToday: input.reviewsToday ?? 0,
    streakDays: input.streakDays ?? 0,
    examDate: input.examDate ?? null,
    daysLeft: daysToExam(input.examDate, now),
    tasks,
    // 有卡可做的科目數。0 代表今天卡片的部分做完了，但 CO／PO 仍在等人。
    pendingCards: tasks.filter((t) => t.mode === 'cards' && t.count > 0).length,
  };
}

/** 本地時區的 'YYYY-MM-DD'。與 db.mjs 的 localDay 同一套算法，這裡不 import 是為了保持純函式無依賴。 */
function localISODay(date) {
  const d = new Date(date);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}
