/**
 * 統計頁。這一頁的存在理由是回答四個人腦記不住的問題：
 *   1. 我到底練到哪了？（各類別的已掌握／學過／未學）
 *   2. 我有沒有在練？（每日熱力圖與連續天數）
 *   3. 我哪裡最弱？（錯最多次的卡，附上最近一次是怎麼錯的）
 *   4. 我未來給自己排了多少工作？（到期量預估）
 *
 * 沒有一個數字是裝飾用的。看不出能改變行為的圖就不畫。
 */

import { h, icon, clear, pct, num } from './dom.mjs';
import { api } from './net.mjs';
import { bars, heatmap, reasonBars } from './charts.mjs';

/**
 * 題型的中文名。**這個物件的鍵序就是各類別進度的顯示順序**，
 * 與側欄篩選鈕（app.mjs 的 KINDS）排的是同一套：先詞彙、再變位、再句子層級。
 *
 * 不用 API 回來的順序，是因為 SQL 那邊是 `ORDER BY c.kind`，也就是英文代碼的
 * 字母序——conj、connector、nom、pick、rw、vocab-produce、vocab-recall。
 * 那個順序在畫面上讀起來沒有意義，而且跟旁邊側欄的排法對不起來。
 */
const KIND_ZH = {
  'vocab-recall': '看字回想',
  'vocab-produce': '中翻法',
  conj: '動詞變位',
  connector: '連接詞',
  pick: '挑連接詞',
  rw: '改寫整句',
  nom: '名詞化',
};

const REASON_ZH = {
  wrong: '拼錯', accent: '漏重音', case: '大小寫', empty: '沒作答',
  elision: '省音', family: '性數／形式', missing: '少要素', article: '冠詞錯',
};
const REASON_COLOR = {
  wrong: 'var(--bad)',
  accent: 'var(--warn)',
  case: 'var(--text-faint)',
  empty: 'var(--border-strong)',
  // 挑連接詞的兩種「選對了但寫錯」。歸在警示色，與純粹選錯格分開看。
  elision: 'var(--warn)',
  family: 'var(--warn)',
  // 改寫題缺了指定的連接詞或語氣。跟拼錯是同一級的錯，用同一個顏色。
  missing: 'var(--bad)',
  // 名詞化只錯冠詞：名詞本身挑對了，跟完全不會不是同一級，歸警示色。
  article: 'var(--warn)',
};

export function statsView(root, ctx) {
  const body = h('div');
  root.append(body);
  load();

  async function load() {
    clear(body).append(h('div.card.empty', {}, h('p', { text: '算統計中…' })));
    try {
      render(await api.stats({ ...ctx.scopeQuery(), days: 365, upcoming: 30, weakest: 24 }));
    } catch (err) {
      clear(body).append(h('div.card.errorbox', {},
        h('p', { text: `讀不到統計：${err.message}` }),
        h('button.btn', { text: '再試一次', onclick: load }),
      ));
    }
  }

  function render(d) {
    clear(body);
    const s = d.summary;
    const accuracy = s.todayReviews ? s.todayCorrect / s.todayReviews : null;

    body.append(h('div.stat-grid', {},
      stat('已掌握', s.matureCards, `共 ${num(s.totalCards)} 張・穩定度 ≥ 21 天`),
      stat('學過', s.seenCards, `未學 ${num(s.newCards)} 張`),
      stat('今天到期', s.dueNow, s.dueNow ? '去做掉它' : '沒有欠帳'),
      stat('連續天數', s.streakDays, s.streakDays ? '每天至少答一題就算一天' : '今天答一題就開始算'),
      stat('今天', s.todayReviews, accuracy === null ? '還沒開始' : `正確率 ${pct(accuracy)}`),
      stat('累計作答', s.totalReviews, `紀錄檔 ${fmtBytes(d.journal.bytes)}`),
    ));

    // 卡片統計回答記憶排程；四科實作回答有沒有真的讀、寫、聽、說。兩者不能混成一個熟練度。
    const practice = h('div.body');
    const skillGrid = h('div.practice-stats');
    for (const item of d.practice.bySkill) {
      const performance = item.average === null ? '尚無分數' : `平均 ${pct(item.average)}`;
      skillGrid.append(h('article.practice-stat', {},
        h('div', {},
          h('strong', { text: item.skill }),
          h('span', { text: item.attempts ? `${item.days} 天・${item.minutes} 分鐘` : '還沒有實作紀錄' }),
          h('small', { text: performance }),
        ),
        h('button.btn.btn-sm', { type: 'button', text: '開始練習', onclick: () => ctx.openPractice(item.skill) }),
      ));
    }
    practice.append(skillGrid);
    if (d.practice.recent.length) {
      const recent = h('div.attempt-list');
      for (const item of d.practice.recent.slice(0, 8)) {
        const result = item.score === null ? null : `${item.score}/${item.maxScore}`;
        recent.append(h('div.attempt-row', {},
          h('span.chip', { text: item.skill }),
          h('div', {}, h('strong', { text: item.source || '未命名練習' }), h('small', { text: item.day })),
          h('span.num', { text: [item.durationSec ? `${Math.round(item.durationSec / 60)} 分` : null, item.wordCount ? `${item.wordCount} mots` : null, result].filter(Boolean).join('・') || '完成' }),
        ));
      }
      practice.append(h('h3.section-label', { text: '最近實作' }), recent);
    }
    body.append(panel('四科實作', `最近 120 天・紀錄檔 ${fmtBytes(d.attemptsJournal.bytes)}`, practice));

    const mock = h('div.body');
    const latestMock = d.practice.mocks[0];
    if (latestMock) {
      mock.append(h('div.mock-latest', {},
        h('div', {},
          h('strong.num', { text: `${latestMock.total}/${latestMock.maxTotal}` }),
          h('span', { text: `${latestMock.day}${latestMock.source ? `・${latestMock.source}` : ''}` }),
        ),
        h('div.mock-parts', {}, ...Object.entries(latestMock.scores).map(([skill, value]) =>
          h('span.chip', { text: `${skill} ${value.score}/${value.maxScore}` }))),
      ));
      const history = h('div.mock-history');
      for (const item of d.practice.mocks.slice(0, 6)) {
        history.append(h('div', {},
          h('span', { text: item.day }),
          h('strong.num', { text: `${item.total}/${item.maxTotal}` }),
          h('small', { text: item.source || '未命名模考' }),
        ));
      }
      mock.append(history);
    } else {
      mock.append(emptyLine('還沒有完整模考紀錄。'));
    }
    mock.append(h('div.panel-actions', {}, h('button.btn', { type: 'button', text: '記錄一次模考', onclick: () => ctx.go('mock') })));
    body.append(panel('模考趨勢', latestMock ? '最近一次完整四科' : '總分與單科門檻分開記', mock));

    // ---- 各類別進度 ----
    const kinds = h('div.body');
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
      kinds.append(h('div.kind-row', {},
        h('span.name', { text: KIND_ZH[k.kind] ?? k.kind }),
        h('div.meter', { role: 'img', 'aria-label': `${KIND_ZH[k.kind]}：已掌握 ${k.mature}，學過 ${k.seen}，共 ${k.total}` }, mature, seen),
        h('span.n', { text: `${num(k.mature)} / ${num(k.seen)} / ${num(k.total)}` }),
      ));
    }
    kinds.append(h('div.legend', {},
      swatch('已掌握', 'var(--accent)'), swatch('學過但未穩', 'var(--accent-mid)'), swatch('未學', 'var(--sunken)'),
    ));
    body.append(panel('各類別進度', '已掌握 / 學過 / 全部', kinds));

    // ---- 每日 ----
    const activity = h('div.body');
    if (d.daily.length === 0) {
      activity.append(emptyLine('還沒有任何紀錄。做完第一輪之後這裡才有東西。'));
    } else {
      activity.append(heatmap(d.daily, { weeks: 26, cap: '近 26 週，方塊顏色深淺是相對量' }));
      const recent = d.daily.slice(-30).map((x) => ({
        x: x.day.slice(5), label: x.day, a: x.correct, b: x.count - x.correct,
      }));
      activity.append(bars(recent, {
        height: 140, aName: '答對', bName: '答錯',
        title: '最近 30 天每日作答量', cap: '最近 30 天每日作答量',
      }));
    }
    // 這個面板疊了兩張圖，說明各自寫在圖上，面板副標只講這一節在回答什麼。
    body.append(panel('練習頻率', '你實際練了多少', activity));

    // ---- 弱點 ----
    const weak = h('div.body');
    if (d.weakest.length === 0) {
      weak.append(emptyLine('目前沒有錯過的卡。等錯了再回來看——這一頁在那時候才有用。'));
    } else {
      const list = h('div.weak');
      for (const w of d.weakest) {
        const f = w.card.front ?? {};
        const word = w.card.answer || f.word || f.connector || f.verb || w.card.id;
        list.append(h('div.weak-item', {},
          h('div', {},
            h('div.w', { lang: 'fr', text: word }),
            h('div.g', { text: [KIND_ZH[w.card.kind], f.gloss || f.zh || f.tenseZh].filter(Boolean).join('・') }),
          ),
          h('div.r', {},
            w.lastReason ? h('span.chip', { text: `上次：${REASON_ZH[w.lastReason] ?? w.lastReason}` }) : null,
            h('span.lapses.num', { text: `錯 ${w.lapses} 次` }),
          ),
        ));
      }
      weak.append(list);
      weak.append(h('div.panel-actions', {}, h('button.btn.btn-primary', {
        type: 'button', text: `練這 ${d.weakest.length} 張`,
        onclick: () => ctx.startReview({ preset: 'weak' }),
      })));
    }
    body.append(panel('最弱的卡', '按答錯次數排序', weak));

    // ---- 錯誤類型 ----
    const errs = h('div.body');
    if (d.errorProfile.length === 0) {
      errs.append(emptyLine('還沒有打字題答錯的紀錄。'));
    } else {
      const accent = d.errorProfile.find((r) => r.reason === 'accent');
      const total = d.errorProfile.reduce((a, r) => a + r.count, 0);
      errs.append(reasonBars(d.errorProfile, REASON_ZH, REASON_COLOR));
      if (accent) {
        errs.append(h('p.verdict-note', {
          text: `其中 ${pct(accent.count / total)} 的錯是「字母全對、只差重音」。這一類錯最容易被自己原諒，也最容易在考卷上被扣分。`,
        }));
      }
    }
    body.append(panel('錯在哪裡', '打字題的錯誤類型分布', errs));

    // ---- 未來到期 ----
    const up = h('div.body');
    if (d.upcoming.days.length === 0 && !d.upcoming.backlog) {
      up.append(emptyLine('未來 30 天沒有排定的複習。'));
    } else {
      if (d.upcoming.backlog) {
        up.append(h('p.verdict-note', { text: `今天到期的 ${d.upcoming.backlog} 張要另外做，下面的圖只畫之後的日子。` }));
      }
      up.append(bars(
        d.upcoming.days.map((x) => ({ x: x.day.slice(5), label: x.day, a: x.count })),
        { height: 140, title: '未來 30 天每日到期量' },
      ));
    }
    body.append(panel('未來的工作量', 'FSRS 已經替你排好的複習', up));
  }
}

function stat(k, v, sub) {
  return h('div.stat', {},
    h('span.k', { text: k }),
    h('span.v', { text: num(v) }),
    h('span.s', { text: sub }),
  );
}

function panel(title, why, bodyNode) {
  return h('section.panel', {},
    h('h2', {}, title, why ? h('span.why', { text: why }) : null),
    bodyNode,
  );
}

function swatch(name, color) {
  // 底色那一格要描邊，見 views.css 的 .legend i.blank。
  const dot = h(color === 'var(--sunken)' ? 'i.blank' : 'i');
  dot.style.background = color;
  return h('span', {}, dot, name);
}

function emptyLine(text) {
  return h('div.empty', {}, icon('chart'), h('p', { text }));
}

function fmtBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
