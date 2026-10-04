/**
 * 「今天」頁。整個工具的入口：打開之後第一眼看到的東西。
 *
 * 它要回答的只有一個問題——**現在坐下來，先做哪一件事**。
 * 版面照報紙頭版排：報頭一行日期；左邊一個大數字（倒數）與全頁唯一一顆實心按鈕；
 * 右欄放「今日一句」與「這 7 天穩下來的字」；底下一張四科帳本。
 * 右欄回答的是「做這些有沒有用」，所以字級比左邊低一層，不能搶「先做哪一件事」的位置。
 *
 * 帳本每一列刻意不報「今天這一科共幾張」：新卡額度是全站共用的，
 * 兩科各報一個含新卡的總數，讀的人相加就會得到一個不存在的數字。
 * 單科只寫自己的到期量，共用的部分統一由主按鈕旁那一行交代。
 *
 * 三件事刻意跟其他頁不一樣：
 *  1. **不受題型篩選影響。**這一頁問的是「今天整體該做什麼」，
 *     被篩選改掉就變成「今天在我挑剩的範圍裡該做什麼」，那是複習頁的工作。
 *  2. **CO／PO 不顯示熟練度，只顯示做過沒做過。**題庫裡沒有音檔也沒有錄音評分，
 *     系統判不了你講得好不好，畫一條熟練度就是假的。但「今天做了」這件事
 *     使用者自己知道，給一顆打卡鍵按下去就記得住——不記的話隔天完全翻不出痕跡，
 *     昨天等於沒發生。分界線在這裡：熟練度不假裝，做過沒做過照實記。
 *  3. **PE 那一列同時有卡片與打卡。**卡片練零件，整篇作文練評分格上卡片碰不到的那 10 分。
 *     只給卡片按鈕的話，這一頁會讓人以為把 PE 的卡片清光就等於練了寫作。
 */

import { h, clear, icon, num } from './dom.mjs';
import { api } from './net.mjs';
import { render as renderMarkdown } from './markdown.mjs';
import * as motion from './motion.mjs';
import { KIND_ZH } from './kinds.mjs';

const WEEKDAY = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
const ROMAN_MONTH = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
/**
 * 四科的中文名。主鍵寫「練聽力」、旁邊那句卻寫「還沒打卡：CO／PO」，同一眼讀到兩套叫法；
 * 按鍵、打卡鍵與待打卡清單都從這裡拿。帳本列的科目代號是給對照官方評分格用的，不在此列。
 */
const SKILL_ZH = { CE: '閱讀', PE: '寫作', CO: '聽力', PO: '口說' };

export function todayView(root, ctx) {
  const box = h('div.today');
  root.append(box);
  box.append(skeleton());

  let dead = false;
  load();
  return () => { dead = true; motion.killWithin(box); };

  async function load() {
    let data;
    try {
      data = await api.today();
    } catch (err) {
      if (dead) return;
      clear(box).append(h('div.errorbox', {},
        icon('alert'),
        h('p', { text: `讀不到今天的資料：${err.message}` }),
        h('button.btn', { type: 'button', text: '再試一次', onclick: () => { clear(box).append(skeleton()); load(); } }),
      ));
      return;
    }
    if (dead) return;
    const alive = () => !dead;

    // 打卡之後只換掉主按鈕與帳本那一列，不整頁重畫：說明文件展開著的時候
    // 重畫會把它收起來，而按打卡的那一刻通常正是照著文件做完的那一刻。
    const hero = heroBlock(data, ctx);
    const ledger = ledgerBlock(data, ctx, (next) => {
      hero.update(next);
      ledger.update(next);
    });
    // 下面兩塊各自再撈一次，不併進 /api/today：推演要跑兩次模擬，
    // 等它算完才出畫面的話，打開這一頁到能按下主按鈕會多等將近 0.1 秒。
    const side = h('aside.today-side', { 'aria-label': '今日一句與這 7 天穩下來的字' },
      readingBlock(alive),
      weeklyBlock(alive));

    clear(box).append(
      dateline(data),
      h('div.today-hero', {}, hero.el, side),
      ledger.el,
    );
    if (hero.cast) fillOutlook(hero.cast, alive);

    // 這一頁的三個招牌動作：倒數滾上來、帳本逐列浮出（條一起長）、打卡蓋章。其餘都不動。
    if (data.daysLeft !== null) motion.countUp(hero.num, Math.abs(data.daysLeft));
    motion.rise([hero.cap, hero.cast, hero.act, side], { delay: 0.2, stagger: 0.08 });
    motion.rise(ledger.rows, { y: 8, delay: 0.4, stagger: 0.06, duration: 0.45 });
    motion.grow(ledger.bars, { delay: 0.6 });
  }
}

function skeleton() {
  const box = h('div.today-skel', { 'aria-busy': 'true' });
  for (const [w, hh] of [['100%', 28], ['38%', 140], ['22%', 44], ['100%', 220]]) {
    const bar = h('div.skeleton');
    bar.style.width = w;
    bar.style.height = `${hh}px`;
    box.append(bar);
  }
  return box;
}

/** 報頭。法文日期放大，因為考場裡的日期是法文寫的；中文那行帶連續天數與今天答了幾題。 */
function dateline(data) {
  const d = new Date(`${data.day}T00:00:00`);
  const fr = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }).format(d);
  return h('header.dateline', {},
    h('p.dateline-fr', { lang: 'fr', text: fr[0].toUpperCase() + fr.slice(1) }),
    h('p.dateline-zh', {},
      h('span', { text: `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${WEEKDAY[d.getDay()]}` }),
      h('span', { text: runLine(data) })));
}

function runLine(data) {
  const bits = [];
  bits.push(data.streakDays > 0 ? `連續 ${num(data.streakDays)} 天` : '連續紀錄還沒開始');
  bits.push(data.reviewsToday > 0 ? `今天答了 ${num(data.reviewsToday)} 題` : '今天還沒動過');
  return bits.join(' · ');
}

function zhDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${y} 年 ${m} 月 ${d} 日`;
}

/**
 * 左欄：倒數、推演一句、主按鈕。
 * 倒數是全頁字最大的東西。日期本身沒有人記得住，「還有幾天」才會逼人動作。
 */
function heroBlock(data, ctx) {
  const left = data.daysLeft;
  const numEl = left === null ? null : h('span.num', { text: num(Math.abs(left)) });
  const top = left === null
    ? h('p.hero-none', { text: '還沒設考試日期' })
    : h('p.hero-num', {}, numEl);
  const cap = h('p.hero-cap', {
    text: left === null
      ? '在「更多 › 設定」填上，這裡會變成倒數。'
      // 不寫死哪一級：B1 考完後這個日期會改成 B2 的，寫死會讓倒數掛錯考試名。
      : left >= 0 ? `天後考試，${zhDate(data.examDate)}` : '天前考完了。記得到設定裡改成下一場的日期。',
  });
  // 先佔住一行，模擬算完再換字；不佔的話那一行晚到會把主按鈕往下推。
  const cast = left !== null && left >= 0
    ? h('div.hero-cast', { 'aria-busy': 'true' },
      h('p.cast-note', { text: '正在推演考試那天記得幾張…' }))
    : null;
  const act = h('div.hero-act');
  paint(data);
  return {
    el: h('div.hero-main', {}, top, cap, cast, act),
    num: numEl, cap, cast, act,
    update: paint,
  };

  function paint(d) {
    const lead = pickLead(d.tasks);
    clear(act);
    if (!lead) {
      act.append(
        h('p.hero-done', {}, icon('check'), h('span', { text: '今天的份都做完了' })),
        h('button.btn', { type: 'button', text: '再練一些', onclick: () => ctx.startReview({ kinds: cardKinds(d.tasks) }) }));
      return;
    }
    if (lead.action === 'cards') {
      const go = h('button.btn.btn-primary.hero-go', {
        type: 'button',
        onclick: () => ctx.startReview({ kinds: cardKinds(d.tasks), guided: true }),
      });
      if (d.dueTotal > 0) go.append('開始複習 ', h('span.num', { text: num(d.dueTotal) }), ' 張');
      else go.append('開始學新卡');
      act.append(go, h('p.hero-meta', { text: newCardLine(d) }));
      return;
    }
    act.append(
      h('button.btn.btn-primary.hero-go', {
        type: 'button',
        text: practiceWords(lead.task.id),
        onclick: () => ctx.openPractice(lead.task.id, { guided: true }),
      }),
      // 卡片做完不等於今天做完：CO／PO 沒有卡片，PE 的卡片也練不到整篇作文。
      h('p.hero-meta', { text: `卡片清完了。還沒打卡：${pendingNames(d)}` }));
  }
}

/**
 * 新卡那一句。額度共用是帳本每一列都不寫總數的原因，所以這句要留在主按鈕旁當總解釋。
 * 不設上限時「今天總共幾張」會把一萬多張沒學過的卡全算進去，那個數沒有意義，所以只寫剩幾張沒學。
 */
function newCardLine(d) {
  if (d.newLimit === null) {
    return d.newAvailable > 0
      ? `另有新卡 ${num(d.newAvailable)} 張，今天學了 ${num(d.newToday)} 張`
      : '新卡都學過了';
  }
  return d.newAvailable > 0
    ? `新卡今天還能學 ${num(d.newAvailable)} 張（${d.newToday}/${d.newLimit}），閱讀與寫作共用`
    : `今天的新卡額度用完了（${d.newToday}/${d.newLimit}）`;
}

function cardKinds(tasks) {
  return [...new Set(tasks.filter((t) => t.mode === 'cards').flatMap((t) => t.kinds))];
}

function pendingNames(d) {
  return d.tasks.filter((t) => t.checkable && !t.done).map((t) => SKILL_ZH[t.id] ?? t.id).join('、');
}

/**
 * 整頁只留一顆實心主鍵：每列各一顆 primary 時，眼睛找不到「現在先做哪一個」。
 * 還有卡片就是複習；卡片清完了，換成帳本順序第一個還沒打卡的文件列。
 */
function pickLead(tasks) {
  for (const task of tasks) {
    if (task.mode === 'cards' && task.count > 0) return { task, action: 'cards' };
  }
  for (const task of tasks) {
    if (task.checkable && !(task.practiced || task.done)) return { task, action: 'practice' };
  }
  return null;
}

/**
 * 「照這個節奏，考試那天大約記得幾張」。
 *
 * 跟連續天數不同，這個數字會因為少做而往下掉——隔一天沒做，7 天平均就少七分之一。
 * 同時寫出「完全停下來剩幾張」：只有一個數字的話，讀的人不知道現在做的事值多少。
 */
async function fillOutlook(el, alive) {
  let o;
  try {
    o = await api.outlook();
  } catch (err) {
    if (alive()) {
      el.removeAttribute('aria-busy');
      el.replaceChildren(h('p.cast-note.err-line', {},
        `推演失敗：${err.message}`,
        h('button.btn.btn-quiet.btn-sm', { type: 'button', text: '再試一次', onclick: () => {
          el.setAttribute('aria-busy', 'true');
          el.replaceChildren(h('p.cast-note', { text: '正在推演考試那天記得幾張…' }));
          fillOutlook(el, alive);
        } }),
      ));
    }
    return;
  }
  if (!alive()) return;
  if (!o.examDate) {
    el.remove();
    return;
  }
  el.removeAttribute('aria-busy');
  el.title = `A2–B2 共 ${num(o.cardsInScope)} 張卡的模擬，細節在進度頁。`;
  // pace 是 windowReviews ÷ 7 四捨五入，7 天內答 3 題也是 0。那時說「沒有作答」等於否認剛做完的事。
  // pace 為 0 時「照節奏」與「停下來」是同一場模擬，畫兩條一樣長的條沒有資訊，只留一句話。
  if (o.pace === 0) {
    const head = o.windowReviews > 0
      ? `最近 ${o.window} 天做了 ${num(o.windowReviews)} 題，平均每天不到 1 題。照這樣到考試那天，約記得 `
      : `最近 ${o.window} 天沒有作答。照這樣到考試那天，只記得 `;
    el.replaceChildren(h('p.cast-note', {}, head, h('strong.num', { text: num(o.stoppedRecall) }), ' 張。'));
    return;
  }
  // 條的長度以「照節奏」那條為滿，不以題庫總數為滿：A2–B2 兩萬多張，
  // 記得一千張畫出來不到 5%，兩條都貼在左邊，看不出差距——而這一塊要給人看的就是差距。
  const top = Math.max(o.expectedRecall, o.stoppedRecall, 1);
  const row = (key, label, value) => {
    const fill = h('i');
    fill.style.width = `${(value / top) * 100}%`;
    return {
      fill,
      el: h(`div.cast-row.cast-${key}`, {},
        h('span.cast-k', { text: label }),
        h('span.cast-bar', { 'aria-hidden': 'true' }, fill),
        h('span.cast-v', {}, h('b.num', { text: num(value) }), ' 張')),
    };
  };
  const go = row('go', `每天 ${num(o.pace)} 題`, o.expectedRecall);
  const stop = row('stop', '今天起停下', o.stoppedRecall);
  const gain = o.expectedRecall - o.stoppedRecall;
  const note = gain > 0
    ? `考試那天記得的張數，照最近 ${o.window} 天的節奏推演。差的 ${num(gain)} 張，是每天這 ${num(o.pace)} 題換來的。`
    : `考試那天記得的張數，照最近 ${o.window} 天的節奏推演。`;
  el.replaceChildren(go.el, stop.el, h('p.cast-note', { text: note }));
  motion.grow([go.fill, stop.fill], { delay: 0.1, stagger: 0.12 });
}

const WORD_TIER = {
  mature: '穩了',
  seen: '學過',
  fresh: '還沒學',
};

/**
 * 「這句你認得幾個字」。把詞彙量換成讀一句法文時的實際感受——CE 考的就是這件事。
 *
 * 分母只算題庫收了的字。de／le／vous 這類虛詞題庫沒收，算進去的話分數永遠偏低，
 * 而且低的原因跟學了多少無關；排除了就要在畫面上說，不然 6／13 會被讀成整句只有 13 個字。
 */
function readingBlock(alive) {
  const sec = h('section.side-block.reading', {}, h('h2.side-h', { text: '今日一句' }));
  let index;
  load();
  return sec;

  async function load(i) {
    let data;
    try {
      data = await api.sentence(i);
    } catch (err) {
      if (alive()) sec.replaceChildren(h('h2.side-h', { text: '今日一句' }), h('p.side-err.err-line', {},
        `句子載入失敗：${err.message}`,
        h('button.btn.btn-quiet.btn-sm', { type: 'button', text: '再試一次', onclick: () => load(i) }),
      ));
      return;
    }
    if (!alive()) return;
    if (!data.sentence) {
      sec.replaceChildren(h('h2.side-h', { text: '今日一句' }), h('p.side-foot', { text: '題庫裡沒有可以讀的句子。' }));
      return;
    }
    index = data.index;
    const { tokens, counts, src } = data.sentence;
    const line = h('p.sentence', { lang: 'fr' });
    for (const t of tokens) {
      if (!t.status) line.append(t.text);
      else if (t.status === 'outside') line.append(h('span.w', { dataset: { tier: 'outside' }, text: t.text }));
      else {
        // 游標停上去看得到還原成哪個字：souhaiteriez 算的是 souhaiter 那張卡。
        const tip = t.word === t.text.toLowerCase() ? WORD_TIER[t.status] : `${t.word}・${WORD_TIER[t.status]}`;
        line.append(h('span.w', { dataset: { tier: t.status }, title: tip, text: t.text }));
      }
    }
    const next = h('button.btn.btn-quiet.btn-sm', { type: 'button', text: '換一句', title: `第 ${index + 1} 句，共 ${data.total} 句` });
    next.addEventListener('click', () => {
      next.disabled = true;
      load(index + 1);
    });
    const score = `認得 ${num(counts.seen)}／${num(counts.inBank)} 個字${counts.mature > 0 ? `，${num(counts.mature)} 個穩了` : ''}`;
    const outside = counts.outside > 0 ? `。冠詞、代名詞這類題庫沒收的 ${num(counts.outside)} 個不計` : '';
    sec.replaceChildren(
      h('div.side-head', {}, h('h2.side-h', { text: '今日一句' }), next),
      line,
      h('p.side-foot', { text: `${score}${outside}${src ? `。出處：${src}` : ''}` }),
      h('ul.reading-legend', {},
        ['mature', 'seen', 'fresh'].map((tier) => h('li', {}, h('span.w', { dataset: { tier }, text: 'mot' }), WORD_TIER[tier])),
        h('li', {}, h('span.w', { dataset: { tier: 'outside' }, text: 'mot' }), '不計')),
    );
  }
}

/**
 * 最近 7 天「第一次穩了」的卡。其他地方看到的都是「還欠多少」，只有這裡是「學會了什麼」。
 * 用滾動 7 天而不是日曆週：週一打開時日曆週幾乎一定是空的。標題因此寫「這 7 天」不寫「本週」。
 */
function weeklyBlock(alive) {
  const sec = h('section.side-block.weekly', {}, h('h2.side-h', { text: '這 7 天穩下來的字' }));
  load();
  return sec;

  async function load() {
    let data;
    try {
      data = await api.weekly();
    } catch (err) {
      // 重試前先拿掉上一次的錯誤句，不然連按兩次會疊兩行。
      if (alive()) sec.append(h('p.side-err.err-line', {},
        `載入失敗：${err.message}`,
        h('button.btn.btn-quiet.btn-sm', { type: 'button', text: '再試一次', onclick: (ev) => { ev.currentTarget.parentElement.remove(); load(); } }),
      ));
      return;
    }
    if (!alive()) return;
    const range = `${data.from.slice(5)}～${data.to.slice(5)}`;
    const list = (items) => h('ul.stable', {}, items.map((it) => h('li', {},
      h('span.fr', { lang: 'fr', text: it.label }),
      h('span.gl', { text: it.sub || KIND_ZH[it.kind] || '' }),
      h('span.d.num', { text: `${num(Math.round(it.stability))} 天`, title: `${it.day} 跨過 21 天` }))));
    const head = h('div.side-head', {},
      h('h2.side-h', { text: '這 7 天穩下來的字' }),
      data.items.length ? h('span.side-n.num', { text: `${num(data.items.length)} 張` }) : null);
    const body = data.items.length === 0
      ? [h('p.side-empty', { text: `${range} 沒有卡第一次跨過 21 天。` })]
      : [
        list(data.items.slice(0, 5)),
        data.items.length > 5 ? h('details.side-more', {},
          h('summary', { text: `再看 ${num(data.items.length - 5)} 張` }), list(data.items.slice(5))) : null,
      ];
    // 原生 replaceChildren 會把 null 印成字串「null」；h() 會濾掉，這裡要自己濾。
    sec.replaceChildren(head, ...body.filter(Boolean),
      h('p.side-foot', { text: `九成記憶能撐 21 天以上就算穩。目前共 ${num(data.matureTotal)} 張。` }));
  }
}

/** 四科帳本。一科一列，由左到右：代號、科名、進度、今天的量、動作。 */
function ledgerBlock(data, ctx, onChange) {
  const pend = h('span.ledger-pend');
  const rows = data.tasks.map((task) => ledgerRow(task, ctx, onChange));
  const el = h('section.ledger', { 'aria-labelledby': 'ledger-h' },
    h('div.ledger-head', {}, h('h2.side-h#ledger-h', { text: '四科' }), pend),
    ...rows.map((r) => r.row),
    // 這一句是打卡功能的但書，任何時候都要在：打卡只證明「有坐下來做」，
    // 不證明做得對，系統仍然沒有能力判斷打卡記的那件事。四列共用，所以只寫一次。
    h('p.ledger-note', { text: '打卡只記有沒有做，不評分。時間、草稿與分數在工作台另存。' }));
  update(data);
  return { el, rows: rows.map((r) => r.row), bars: rows.map((r) => r.bar).filter(Boolean), update };

  function update(d) {
    pend.textContent = d.pendingChecks > 0 ? `還沒打卡：${pendingNames(d)}` : '';
  }
}

function ledgerRow(task, ctx, onChange) {
  const row = h('article.lrow', { dataset: { skill: task.id, mode: task.mode } });
  const links = h('div.lrow-links');
  const subj = h('div.lrow-subj', {},
    h('h3.lrow-name', {},
      // 考卷上印的是法文名稱，考場裡認得的必須是這一行，所以法文在上、放大。
      h('span.fr', { lang: 'fr', text: task.fr }),
      h('span.zh', { text: task.zh })));
  // 文件型（CO／PO）沒有卡片數字，「今天做什麼」就是這一列的正文。
  if (task.mode === 'doc') subj.append(h('p.lrow-do', { text: task.hint }));
  subj.append(links);

  const meter = h('div.lrow-meter');
  const due = h('div.lrow-due');
  const act = h('div.lrow-act');
  row.append(h('span.lrow-code', { text: task.id }), subj, meter, due, act);

  if (task.mode === 'cards') {
    act.append(task.count > 0
      ? h('button.btn', { type: 'button', text: task.due > 0 ? '複習' : '學新卡', onclick: () => ctx.startReview({ kinds: task.kinds }) })
      : h('button.btn.btn-quiet', { type: 'button', text: '再練', onclick: () => ctx.startReview({ kinds: task.kinds }) }));
    links.append(h('button.btn.btn-quiet.btn-sm', { type: 'button', text: practiceWords(task.id), onclick: () => ctx.openPractice(task.id) }));
  } else {
    act.append(h('button.btn', { type: 'button', text: practiceWords(task.id), onclick: () => ctx.openPractice(task.id) }));
  }

  if (task.doc) {
    const panel = h('div.doc', { hidden: true });
    const openBtn = h('button.btn.btn-quiet.btn-sm', { type: 'button', text: '說明', 'aria-expanded': 'false' });
    openBtn.addEventListener('click', () => toggleDoc(task, panel, openBtn));
    links.append(openBtn);
    row.append(panel);
  }

  let check = null;
  if (task.checkable) {
    check = h('div.lrow-check');
    act.append(check);
  }

  const bar = h('i');
  meter.append(h('span.bar', { 'aria-hidden': 'true' }, bar), h('span.bar-cap'));
  paint(false);
  return { row, bar };

  function paint(animate) {
    row.dataset.done = task.done || task.practiced ? '1' : '0';
    paintMeter(task, meter, bar);
    paintDue(task, due);
    if (!check) return;
    const stamped = paintCheck(task, check, () => toggleCheck(task, ctx, (next) => {
      paint(true);
      onChange(next);
    }));
    if (animate && stamped) motion.stamp(stamped, row);
  }
}

/**
 * 進度條。卡片科畫「見過幾張」，文件科畫「最近 7 天做了幾天」。
 * 後者只是個次數，不是日曆：後端只給天數不給是哪幾天，畫成七個格子會讓人以為看得出是哪天漏掉的。
 */
function paintMeter(task, meter, bar) {
  const cap = meter.querySelector('.bar-cap');
  const bits = [];
  let ratio;
  if (task.mode === 'cards') {
    ratio = task.total ? task.seen / task.total : 0;
    bits.push(`見過 ${num(task.seen)} / ${num(task.total)}`);
  } else {
    ratio = task.window ? task.recent / task.window : 0;
  }
  if (task.checkable) bits.push(recentText(task));
  if (!task.checkable && task.practiced) bits.push(`今天練過：${attemptText(task.attempt)}`);
  // 0 也留 2px：完全沒有條的話，看不出這一列是「零」還是「沒有這個欄位」。
  bar.style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
  cap.textContent = bits.join(' · ');
}

function recentText(task) {
  const verb = task.mode === 'cards' ? '寫了' : '做了';
  if (task.recent > 0) return `近 ${task.window} 天${verb} ${num(task.recent)} 天`;
  if (task.lastDay) return `上次是 ${task.lastDay.slice(5)}`;
  return `近 ${task.window} 天沒有紀錄`;
}

function attemptText(attempt) {
  if (!attempt) return '已有紀錄';
  const bits = [];
  if (attempt.durationSec) bits.push(`${Math.max(1, Math.round(attempt.durationSec / 60))} 分鐘`);
  if (attempt.wordCount) bits.push(`${num(attempt.wordCount)} mots`);
  if (attempt.score !== null) bits.push(`${attempt.score}/${attempt.maxScore}`);
  return bits.join('・') || '已有紀錄';
}

/**
 * 今天的量。只寫到期的實數：舊版寫成「14 張 ＝ 到期 6 ＋ 新 8」，那個 14 是假的——
 * 新卡那 8 張的額度另一科也在用，兩科的數字不能相加。
 */
function paintDue(task, due) {
  clear(due);
  if (task.mode !== 'cards') {
    due.append(h('span.dim', { text: '沒有卡片' }));
    return;
  }
  if (task.total === 0) {
    due.append(h('span.dim', { text: '沒有卡片' }));
    return;
  }
  if (task.count === 0) {
    due.append(h('span.ok', {}, icon('check'), h('span', { text: '做完了' })));
    return;
  }
  if (task.due > 0) {
    due.append(h('b.num', { text: num(task.due) }), h('span', { text: ' 張到期' }));
    return;
  }
  due.append(h('span.dim', { text: '只剩新卡' }));
}

/**
 * 打卡鍵的文案。PE 打的是「寫了一篇」，跟 CO／PO 的「做過了」不是同一件事，不共用字。
 * CO 與 PO 的鍵在畫面上長得一樣，讀螢幕時只能靠這裡的科目名分開，所以要寫進去。
 */
function checkWords(task) {
  if (task.mode === 'cards') return { todo: '記下今天寫過作文', done: '今天寫過一篇了', mark: '寫過' };
  const zh = SKILL_ZH[task.id] ?? task.id;
  return { todo: `記下今天練過${zh}`, done: `今天練過${zh}了`, mark: '練過' };
}

/**
 * 打卡鍵。沒打卡是一顆外框鍵；打過就換成一枚蓋在同一個位置的日期章。
 * 章本身也是按鈕，按了是撤銷——撤銷在事實檔裡是追加一行 done:false，不會改掉原來那行。
 * 回傳章的元素（若這次畫的是章），呼叫端決定要不要播蓋章動畫。
 */
function paintCheck(task, cell, onToggle) {
  const w = checkWords(task);
  clear(cell);
  if (!(task.done || task.practiced)) {
    cell.append(h('button.btn.check-btn', { type: 'button', text: '打卡', title: w.todo, 'aria-label': w.todo, onclick: onToggle }));
    return null;
  }
  const d = new Date();
  const stamp = h('button.stamp', {
    type: 'button',
    onclick: task.practiced ? null : onToggle,
    disabled: task.practiced,
    title: task.practiced ? '已由工作台的練習紀錄完成' : `${w.done}，按一下取消`,
    'aria-label': task.practiced ? `${w.done}，由練習紀錄完成` : `${w.done}，按一下取消`,
  },
  h('span', { text: w.mark }),
  h('b', { lang: 'fr', text: `${d.getDate()} · ${ROMAN_MONTH[d.getMonth()]}` }));
  cell.append(stamp);
  return stamp;
}

async function toggleCheck(task, ctx, done) {
  let data;
  try {
    data = await api.checkin({ skill: task.id, done: !task.done });
  } catch (err) {
    ctx.toast(err.message, 'bad');
    return;
  }
  // 用伺服器回來的那一份覆蓋手上的 task，不自己把 done 反過來寫：
  // recent 與 lastDay 只有後端算得出來，猜的話畫面會跟事實檔分岔。
  Object.assign(task, data.tasks.find((t) => t.id === task.id));
  done(data);
}

// 頭版主按鈕與四科列共用。四顆按下去都是同一種計時工作台，名字就用同一個句型；
// 科目要寫進去，讀螢幕的人才分得出是哪一顆。
function practiceWords(skill) {
  return SKILL_ZH[skill] ? `練${SKILL_ZH[skill]}` : '開始練習';
}

async function toggleDoc(task, panel, btn) {
  if (!panel.hidden) {
    panel.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    return;
  }
  panel.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  if (panel.dataset.loaded) return;

  clear(panel).append(h('p.doc-loading', { text: '讀取中…' }));
  let doc;
  try {
    doc = await api.doc(task.id.toLowerCase());
  } catch (err) {
    // 重試走同一條路：先收起來再打開，讀取中的提示與 aria-expanded 都照原本的流程更新。
    clear(panel).append(h('p.doc-error.err-line', {},
      `讀不到說明文件：${err.message}`,
      h('button.btn.btn-quiet.btn-sm', { type: 'button', text: '再試一次', onclick: () => {
        panel.hidden = true;
        toggleDoc(task, panel, btn);
      } }),
    ));
    return;
  }
  panel.dataset.loaded = '1';
  clear(panel);

  const bar = h('div.doc-bar', {}, h('span.doc-path', { text: doc.path }));
  const prompt = firstFence(doc.text);
  if (prompt) {
    // PE／PO 那兩份文件的重點是那段 prompt，而不是文件本身。
    // 讓人不用捲到中間再手動選取——這一步的摩擦足以讓一次練習不會發生。
    const copy = h('button.btn.btn-sm', { type: 'button', text: '複製 GPT prompt' });
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
