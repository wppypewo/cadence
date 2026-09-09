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
 * 兩件事刻意跟其他頁不一樣：
 *  1. **不受側欄的題型篩選影響。**這一頁問的是「今天整體該做什麼」，
 *     被篩選改掉就變成「今天在我挑剩的範圍裡該做什麼」，那是複習頁的工作。
 *  2. **CO／PO 不顯示進度。**題庫裡沒有音檔也沒有錄音評分，
 *     系統真的不知道你有沒有做。與其畫一條假的進度條，不如把當天該做的事寫出來。
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
    for (const task of data.tasks) list.append(taskRow(task, ctx));
    box.append(list);
    box.append(footer(data));
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
    : `距離 ${data.examDate} 的 DELF B1${left < 0 ? '（日期已過，記得改）' : ''}`;

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

function taskRow(task, ctx) {
  const row = h('article.task', { dataset: { skill: task.id, mode: task.mode } });

  row.append(h('div.task-code', {}, h('span', { text: task.id })));

  const main = h('div.task-main', {},
    h('h2.task-name', {},
      h('span.zh', { text: task.zh }),
      h('span.fr', { lang: 'fr', text: task.fr }),
    ),
  );

  if (task.mode === 'cards') {
    main.append(countLine(task));
    main.append(h('p.task-hint', { text: task.hint }));
    row.append(main);
    row.append(h('div.task-act', {},
      task.count > 0
        ? h('button.btn.btn-primary', {
          type: 'button',
          // 按鈕上只放「到期」那個數字。到期卡是這一科自己的，加得起來；
          // 新卡額度兩科共用，寫進按鈕會讓人以為 CE 的 8 張和 PE 的 8 張是十六張。
          text: buttonText(task),
          onclick: () => { ctx.setScope(task.kinds); ctx.go('review', { force: true }); },
        })
        : h('button.btn.btn-quiet', {
          type: 'button',
          text: '再多練一些',
          onclick: () => { ctx.setScope(task.kinds); ctx.go('review', { force: true }); },
        }),
    ));
    return row;
  }

  // 文件型（CO／PO）
  // 先寫「今天做什麼」，再寫「系統管不到」。倒過來的話，那句警告會比指示更搶眼，
  // 但它只是個限制說明，不是要人處理的問題。
  main.append(h('p.task-do', { text: task.hint }));
  main.append(h('p.task-untracked', { text: '這一科系統記不到進度，做完了只有你自己知道。' }));
  const panel = h('div.doc', { hidden: true });
  main.append(panel);
  row.append(main);

  const openBtn = h('button.btn.btn-quiet', { type: 'button', text: '打開說明' });
  openBtn.addEventListener('click', () => toggleDoc(task, panel, openBtn));
  row.append(h('div.task-act', {}, openBtn));
  return row;
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
    line.append(h('span.part', { text: `可再學新卡最多 ${num(task.newAvailable)} 張` }));
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
    // PO 那份文件的重點是那段 prompt，而不是文件本身。
    // 讓人不用捲到中間再手動選取——這一步的摩擦足以讓一次口說練習不會發生。
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
  // 這兩份文件裡有 11 張表格，PO 那份的評分格是全文最該讀懂的東西。
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
  const bits = [
    `今天總共 ${num(data.dayTotal)} 張：到期 ${num(data.dueTotal)} 張，新卡最多 ${num(data.newAvailable)} 張。`,
    `每日新卡上限 ${data.newLimit} 張，今天已用 ${data.newToday} 張，剩 ${data.newBudget} 張。`,
    // 額度共用是上面每一列都不寫總數的原因，所以這句要留在這裡當總解釋。
    '這個額度兩科共用：先打開哪一科，那一科就先把額度用掉。',
  ];
  if (data.pendingCards === 0 && data.newBudget === 0) {
    bits.unshift('卡片的部分今天已經清空了。');
  }
  return h('p.today-foot', { text: bits.join('') });
}
