/**
 * 考前推演頁。
 *
 * 這一頁是這個 App 唯一做了「人腦做不到的計算」的地方：拿你目前每一張卡的
 * FSRS 記憶狀態，逐日模擬到考試當天，算出那天的期望答對率。
 *
 * 誠實原則（跟後端一致，這裡負責把它顯示出來）：
 *  - 評分分布來自你自己的歷史；樣本不足 50 筆時一律當 Good，並標示為假設。
 *  - 每張卡的作答秒數用你自己的中位數；不足 30 筆時用預設 8 秒，也標示出來。
 *  - 達不到目標時直接說達不到，並給出上限，不給一個看起來好看的數字。
 */

import { h, clear, pct, icon, num } from './dom.mjs';
import { api } from './net.mjs';
import { line } from './charts.mjs';

export function forecastView(root, ctx) {
  const box = h('div');
  root.append(box);

  const form = h('form.fc-form', { onsubmit: (ev) => { ev.preventDefault(); run(); } });
  const exam = input({ type: 'date', value: ctx.settings?.examDate ?? defaultExam(), required: true });
  const limit = input({ type: 'number', min: 5, max: 500, step: 5, value: 60 });
  const fresh = input({ type: 'number', min: 0, max: 200, step: 1, value: ctx.settings?.dailyNewLimit ?? 15 });
  const target = input({ type: 'number', min: 50, max: 99, step: 1, value: 85 });

  form.append(
    field('考試日期', exam, null),
    field('每天最多做', limit, '含新卡'),
    field('每天學新卡', fresh, null),
    field('目標答對率 %', target, '會反推需要的新卡量'),
    h('button.btn.btn-primary', { type: 'submit', text: '推演' }),
  );
  box.append(form);

  const out = h('div');
  box.append(out);

  async function run() {
    clear(out).append(h('div.card.empty', {}, h('p', { text: '模擬中…' })));
    try {
      const data = await api.forecast({
        ...ctx.scopeQuery(),
        exam: exam.value,
        limit: limit.value,
        new: fresh.value,
        target: Number(target.value) / 100,
      });
      // 使用者填了考試日期就記起來，下次打開直接帶入。
      if (exam.value !== ctx.settings?.examDate) {
        ctx.saveSettings({ examDate: exam.value }).catch(() => {});
      }
      render(data);
    } catch (err) {
      clear(out).append(h('div.card.errorbox', {}, h('p', { text: err.message })));
    }
  }

  function render(d) {
    clear(out);
    const p = d.plan;
    out.append(verdict(p, d.inputs, Number(target.value) / 100));

    // ---- 每日負擔曲線 ----
    const days = p.days.map((x) => ({ x: x.day.slice(5), a: x.reviews + x.learned }));
    const peakIdx = p.days.findIndex((x) => x === p.peakDay);
    const curve = h('div.body', {},
      line(days, {
        height: 170,
        title: '每天要做的張數',
        marks: peakIdx >= 0 ? [{ at: peakIdx, label: `最高峰 ${num(p.peakDay.reviews + p.peakDay.learned)} 張` }] : [],
      }),
      h('p.verdict-note', {
        text: p.days.some((x) => x.minutes)
          ? `依你自己的作答速度（每張 ${d.inputs.secondsPerCard} 秒），最忙的一天約 ${p.peakDay?.minutes ?? 0} 分鐘。`
          : '沒有足夠的作答時間紀錄，暫時無法換算成分鐘。',
      }),
      p.backlogPeak > 0
        ? h('p.verdict-note', { text: `每天上限 ${p.dailyLimit} 張的話，最多會有 ${p.backlogPeak} 張被擠到隔天。` })
        : null,
    );
    out.append(panel('每天的負擔', `到 ${p.examDate} 還有 ${p.daysUntilExam} 天`, curve));

    // ---- 考試當天的分佈 ----
    const b = p.buckets;
    const totalCards = p.cardsInScope;
    const strip = h('div.buckets', { role: 'img', 'aria-label': bucketLabel(b) });
    for (const [cls, n, name] of [
      ['strong', b.strong, '記得牢'],
      ['shaky', b.shaky, '不太穩'],
      ['weak', b.weak, '大概忘了'],
      ['untouched', b.untouched, '沒學到'],
    ]) {
      if (!n) continue;
      const seg = h('i', { class: cls, title: `${name} ${num(n)} 張` });
      seg.style.width = `${(n / totalCards) * 100}%`;
      if (n / totalCards > 0.06) seg.textContent = num(n);
      strip.append(seg);
    }
    out.append(panel('考試當天，這些卡的狀態', '依 FSRS 推算的可提取度分組', h('div.body', {},
      strip,
      h('div.legend', {},
        swatch('記得牢（≥90%）', 'var(--ok)'),
        swatch('不太穩（70–90%）', 'var(--warn)'),
        swatch('大概忘了（<70%）', 'var(--bad)'),
        swatch('沒學到', 'var(--sunken)'),
      ),
    )));

    // ---- 反推新卡量 ----
    if (d.solved) out.append(solvedPanel(d.solved));
  }
}

/** 結論。一句話講完，數字放大，其餘退到底下。 */
function verdict(p, inputs, targetRate) {
  const hit = p.expectedRecallRate >= targetRate;
  const card = h('div.fc-verdict', { dataset: { tone: hit ? 'ok' : 'bad' } });

  card.append(h('p.lead', {},
    `考試當天，範圍內 ${num(p.cardsInScope)} 張裡預期記得 `,
    h('b', { text: `${num(Math.round(p.expectedRecall))} 張` }),
    `（${pct(p.expectedRecallRate, 1)}）`,
  ));
  card.append(h('p.sub', {
    text: hit
      ? `達到你設的 ${pct(targetRate)} 目標。這是期望值，不是保證——實際會在這個數字上下浮動。`
      : `低於你設的 ${pct(targetRate)} 目標。往下看「要達標得學多少新卡」。`,
  }));
  card.append(h('p.sub', {
    text: `到考試日總共會做 ${num(p.totalReviews)} 張，其中預期答錯 ${num(p.totalLapses)} 次；能學到的卡佔範圍的 ${pct(p.coverage)}。`,
  }));

  const asm = h('div.assumptions', {}, h('span.chip', { text: '模型假設' }));
  asm.append(p.ratingModel === 'observed'
    ? h('span.chip', { text: `評分分布取自你的 ${inputs.ratingSample} 筆答對紀錄` })
    : h('span.chip', { dataset: { kind: 'assumed' }, text: '評分分布：歷史不足，一律當作 Good' }));
  asm.append(inputs.secondsSource === 'observed'
    ? h('span.chip', { text: `每張 ${inputs.secondsPerCard} 秒（你的中位數）` })
    : h('span.chip', { dataset: { kind: 'assumed' }, text: `每張 ${inputs.secondsPerCard} 秒（預設值）` }));
  asm.append(h('span.chip', { text: '固定亂數種子，同樣的輸入會得到同樣的結果' }));
  card.append(asm);
  return card;
}

function solvedPanel(sv) {
  const body = h('div.body');
  if (sv.achievable) {
    body.append(h('p.lead', {},
      '每天學 ',
      h('b', { text: `${sv.recommended.dailyNew} 張新卡` }),
      ' 就能達標。',
    ));
    body.append(h('p.verdict-note', {
      text: `這是「還能達標的最大新卡量」——學得比這個多，考試當天的整體記憶率反而會被稀釋。`,
    }));
  } else {
    body.append(h('p.lead', {},
      '這個目標達不到。最好的情況是每天 ',
      h('b', { text: `${sv.ceiling.dailyNew} 張新卡` }),
      '，記憶率 ',
      h('b', { text: pct(sv.ceiling.rate, 1) }),
      '。',
    ));
    body.append(h('p.verdict-note', {
      text: '要嘛把範圍縮小（只練 A1／A2、或只練動詞變位），要嘛提高每天的上限，要嘛接受這個數字。這裡不會給你一個做不到的計畫。',
    }));
  }

  const table = h('table.grid', {},
    h('thead', {}, h('tr', {},
      h('th', { text: '每天新卡' }), h('th', { text: '預期記憶率' }),
      h('th', { text: '學到' }), h('th', { text: '總作答' }),
    )),
  );
  const tb = h('tbody');
  for (const t of sv.tried) {
    tb.append(h('tr', {
      dataset: { hit: t.dailyNew === (sv.achievable ? sv.recommended.dailyNew : sv.ceiling.dailyNew) ? '1' : '0' },
    },
      h('td', { text: String(t.dailyNew) }),
      h('td', { text: pct(t.rate, 1) }),
      h('td', { text: num(t.studied) }),
      h('td', { text: num(t.reviews) }),
    ));
  }
  table.append(tb);
  body.append(h('div.scroll-x', {}, table));
  return panel('要達標得學多少新卡', '二分搜尋，每個候選值都跑一次完整模擬', body);
}

// ---- 小工具 --------------------------------------------------------------

function panel(title, why, bodyNode) {
  return h('section.panel', {}, h('h2', {}, title, why ? h('span.why', { text: why }) : null), bodyNode);
}

function input(props) {
  return h('input.input', props);
}

function field(label, control, hint) {
  const id = `f-${Math.random().toString(36).slice(2, 8)}`;
  control.id = id;
  return h('div.field', {},
    h('label', { for: id, text: label }),
    control,
    hint ? h('span.hint', { text: hint }) : null,
  );
}

function swatch(name, color) {
  const dot = h('i');
  dot.style.background = color;
  return h('span', {}, dot, name);
}

function bucketLabel(b) {
  return `記得牢 ${num(b.strong)}、不太穩 ${num(b.shaky)}、大概忘了 ${num(b.weak)}、沒學到 ${num(b.untouched)}`;
}

/** 沒設考試日期時，預設兩個月後——夠遠到看得出排程效果，夠近到還有壓力。 */
function defaultExam() {
  const d = new Date(Date.now() + 60 * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
