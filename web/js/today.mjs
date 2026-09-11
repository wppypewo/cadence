/**
 * 「今天」頁。整個工具的入口：雙擊啟動器之後第一眼看到的東西。
 *
 * 它要回答的只有一個問題——**現在坐下來，先做哪一件事**。
 * 所以這一頁不放圖表、不放歷史、不放任何「看起來很認真」但不會讓人動手的東西。
 * 四列，一列一科，每列右邊是一顆可以馬上按下去的按鈕。
 * 每一列刻意不報「今天這一科共幾張」：新卡額度是全站共用的，
 * 兩科各報一個含新卡的總數，讀的人相加就會得到一個不存在的數字。
 * 單科只寫自己的到期量，共用的部分統一由頁尾那一行交代。
 *
 * 三件事刻意跟其他頁不一樣：
 *  1. **不受側欄的題型篩選影響。**這一頁問的是「今天整體該做什麼」，
 *     被篩選改掉就變成「今天在我挑剩的範圍裡該做什麼」，那是複習頁的工作。
 *  2. **CO／PO 不顯示熟練度，只顯示做過沒做過。**題庫裡沒有音檔也沒有錄音評分，
 *     系統判不了你講得好不好，畫一條進度條就是假的。但「今天做了」這件事
 *     使用者自己知道，給一顆打卡鍵按下去就記得住——不記的話隔天完全翻不出痕跡，
 *     昨天等於沒發生。分界線在這裡：熟練度不假裝，做過沒做過照實記。
 *  3. **PE 那一列同時有三顆按鈕。**卡片、說明文件、打卡各一顆，因為那一科真的有兩件事要做：
 *     卡片練零件，整篇作文練評分格上卡片碰不到的那 10 分。只給卡片按鈕的話，
 *     這一頁會讓人以為把 PE 的卡片清光就等於練了寫作。
 */

import { h, clear, icon, num } from './dom.mjs';
import { api } from './net.mjs';
import { render as renderMarkdown } from './markdown.mjs';

const WEEKDAY = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];

export function todayView(root, ctx) {
  const box = h('div.today');
  root.append(box);
  box.append(h('div.card.empty', {}, h('p', { text: '正在算今天要做什麼…' })));

  let dead = false;
  load();
  return () => { dead = true; };

  async function load() {
    let data;
    try {
      data = await api.today();
    } catch (err) {
      if (dead) return;
      clear(box).append(h('div.card.errorbox', {}, h('p', { text: err.message })));
      return;
    }
    if (dead) return;
    clear(box);
    box.append(header(data));
    const list = h('div.tasks');
    // 打卡之後只換掉那一列的狀態與頁尾，不整頁重畫：說明文件展開著的時候
    // 重畫會把它收起來，而按打卡的那一刻通常正是照著文件做完的那一刻。
    let foot = footer(data);
    const refresh = (next) => {
      const fresh = footer(next);
      foot.replaceWith(fresh);
      foot = fresh;
    };
    const lead = pickLead(data.tasks);
    for (const task of data.tasks) {
      list.append(taskRow(task, ctx, refresh, task === lead?.task ? lead.action : null));
    }
    box.append(list);
    box.append(foot);
  }
}

function header(data) {
  const d = new Date(`${data.day}T00:00:00`);
  const left = data.daysLeft;

  // 倒數是這一頁字最大的東西。日期本身沒有人記得住，「還有幾天」才會逼人動作。
  const countdown = left === null
    ? h('p.today-count', { text: '還沒設考試日期' })
    : h('p.today-count', {},
      h('span.n.num', { text: num(Math.abs(left)) }),
      h('span.u', { text: left >= 0 ? '天' : '天前考完了' }));

  const sub = left === null
    ? '到設定裡填上考試日期，這裡會變成倒數。'
    // 不寫死哪一級：B1 考完後這個日期會改成 B2 的，寫死會讓倒數掛錯考試名。
    : `距離 ${data.examDate} 的考試${left < 0 ? '（日期已過，記得改）' : ''}`;

  return h('header.today-head', {},
    h('p.today-date', { text: `${data.day}　${WEEKDAY[d.getDay()]}` }),
    countdown,
    h('p.today-sub', { text: sub }),
    h('p.today-run', { text: runLine(data) }),
  );
}

function runLine(data) {
  const bits = [];
  bits.push(data.streakDays > 0 ? `連續 ${data.streakDays} 天` : '連續紀錄還沒開始');
  bits.push(data.reviewsToday > 0 ? `今天已答 ${data.reviewsToday} 題` : '今天還沒動過');
  return bits.join('・');
}

/**
 * 整頁只留一顆實心主鍵：每列各一顆 primary 時，眼睛找不到「現在先做哪一個」。
 * 依頁面順序取第一個還有事可做的列：有卡要做的卡片列，或還沒打卡的文件列。
 */
function pickLead(tasks) {
  for (const task of tasks) {
    if (task.mode === 'cards' && task.count > 0) return { task, action: 'cards' };
    if (!(task.practiced || task.done)) return { task, action: 'practice' };
  }
  return null;
}

function taskRow(task, ctx, refresh, leadAction = null) {
  const row = h('article.task', { dataset: { skill: task.id, mode: task.mode } });

  row.append(h('div.task-code', {}, h('span', { text: task.id })));

  const main = h('div.task-main', {},
    h('h2.task-name', {},
      h('span.zh', { text: task.zh }),
      h('span.fr', { lang: 'fr', text: task.fr }),
    ),
  );
  // 按鈕由上而下依重要性排：卡片、打卡、說明。
  // PE 三顆都有，順序等於「今天最該按哪一顆」。
  const act = h('div.task-act');

  if (task.mode === 'cards') {
    main.append(countLine(task));
    main.append(h('p.task-hint', { text: task.hint }));
    act.append(task.count > 0
      ? h(leadAction === 'cards' ? 'button.btn.btn-primary' : 'button.btn', {
        type: 'button',
        // 按鈕上只放「到期」那個數字。到期卡是這一科自己的，加得起來；
        // 新卡額度兩科共用，寫進按鈕會讓人以為 CE 的 8 張和 PE 的 8 張是十六張。
        text: buttonText(task),
        onclick: () => ctx.startReview({ kinds: task.kinds, guided: leadAction === 'cards' }),
      })
      : h('button.btn.btn-quiet', {
        type: 'button',
        text: '再多練一些',
        onclick: () => ctx.startReview({ kinds: task.kinds }),
      }));
  } else {
    // 文件型（CO／PO）：先寫「今天做什麼」，再寫打卡狀態。
    // 倒過來的話，狀態會比指示更搶眼，但今天還沒做的時候，該讀的是「要做什麼」。
    main.append(h('p.task-do', { text: task.hint }));
  }

  const practiceBtn = h(leadAction === 'practice' ? 'button.btn.btn-primary' : 'button.btn', {
    type: 'button',
    text: practiceWords(task.id),
    onclick: () => ctx.openPractice(task.id, { guided: leadAction === 'practice' }),
  });
  act.append(practiceBtn);

  if (!task.checkable && task.practiced) {
    main.append(h('p.task-check', {},
      h('span.done', {}, icon('check'), h('span', { text: '今天的實作練習已記錄' })),
      h('span.sep', { text: '・' }), h('span.part', { text: attemptText(task.attempt) }),
      h('span.note', { text: '（完成與分數分開記錄）' }),
    ));
  }

  if (task.checkable) {
    const status = h('p.task-check');
    main.append(status);
    const checkBtn = h('button.btn', { type: 'button' });
    checkBtn.addEventListener('click', () => toggleCheck(task, row, checkBtn, status, ctx, refresh, 'quiet'));
    paintCheck(task, row, checkBtn, status, 'quiet');
    act.append(checkBtn);
  }

  if (task.doc) {
    const panel = h('div.doc', { hidden: true });
    main.append(panel);
    const openBtn = h('button.btn.btn-quiet', { type: 'button', text: '打開說明' });
    openBtn.addEventListener('click', () => toggleDoc(task, panel, openBtn));
    act.append(openBtn);
  }

  row.append(main);
  row.append(act);

  return row;
}

function practiceWords(skill) {
  return ({ CE: '閱讀工作台', PE: '寫作工作台', CO: '開始聽力', PO: '開始口說' })[skill] ?? '開始練習';
}

const CHECK_CLASS = { primary: 'btn btn-primary', plain: 'btn', quiet: 'btn btn-quiet' };

/** 打卡鍵的文案。PE 打的是「寫了一篇」，跟 CO／PO 的「做過了」不是同一件事，不共用字。 */
function checkWords(task) {
  if (task.mode === 'cards') {
    return {
      todo: '記下今天寫過作文', undo: '取消今天的作文紀錄',
      done: '今天寫過一篇了', pending: '今天還沒寫',
      note: '（這裡只記完成；工作台可另存時間、草稿與分數）',
    };
  }
  return {
    todo: '今天做過了', undo: '取消今天的打卡',
    done: '今天已記錄', pending: '今天還沒記錄',
    note: '（這裡只記完成；工作台可另存時間與分數）',
  };
}

/**
 * 打卡鍵與它上面那行狀態。
 *
 * 狀態行刻意分兩句：第一句講今天，第二句講最近七天。
 * 只講今天的話，隔天早上打開仍然回答不了「昨天到底做了沒有」——
 * 而那正是當初沒有打卡功能時最缺的一件事。
 */
function paintCheck(task, row, btn, status, weight) {
  const w = checkWords(task);
  row.dataset.done = task.done ? '1' : '0';
  if (task.practiced) {
    btn.className = 'btn btn-quiet';
    btn.textContent = '已由練習紀錄完成';
    btn.disabled = true;
    clear(status).append(
      h('span.done', {}, icon('check'), h('span', { text: '今天的實作練習已記錄' })),
      h('span.sep', { text: '・' }),
      h('span.part', { text: attemptText(task.attempt) }),
      h('span.note', { text: '（完成與分數分開記錄）' }),
    );
    return;
  }
  btn.disabled = false;
  btn.className = task.done ? 'btn btn-quiet' : CHECK_CLASS[weight];
  btn.textContent = task.done ? w.undo : w.todo;

  clear(status);
  if (task.done) {
    status.append(h('span.done', {}, icon('check'), h('span', { text: w.done })));
  } else {
    status.append(h('span.dim', { text: w.pending }));
  }
  status.append(h('span.sep', { text: '・' }), h('span.part', { text: recentText(task) }));
  // 這一句是整個功能的但書，任何時候都要在：打卡只證明「有坐下來做」，
  // 不證明做得對。系統仍然沒有能力判斷打卡記的那件事。
  status.append(h('span.note', { text: w.note }));
}

function attemptText(attempt) {
  if (!attempt) return '已有練習紀錄';
  const bits = [];
  if (attempt.durationSec) bits.push(`${Math.max(1, Math.round(attempt.durationSec / 60))} 分鐘`);
  if (attempt.wordCount) bits.push(`${num(attempt.wordCount)} mots`);
  if (attempt.score !== null) bits.push(`${attempt.score}/${attempt.maxScore}`);
  return bits.join('・') || '已有練習紀錄';
}

function recentText(task) {
  if (task.recent > 0) return `最近 ${task.window} 天做了 ${num(task.recent)} 天`;
  if (task.lastDay) return `上次是 ${task.lastDay}`;
  return '還沒有任何紀錄';
}

async function toggleCheck(task, row, btn, status, ctx, refresh, weight) {
  btn.disabled = true;
  try {
    const data = await api.checkin({ skill: task.id, done: !task.done });
    // 用伺服器回來的那一份覆蓋手上的 task，不自己把 done 反過來寫：
    // recent 與 lastDay 只有後端算得出來，猜的話畫面會跟事實檔分岔。
    Object.assign(task, data.tasks.find((t) => t.id === task.id));
    paintCheck(task, row, btn, status, weight);
    refresh(data);
  } catch (err) {
    ctx.toast(err.message, 'bad');
  } finally {
    btn.disabled = false;
  }
}

/** 到期與新卡分開寫。混成一個數字，就看不出「今天是在還債還是在借新的」。 */
function countLine(task) {
  const line = h('p.task-count');
  if (task.total === 0) {
    line.append(h('span.dim', { text: '題庫裡沒有這一科的卡片' }));
    return line;
  }
  if (task.count === 0) {
    line.append(h('span.done', {}, icon('check'), h('span', { text: '今天的份做完了' })));
    // 分隔點跟它後面那段綁在同一個 span：拆成兩個 flex item，窄螢幕會在「・」後面斷行，
    // 留一個孤零零的點在上一行的行尾。
    line.append(h('span.dim', { text: `・學過 ${num(task.seen)} / ${num(task.total)}` }));
    return line;
  }
  // 舊版寫成「14 張 ＝ 到期 6 ＋ 新 8」，那個 14 是假的：新卡那 8 張的額度
  // 另一科也在用，兩科的數字不能相加。所以只寫到期的實數，新卡改成「最多」。
  if (task.due > 0) {
    line.append(h('span.n.num', { text: num(task.due) }), h('span.u', { text: ' 張到期' }));
  } else {
    line.append(h('span.dim', { text: '沒有到期的' }));
  }
  if (task.newAvailable > 0) {
    line.append(h('span.sep', { text: '・' }));
    // 不設上限時沒有共用額度，這個數就是這一科還剩幾張新卡，不必再寫「最多」。
    line.append(h('span.part', {
      text: task.newUnlimited
        ? `還有 ${num(task.newAvailable)} 張新卡`
        : `可再學新卡最多 ${num(task.newAvailable)} 張`,
    }));
  }
  return line;
}

/** 按鈕文案。只有到期數是這一科獨有的，其餘一律不給數字。 */
function buttonText(task) {
  if (task.due > 0) return `練 ${num(task.due)} 張到期`;
  return '開始學新卡';
}

async function toggleDoc(task, panel, btn) {
  if (!panel.hidden) {
    panel.hidden = true;
    btn.textContent = '打開說明';
    return;
  }
  panel.hidden = false;
  btn.textContent = '收起說明';
  if (panel.dataset.loaded) return;

  clear(panel).append(h('p.doc-loading', { text: '讀取中…' }));
  let doc;
  try {
    doc = await api.doc(task.id.toLowerCase());
  } catch (err) {
    clear(panel).append(h('p.doc-error', { text: err.message }));
    return;
  }
  panel.dataset.loaded = '1';
  clear(panel);

  const bar = h('div.doc-bar', {}, h('span.doc-path', { text: doc.path }));
  const prompt = firstFence(doc.text);
  if (prompt) {
    // PE／PO 那兩份文件的重點是那段 prompt，而不是文件本身。
    // 讓人不用捲到中間再手動選取——這一步的摩擦足以讓一次練習不會發生。
    const copy = h('button.btn.btn-sm.btn-primary', { type: 'button', text: '複製 GPT prompt' });
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(prompt);
        copy.textContent = '已複製';
      } catch {
        copy.textContent = '複製失敗，請自己選取';
      }
      setTimeout(() => { copy.textContent = '複製 GPT prompt'; }, 2400);
    });
    bar.append(copy);
  }
  panel.append(bar);
  // 這三份文件裡有十幾張表格，PE／PO 那兩份的評分格是全文最該讀懂的東西。
  // 原樣印在 <pre> 裡的話，表格只是一堆對不齊的直線，等於沒有。
  panel.append(renderMarkdown(doc.text));
}

/** 取出第一段 ``` 圍起來的內容。取不到就回 null，呼叫端不顯示複製鍵。 */
function firstFence(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trimEnd() === '```');
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && l.trimEnd() === '```');
  if (end < 0) return null;
  return lines.slice(start + 1, end).join('\n').trim() || null;
}

function footer(data) {
  const bits = data.newLimit === null
    ? [
      // 不設上限時「今天總共幾張」會把一萬多張沒學過的卡全算進去，那個數沒有意義，所以不寫。
      `今天到期 ${num(data.dueTotal)} 張；新卡不設上限，今天已學 ${num(data.newToday)} 張。`,
      // 這是使用者自己選的，但代價要寫在看得到的地方。
      '新卡幾天內都會回來變成到期卡，累積起來有多少到推演頁算。',
    ]
    : [
      `今天總共 ${num(data.dayTotal)} 張：到期 ${num(data.dueTotal)} 張，新卡最多 ${num(data.newAvailable)} 張（每日上限 ${data.newLimit}，已用 ${data.newToday}）。`,
      // 額度共用是上面每一列都不寫總數的原因，所以這句要留在這裡當總解釋。
      '新卡額度兩科共用，先打開哪一科就先用掉。',
    ];
  // pendingCards 為 0 已經代表每一科「到期 0、可學新卡 0」，不必再另外看額度。
  if (data.pendingCards === 0) {
    bits.unshift('卡片的部分今天已經清空了。');
  }
  // 起始等級會讓某些新卡永遠不出現。不寫出來的話，A1 那一千多張會像是被弄丟了。
  if (data.startLevel && data.startLevel !== 'A1') {
    bits.push(`新卡從 ${data.startLevel} 起，更低等級的新卡不會出現；已經學過的照常複習。`);
  }
  // 卡片做完不等於今天做完：CO／PO 沒有卡片，PE 的卡片也練不到整篇作文。
  // 這句話放在頁尾，因為它問的是「今天還剩什麼」，那正是頁尾在回答的事。
  if (data.pendingChecks > 0) {
    const names = data.tasks.filter((t) => t.checkable && !t.done).map((t) => t.id).join('／');
    bits.push(`還有 ${data.pendingChecks} 科要完成實作練習或打卡：${names}。`);
  }
  return h('p.today-foot', { text: bits.join('') });
}
