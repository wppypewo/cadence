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

const KIND_ZH = {
  'vocab-recall': '看字回想',
  'vocab-produce': '中翻法',
  conj: '動詞變位',
  connector: '連接詞',
};

const REASON_ZH = { wrong: '拼錯', accent: '漏重音', case: '大小寫', empty: '沒作答' };
const REASON_COLOR = {
  wrong: 'var(--bad)',
  accent: 'var(--warn)',
  case: 'var(--text-faint)',
  empty: 'var(--border-strong)',
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
      stat('現在到期', s.dueNow, s.dueNow ? '去做掉它' : '沒有欠帳'),
      stat('連續天數', s.streakDays, s.streakDays ? '別斷' : '今天可以重新開始'),
      stat('今天', s.todayReviews, accuracy === null ? '還沒開始' : `正確率 ${pct(accuracy)}`),
      stat('累計作答', s.totalReviews, `紀錄檔 ${fmtBytes(d.journal.bytes)}`),
    ));

    // ---- 各類別進度 ----
    const kinds = h('div.body');
    for (const k of d.byKind) {
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
      swatch('已掌握', 'var(--accent)'), swatch('學過但未穩', 'var(--accent-weak)'), swatch('未學', 'var(--sunken)'),
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
        up.append(h('p.verdict-note', { text: `另有 ${d.upcoming.backlog} 張已經到期還沒做，沒有算進下面的圖。` }));
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
  const dot = h('i');
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
