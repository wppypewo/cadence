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
 * CO／PO 兩科**系統評量不了做得如何**：沒有音檔可比對，也沒有東西聽得懂一段口說。
 * 這是誠實的限制，不會因為多寫幾行程式就消失，所以不畫進度條。
 * 但「今天做了沒有」不是評量，是使用者自己知道的一件事——那件事給一顆打卡鍵
 * （見 db.mjs 的 checkins），因為不寫下來隔天就翻不出任何痕跡。
 * 分界線在這裡：**分數與熟練度不假裝，做過沒做過照實記。**
 *
 * **PE 同時有卡片與文件，是刻意的，不是分類沒分乾淨。**
 * 那六種題型加起來 13,000 多張，但每一張都只練一個零件；考的是 45 分鐘一篇 160 字。
 * 官方評分格五項各 5 分，其中 réalisation de la tâche 與 adéquation sociolinguistique
 * 兩項共 10 分沒有任何一張卡片碰得到——沒有一張卡片會問「這封信該用 tu 還是 vous」。
 * 所以 PE 這一列給卡片一顆按鈕、給整篇寫作一份文件與一顆打卡鍵，兩邊各記各的。
 */

const DAY_MS = 86_400_000;

/** 題型歸到哪一科。改這張表等於改整頁的意思，動之前先想清楚。 */
export const SKILL_KINDS = {
  CE: ['vocab-recall'],
  PE: ['vocab-produce', 'conj', 'connector', 'pick', 'rw', 'nom'],
};

/**
 * 四科的固定資料。fr 一併帶著，因為考卷上印的是法文名稱。
 *
 * `doc` 有值代表這一科有一份 study/ 文件（前端展開來讀）；
 * `check` 為 true 代表這一科有一件卡片記不到的事，需要手動打卡。
 * 兩者互相獨立：CE 兩者皆無，PE 有卡片也有這兩樣。
 */
const SKILLS = [
  {
    id: 'CE', zh: '閱讀理解', fr: 'Compréhension des écrits',
    hint: '看得懂字，閱讀才有得談。這一科的底子就是詞彙量。',
  },
  {
    id: 'PE', zh: '書寫表達', fr: 'Production écrite',
    hint: '卡片練零件，考的是一篇 160 字。兩件事都要做，打卡記的是後者。',
    doc: 'study/delf-b1-production-ecrite.md',
    check: true,
  },
  {
    id: 'CO', zh: '聽力理解', fr: 'Compréhension de l’oral',
    hint: '官方樣題聽三輪：先聽、再對答案、最後才看逐字稿。',
    doc: 'study/delf-b1-comprehension-orale.md',
    check: true,
  },
  {
    id: 'PO', zh: '口說表達', fr: 'Production orale',
    hint: '把固定 prompt 貼給 GPT，三個部分一次跑完，再看它給的六項評分。',
    doc: 'study/delf-b1-production-orale.md',
    check: true,
  },
];

/**
 * 可以手動打卡的科目，由上面那張表直接算出來。
 *
 * db.mjs 驗證寫進 checkins.jsonl 的科目時 import 這一份，**不另外再寫一份清單**：
 * 兩邊各寫一份的話，哪天這裡多一科而那裡忘了改，前端會給出一顆按下去必定 400 的鍵。
 */
export const CHECKIN_SKILLS = SKILLS.filter((s) => s.check).map((s) => s.id);

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
 * @param {number|null} input.newLimit  每日新卡上限（store.dailyNewLimit），null 為不設上限
 * @param {number}   input.newToday  今天已經引入的新卡數
 * @param {string?}  input.examDate  'YYYY-MM-DD' 或 null
 * @param {number}   input.reviewsToday 今天已作答次數
 * @param {number}   input.streakDays   連續練習天數
 * @param {Object}   [input.checkins]   store.checkinState() 的輸出，{CO:{...}, PO:{...}}
 * @param {Object}   [input.practiceToday] 今日四科實作紀錄；它證明做過，不代表能力分數
 * @param {Date}     [input.now]
 */
export function buildToday(input) {
  const now = input.now ?? new Date();
  const stats = new Map((input.byKind ?? []).map((r) => [r.kind, r]));
  const checkins = input.checkins ?? {};
  const practiceToday = input.practiceToday ?? {};

  // 新卡上限是**全域共用**的一個數字，不是每科一份。
  // 這裡刻意不把它拆成四份：拆法沒有任何依據，而且拆了會騙人——
  // 實際上先打開哪一科，那一科就把當天的新卡額度吃光。把這件事直說。
  //
  // newLimit 為 null 代表使用者設定成不設上限；沒傳（undefined）則照舊當 0。
  // 兩者分開是刻意的：null 是一個選擇，undefined 是呼叫端漏給，後者不該被解讀成「無限」。
  const unlimited = input.newLimit === null;
  const newBudget = unlimited ? Infinity : Math.max(0, (input.newLimit ?? 0) - (input.newToday ?? 0));

  const tasks = SKILLS.map((s) => {
    const kinds = SKILL_KINDS[s.id];
    // 打卡欄位跟 mode 無關，所以在分岔之前就算好：PE 兩邊都有。
    // 沒有紀錄時給的是「還沒做」而不是 undefined——前端拿 done 決定按鈕文字，
    // undefined 會畫出一顆狀態不明的鍵。
    const c = checkins[s.id] ?? {};
    const attempt = practiceToday[s.id] ?? null;
    const check = s.check
      ? {
        checkable: true,
        // 實作紀錄本身已經證明今天做過；分數仍留在 attempt 裡，不能拿完成狀態冒充能力。
        done: Boolean(attempt) || (c.done ?? false),
        checkinDone: c.done ?? false,
        lastDay: c.lastDay ?? null,
        recent: c.recent ?? 0,
        window: c.window ?? 0,
        practiced: Boolean(attempt),
        attempt,
      }
      : { practiced: Boolean(attempt), attempt };
    if (!kinds) {
      return {
        id: s.id, zh: s.zh, fr: s.fr, hint: s.hint,
        mode: 'doc', doc: s.doc,
        // tracked 講的是「系統能不能評量這一科」，這兩科的答案永遠是不能，
        // 所以不給 count、不給熟練度、不給任何算出來的數字。
        // check 裡那幾個欄位是另一回事：它們來自使用者自己按的那一下，是紀錄不是評量。
        tracked: false,
        ...check,
      };
    }
    const rows = kinds.map((k) => stats.get(k)).filter(Boolean);
    const sum = (f) => rows.reduce((a, r) => a + (r[f] ?? 0), 0);
    const total = sum('total');
    const seen = sum('seen');
    const due = sum('due');
    const unseen = total - seen;
    // 會被拿出來當新卡的張數。設了起始等級時比 unseen 少（低於起始等級的新卡不出）；
    // 舊的 byKind 沒有 fresh 欄，就退回 unseen。
    const fresh = rows.every((r) => r.fresh != null) ? sum('fresh') : unseen;
    return {
      id: s.id, zh: s.zh, fr: s.fr, hint: s.hint,
      mode: 'cards', kinds, tracked: true,
      // doc 為 null 代表這一科只有卡片。PE 有值，因為卡片練不到整篇寫作。
      doc: s.doc ?? null,
      ...check,
      total, seen, unseen, fresh, due, mature: sum('mature'),
      // 這一科最多能拿到多少新卡。額度是共用的，所以兩科的 newAvailable 會重疊——
      // 它答的是「先開這一科的話能學幾張新的」，不是「這一科分到幾張」。
      // 不設上限時沒有共用的問題，這個數就是這一科還有幾張新卡。
      newAvailable: Math.min(newBudget, fresh),
      newUnlimited: unlimited,
      // 同理，count 是「先開這一科」的單科上限，**不可以跨科相加**。
      // 想要今天的總量請用下面的 dayTotal。
      count: due + Math.min(newBudget, fresh),
    };
  });

  // 全日總量：到期卡逐科相加（各算各的），新卡只加一次共用額度。
  // 沒有這個數字的話，畫面上兩科各寫一個數，讀的人只能自己相加，
  // 而相加出來的答案是錯的——新卡那一段會被重複計算。
  const cardTasks = tasks.filter((t) => t.mode === 'cards');
  const dueTotal = cardTasks.reduce((a, t) => a + t.due, 0);
  const freshTotal = cardTasks.reduce((a, t) => a + t.fresh, 0);
  // 新卡裡有幾張是 B2。前端拿它把「另有新卡」拆成 B1 以下與 B2 兩行（2026-10-12 使用者決定）。
  // 舊的 byKind（雲端 migration 還沒套用時）沒有 freshB2，給 null，前端照舊只寫一個總數，
  // 不要把缺欄當成 0——那會把 B2 全算進 B1 以下。
  const cardRows = cardTasks.flatMap((t) => t.kinds.map((k) => stats.get(k)).filter(Boolean));
  const freshB2 = cardRows.every((r) => r.freshB2 != null)
    ? cardRows.reduce((a, r) => a + r.freshB2, 0)
    : null;

  return {
    day: localISODay(now),
    dueTotal,
    newAvailable: Math.min(newBudget, freshTotal),
    freshB2,
    dayTotal: dueTotal + Math.min(newBudget, freshTotal),
    // Infinity 經過 JSON 會變成 null，這裡直接給 null，與 newLimit 的 null 同義。
    newBudget: unlimited ? null : newBudget,
    newLimit: unlimited ? null : (input.newLimit ?? 0),
    newToday: input.newToday ?? 0,
    reviewsToday: input.reviewsToday ?? 0,
    streakDays: input.streakDays ?? 0,
    examDate: input.examDate ?? null,
    daysLeft: daysToExam(input.examDate, now),
    tasks,
    // 有卡可做的科目數。0 代表今天卡片的部分做完了，但可打卡的那三科仍可能在等人。
    pendingCards: tasks.filter((t) => t.mode === 'cards' && t.count > 0).length,
    // 今天還沒打卡的科目數。與 pendingCards 分開數，因為兩者的「做完」意思不同：
    // 一個是系統算出來的，一個是使用者自己說的。PE 兩邊都會被數到，那不是重複——
    // 卡片清空與寫完一篇作文本來就是兩件事。
    pendingChecks: tasks.filter((t) => t.checkable && !t.done).length,
  };
}

/** 本地時區的 'YYYY-MM-DD'。與 db.mjs 的 localDay 同一套算法，這裡不 import 是為了保持純函式無依賴。 */
function localISODay(date) {
  const d = new Date(date);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}
