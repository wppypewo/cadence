/**
 * 進度頁的「現況」。這一頁的存在理由是回答四個人腦記不住的問題：
 *   1. 我到底練到哪了？（各題型的已掌握／學過／未學）
 *   2. 我有沒有在練？（每日熱力圖與連續天數）
 *   3. 我哪裡最弱？（錯最多次的卡，附上最近一次是怎麼錯的）
 *   4. 我未來給自己排了多少工作？（到期量預估）
 *
 * 沒有一個數字是裝飾用的。看不出能改變行為的圖就不畫。
 *
 * 「推演」是同一頁的另一個分頁（forecast.mjs）。兩者共用頁首——分頁與範圍鈕——
 * 所以 progressHead() 與 section() 從這裡匯出，推演頁引用同一份。
 */

import { h, clear, pct, num } from './dom.mjs';
import { api } from './net.mjs';
import { bars, heatmap, line, reasonBars } from './charts.mjs';
import * as motion from './motion.mjs';
import { KIND_ZH, cardHead } from './kinds.mjs';

const REASON_ZH = {
  wrong: '拼錯', accent: '漏重音', case: '大小寫', empty: '沒作答',
  elision: '省音', family: '性數／形式', missing: '少要素', article: '冠詞錯',
};
const REASON_COLOR = {
  wrong: 'var(--bad)',
  accent: 'var(--warn)',
  case: 'var(--text-faint)',
  empty: 'var(--line-strong)',
  // 挑連接詞的兩種「選對了但寫錯」。歸在警示色，與純粹選錯格分開看。
  elision: 'var(--warn)',
  family: 'var(--warn)',
  // 改寫題缺了指定的連接詞或語氣。跟拼錯是同一級的錯，用同一個顏色。
  missing: 'var(--bad)',
  // 名詞化只錯冠詞：名詞本身挑對了，跟完全不會不是同一級，歸警示色。
  article: 'var(--warn)',
};

// 弱點練習一批出 20 張（review.mjs 呼叫 api.queue 的 limit）。這裡原本抓 24 張，
// 按鈕寫「練這 24 張」、按下去只出 20 張——清單長度與按鈕必須是同一個數。
const WEAK_BATCH = 20;
// 清單先列 8 張，其餘收進「再看」。24 列全攤開會把右欄拉得比左欄長一倍。
const WEAK_SHOWN = 8;

/** 進度頁的頁首：現況／推演兩個分頁，右邊是範圍鈕。兩個分頁吃同一組範圍。 */
export function progressHead(ctx, current) {
  const tabs = h('nav.subtabs', { 'aria-label': '進度' });
  for (const [id, label] of [['stats', '現況'], ['forecast', '推演']]) {
    tabs.append(h('a', { href: `#${id}`, text: label, 'aria-current': id === current ? 'page' : null }));
  }
  return h('header.prog-head', {}, tabs, ctx.scopeMenu());
}

/** 一節。標題與一句「這一節在回答什麼」，右邊可以放一顆動作鈕。沒有外框，靠頂線分節。 */
export function section(title, why, body, action = null) {
  return h('section.sec', {},
    h('header.sec-head', {},
      h('h2', { text: title }),
      why ? h('p.sec-why', { text: why }) : null,
      action ? h('div.sec-act', {}, action) : null,
    ),
    body,
  );
}

export function statsView(root, ctx) {
  const box = h('div.progress');
  const body = h('div.prog-body');
  box.append(progressHead(ctx, 'stats'), body);
  root.append(box);
  let dead = false;
  load();

  async function load() {
    clear(body).append(skeleton());
    try {
      const d = await api.stats({ ...ctx.scopeQuery(), days: 365, upcoming: 30, weakest: WEAK_BATCH });
      if (!dead) render(d);
    } catch (err) {
      if (dead) return;
      clear(body).append(h('div.sec-err', {},
        h('p', { text: `讀不到進度：${err.message}` }),
        h('button.btn', { type: 'button', text: '再試一次', onclick: load }),
      ));
    }
  }

  function render(d) {
    clear(body);
    const s = d.summary;
    const accuracy = s.todayReviews ? s.todayCorrect / s.todayReviews : null;

    const figs = [
      ['已掌握', s.matureCards, '張', `全部 ${num(s.totalCards)} 張`],
      ['學過', s.seenCards, '張', `未學 ${num(s.newCards)} 張`],
      ['到期', s.dueNow, '張', s.dueNow ? '今天該做' : '沒有欠帳'],
      ['連續', s.streakDays, '天', '卡片、實作、打卡都算'],
      ['今天', s.todayReviews, '題', accuracy === null ? '還沒開始' : `答對 ${pct(accuracy)}`],
      ['累計', s.totalReviews, '題', `紀錄檔 ${fmtBytes(d.journal.bytes)}`],
    ];
    const counters = [];
    const figures = h('dl.figures');
    for (const [k, v, unit, sub] of figs) {
      const n = h('span.num', { text: num(v) });
      counters.push([n, v]);
      figures.append(h('div.fig', {},
        h('dt', { text: k }),
        h('dd.fig-v', {}, n, h('span.u', { text: unit })),
        h('dd.fig-s', { text: sub }),
      ));
    }
    body.append(figures);

    const main = h('div.prog-grid');
    const left = h('div.prog-col');
    const right = h('div.prog-col');
    main.append(left, right);
    body.append(main);

    // 工作量放右欄：原本三節都在左邊，1440 寬實測左欄 1023px、右欄 570px，
    // 右邊空出四百多 px 才輪到下一列。挪過去後約 765／876，兩欄底部差距在一節之內。
    left.append(kindsBlock(d));
    left.append(activityBlock(d));
    right.append(weakBlock(d, ctx));
    right.append(errorsBlock(d));
    right.append(upcomingBlock(d));

    // 卡片統計回答記憶排程；四科實作回答有沒有真的讀、寫、聽、說。兩者不能混成一個熟練度。
    const lower = h('div.prog-grid');
    body.append(lower);
    arrangeLower(lower, practiceBlock(d, ctx), recentBlock(d), mockBlock(d, ctx));

    // 三個招牌動作：數字滾上來、題型長條長出來、各節依序浮上來。
    counters.forEach(([el, v], i) => motion.countUp(el, v, { delay: i * 0.05, duration: 1.1 }));
    motion.grow(body.querySelectorAll('.krow .meter i'), { delay: 0.2 });
    motion.rise(body.querySelectorAll('.sec'), { delay: 0.1, stagger: 0.05 });
  }

  return () => {
    dead = true;
    motion.killWithin(box);
  };
}

// ---- 各節 ----------------------------------------------------------------

function kindsBlock(d) {
  const list = h('div.krows');
  // 照 KIND_ZH 的鍵序排；認不得的題型（將來新增而還沒補中文的）排在最後，
  // 不丟掉也不假裝它不存在。
  const order = Object.keys(KIND_ZH);
  const sorted = [...d.byKind].sort((a, b) => {
    const ia = order.indexOf(a.kind);
    const ib = order.indexOf(b.kind);
    return (ia < 0 ? order.length : ia) - (ib < 0 ? order.length : ib);
  });
  for (const k of sorted) {
    const mature = h('i.mature');
    mature.style.width = `${(k.mature / k.total) * 100}%`;
    const seen = h('i.seen');
    seen.style.width = `${((k.seen - k.mature) / k.total) * 100}%`;
    list.append(h('div.krow', {},
      h('span.name', { text: KIND_ZH[k.kind] ?? k.kind }),
      h('div.meter', { role: 'img', 'aria-label': `${KIND_ZH[k.kind] ?? k.kind}：已掌握 ${k.mature}，學過 ${k.seen}，共 ${k.total}` }, mature, seen),
      h('span.n', {}, h('b', { text: num(k.mature) }), ` / ${num(k.seen)} / ${num(k.total)}`),
    ));
  }
  const legend = h('div.legend', {},
    swatch('已掌握', 'var(--accent)'), swatch('學過但未穩', 'var(--accent-mid)'), swatch('未學', 'var(--sunken)'),
  );
  return section('各題型', '已掌握 / 學過 / 全部', [list, legend]);
}

function activityBlock(d) {
  const out = [];
  if (d.daily.length === 0) {
    out.push(emptyLine('還沒有作答紀錄。'));
  } else {
    out.push(heatmap(d.daily, { weeks: 26, cap: '近 26 週，顏色深淺是相對量' }));
    // daily 只有練過的日子。直接取最後 30 筆會把沒練的日子抽掉，十天空窗畫出來是連續的長條，
    // 而這張圖要回答的正是「有沒有在練」。所以先補成連續 30 天，沒練的填 0。
    const byDay = new Map(d.daily.map((x) => [x.day, x]));
    const recent = Array.from({ length: 30 }, (_, i) => {
      const t = new Date();
      t.setDate(t.getDate() - 29 + i);
      const day = t.toLocaleDateString('sv');
      const x = byDay.get(day) ?? { count: 0, correct: 0 };
      return { x: day.slice(5), label: day, a: x.correct, b: x.count - x.correct };
    });
    out.push(bars(recent, {
      height: 140, aName: '答對', bName: '答錯',
      title: '最近 30 天每日作答量', cap: '最近 30 天每日作答量',
    }));
  }
  // 這一節疊了兩張圖，說明各自寫在圖上，節標題只講這一節在回答什麼。
  return section('練習頻率', '實際練了多少', out);
}

function upcomingBlock(d) {
  const out = [];
  if (d.upcoming.days.length === 0 && !d.upcoming.backlog) {
    out.push(emptyLine('未來 30 天沒有排定的複習。'));
  } else {
    if (d.upcoming.backlog) {
      out.push(h('p.sec-note', { text: `今天到期的 ${num(d.upcoming.backlog)} 張另外算，圖只畫之後的日子。` }));
    }
    out.push(bars(
      d.upcoming.days.map((x) => ({ x: x.day.slice(5), label: x.day, a: x.count })),
      { height: 140, title: '未來 30 天每日到期量' },
    ));
  }
  return section('未來的工作量', 'FSRS 已經排好的複習', out);
}

function weakBlock(d, ctx) {
  if (d.weakest.length === 0) return section('最弱的卡', '按答錯次數排序', emptyLine('目前沒有答錯的卡。'));
  const item = (w) => {
    const f = w.card.front ?? {};
    const word = cardHead(w.card);
    return h('li.weak-item', {},
      h('div.weak-main', {},
        h('span.w', { lang: 'fr', text: word }),
        h('span.g', { text: [KIND_ZH[w.card.kind], f.gloss || f.zh || f.tenseZh].filter(Boolean).join('・') }),
      ),
      h('div.weak-side', {},
        h('span.lapses', { text: `錯 ${w.lapses} 次` }),
        w.lastReason ? h('span.why', { text: `上次${REASON_ZH[w.lastReason] ?? w.lastReason}` }) : null,
      ),
    );
  };
  const list = h('ol.weak', {}, ...d.weakest.slice(0, WEAK_SHOWN).map(item));
  const rest = d.weakest.slice(WEAK_SHOWN);
  const more = rest.length
    ? h('details.side-more', {}, h('summary', { text: `再看 ${rest.length} 張` }), h('ol.weak', {}, ...rest.map(item)))
    : null;
  const go = h('button.btn.btn-sm', {
    type: 'button', text: `練這 ${d.weakest.length} 張`,
    onclick: () => ctx.startReview({ preset: 'weak' }),
  });
  return section('最弱的卡', '按答錯次數排序', [list, more], go);
}

function errorsBlock(d) {
  if (d.errorProfile.length === 0) return section('錯在哪裡', '打字題的錯誤類型', emptyLine('還沒有打字題答錯的紀錄。'));
  const out = [reasonBars(d.errorProfile, REASON_ZH, REASON_COLOR)];
  const accent = d.errorProfile.find((r) => r.reason === 'accent');
  if (accent) {
    const total = d.errorProfile.reduce((a, r) => a + r.count, 0);
    out.push(h('p.sec-note', {
      text: `其中 ${pct(accent.count / total)} 是字母全對、只差重音。這一類最容易被自己放過，考卷上照樣扣分。`,
    }));
  }
  return section('錯在哪裡', '打字題的錯誤類型', out);
}

function practiceBlock(d, ctx) {
  const rows = h('ul.skills');
  for (const item of d.practice.bySkill) {
    const performance = item.average === null ? '尚無分數' : `平均 ${pct(item.average)}，${item.attempts} 次`;
    rows.append(h('li.skill', {},
      h('span.skill-code', { text: item.skill }),
      h('div.skill-main', {},
        h('span', { text: item.attempts ? `${item.days} 天・${item.minutes} 分鐘` : '還沒有紀錄' }),
        h('span.dim', { text: performance }),
      ),
      // 四列的按鈕字一樣，讀螢幕時要靠 aria-label 分出是哪一科。
      h('button.btn.btn-quiet.btn-sm', { type: 'button', text: '練習', 'aria-label': `練習 ${item.skill}`, onclick: () => ctx.openPractice(item.skill) }),
    ));
  }
  return section('四科實作', d.practice.recent.length ? `最近 ${d.periodDays} 天` : '卡片之外的讀、寫、聽、說', rows);
}

/** 最近幾次實作。沒有紀錄就不出這一節，空的一節只會把下排撐歪。 */
function recentBlock(d) {
  if (!d.practice.recent.length) return null;
  const recent = h('ul.attempts');
  for (const item of d.practice.recent.slice(0, 8)) {
    const result = item.score === null ? null : `${item.score}/${item.maxScore}`;
    recent.append(h('li.attempt', {},
      h('span.skill-code', { text: item.skill }),
      h('div.attempt-main', {}, h('span', { text: item.source || '未命名練習' }), h('span.dim', { text: item.day })),
      h('span.num', { text: [item.durationSec ? `${Math.round(item.durationSec / 60)} 分` : null, item.wordCount ? `${item.wordCount} mots` : null, result].filter(Boolean).join('・') || '完成' }),
    ));
  }
  return section('最近實作', `最近 ${Math.min(8, d.practice.recent.length)} 次`, recent);
}

/**
 * 下排三節的高度全看資料。原本固定「四科實作｜模考」左右放，1440 寬實測
 * 沒有模考時左欄 500px、右欄 80px，右邊空一大片。
 * 所以先掛上去量實際高度，從三種排法裡挑兩欄高度差最小的那個。
 * 單欄（窄於 1100px）時高度差沒有意義，照閱讀順序排。
 */
function arrangeLower(grid, practice, recent, mock) {
  const left = h('div.prog-col');
  const right = h('div.prog-col');
  grid.append(left, right);
  if (!recent) {
    left.append(practice);
    right.append(mock);
    return;
  }
  if (getComputedStyle(grid).gridTemplateColumns.split(' ').length < 2) {
    left.append(practice, recent, mock);
    return;
  }
  const layouts = [
    [[practice, recent], [mock]],
    [[practice, mock], [recent]],
    [[practice], [recent, mock]],
  ];
  let best = layouts[0];
  let gap = Infinity;
  for (const [l, r] of layouts) {
    left.replaceChildren(...l);
    right.replaceChildren(...r);
    const diff = Math.abs(left.offsetHeight - right.offsetHeight);
    if (diff < gap) [gap, best] = [diff, [l, r]];
  }
  left.replaceChildren(...best[0]);
  right.replaceChildren(...best[1]);
}

function mockBlock(d, ctx) {
  const add = h('button.btn.btn-sm', { type: 'button', text: '記錄模考', onclick: () => ctx.go('mock') });
  const latest = d.practice.mocks[0];
  if (!latest) return section('模考', '完整四科一份', emptyLine('還沒有模考紀錄。'), add);

  const out = [h('div.mock-latest', {},
    h('p.mock-total', {}, h('span.num', { text: String(latest.total) }), h('span.of', { text: `/${latest.maxTotal}` })),
    h('div.mock-meta', {},
      h('span', { text: `${latest.day}${latest.source ? `・${latest.source}` : ''}` }),
      h('span.dim', { text: Object.entries(latest.scores).map(([skill, v]) => `${skill} ${v.score}/${v.maxScore}`).join('　') }),
    ),
  )];
  const trend = [...d.practice.mocks].reverse().map((item) => ({
    x: item.day.slice(5), label: item.day, a: Math.round((item.total / item.maxTotal) * 100),
  }));
  if (trend.length > 1) out.push(line(trend, { height: 150, title: '模考總分百分比趨勢', cap: '模考總分百分比；每個點是一份完整模考' }));
  const history = h('ul.attempts');
  for (const item of d.practice.mocks.slice(0, 6)) {
    history.append(h('li.attempt', {},
      h('span.num', { text: `${item.total}/${item.maxTotal}` }),
      h('div.attempt-main', {}, h('span', { text: item.source || '未命名模考' }), h('span.dim', { text: item.day })),
    ));
  }
  out.push(history);
  return section('模考', '最近一次完整四科', out, add);
}

// ---- 小工具 --------------------------------------------------------------

/** 載入中的骨架：數字列、左右兩欄。形狀跟最後的版面一樣，載完不會跳。 */
function skeleton() {
  const box = h('div.prog-skel', { 'aria-busy': 'true' });
  const bar = (w, hh) => {
    const el = h('div.skeleton');
    el.style.width = w;
    el.style.height = `${hh}px`;
    return el;
  };
  box.append(bar('100%', 88), h('div.prog-grid', {}, bar('100%', 320), bar('100%', 320)));
  return box;
}

function swatch(name, color) {
  // 底色那一格要描邊，見 views.css 的 .legend i.blank。
  const dot = h(color === 'var(--sunken)' ? 'i.blank' : 'i');
  dot.style.background = color;
  return h('span', {}, dot, name);
}

function emptyLine(text) {
  return h('p.sec-empty', { text });
}

function fmtBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
