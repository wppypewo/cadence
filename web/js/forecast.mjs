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
  const saved = ctx.settings?.examDate ?? null;
  const exam = input({ type: 'date', value: saved ?? defaultExam(), required: true });
  // 只有使用者自己動過這一格才寫回設定。原本只要值跟設定不同就存，
  // 沒設考試日期的人開頁按一次推演，60 天後這個暫代值就悄悄變成「今天」頁的倒數。
  let examTouched = false;
  exam.addEventListener('input', () => { examTouched = true; });
  const limit = input({ type: 'number', min: 5, max: 500, step: 5, value: 60 });
  const fresh = input({ type: 'number', min: 0, max: 200, step: 1, value: ctx.settings?.dailyNewLimit ?? 15 });
  const target = input({ type: 'number', min: 50, max: 99, step: 1, value: 85 });

  form.append(
    field('考試日期', exam, examHint(saved)),
    field('每天最多做', limit, '含新卡'),
    // 設定成不設上限時，這一格的預設 15 不是設定值，要講明，不然會被當成「照設定推演」。
    field('每天學新卡', fresh, ctx.settings?.dailyNewLimit === null ? '設定是不設上限，這裡填預計每天學幾張' : null),
    field('目標答對率 %', target, '會反推需要的新卡量'),
    h('button.btn.btn-primary', { type: 'submit', text: '推演' }),
  );
  box.append(form);

  const out = h('div');
  // 這一頁進來是空的，而且是刻意的：一次推演要把範圍內每一張卡逐日模擬到考試當天，
  // 反推目標答對率還要跑六十幾次，開頁就自動算會讓人以為 App 當掉了。
  // 但「空白＋一顆按鈕」看起來也像壞掉，所以先寫清楚按下去會發生什麼事。
  out.append(emptyState());
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
      render(data);
      if (examTouched && exam.value !== (ctx.settings?.examDate ?? null)) rememberExam(exam.value);
    } catch (err) {
      clear(out).append(h('div.card.errorbox', {}, h('p', { text: err.message })));
    }
  }

  /**
   * 把推演用的日期記成考試日期，並給一顆復原。
   * 這個值會變成「今天」頁的倒數，改了卻沒說一聲，下次看到的倒數會對不上自己的認知。
   */
  function rememberExam(value) {
    const before = ctx.settings?.examDate ?? null;
    // 提示寫的是「設定裡有沒有日期」，存或復原之後要跟著改，不然會繼續說還沒設。
    const hint = exam.closest('.field')?.querySelector('.hint');
    const paintHint = (v) => { if (hint) hint.textContent = examHint(v); };
    ctx.saveSettings({ examDate: value })
      .then(() => {
        examTouched = false;
        paintHint(value);
        ctx.toast(`考試日期改成 ${value}`, 'ok', {
          label: '復原',
          run: () => ctx.saveSettings({ examDate: before })
            .then(() => {
              // 只改回設定的話，欄位與下面的推演結果都還停在剛才那個日期，畫面上會有兩個日子。
              exam.value = before ?? defaultExam();
              examTouched = false;
              paintHint(before);
              ctx.toast(before ? `考試日期改回 ${before}，重新推演中` : '考試日期改回未設定，重新推演中', 'ok');
              run();
            })
            .catch((e) => ctx.toast(`沒改回去：${e.message}`, 'bad')),
        });
      })
      .catch((e) => ctx.toast(`考試日期沒存到：${e.message}`, 'bad'));
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
    body.append(h('p.verdict-note', { text: achievableNote(sv) }));
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

  // 掃過的每一格畫成曲線。這條線的形狀就是「新卡學太多反而更差」的證據，
  // 只看一個推薦數字是看不出來的。答對率用百分比進 chart，否則 0.14 會被
  // niceMax 壓成貼著底線的一條平線。
  const win = sv.achievable ? sv.recommended.dailyNew : sv.ceiling.dailyNew;
  const winAt = sv.tried.findIndex((t) => t.dailyNew === win);
  body.append(line(
    sv.tried.map((t) => ({ x: String(t.dailyNew), label: `每天 ${t.dailyNew} 張新卡`, a: t.rate * 100 })),
    {
      height: 170,
      title: '每天新卡量對考試當天記憶率的影響（%）',
      marks: winAt >= 0 ? [{ at: winAt, label: `${win} 張` }] : [],
      cap: sv.exhaustive
        ? `0 到 ${sv.tried[sv.tried.length - 1].dailyNew} 張每一格都跑過一次完整模擬。`
        : `範圍太大，改成等距抽樣 ${sv.tried.length} 格再補滿最好的那一段；格與格之間可能還有更高點。`,
    },
  ));

  // 表格只留關鍵幾列。61 列全倒出來沒有人會讀，而且會把整頁推得很長。
  const rows = pickRows(sv.tried, win);
  const table = h('table.grid', {},
    h('thead', {}, h('tr', {},
      h('th', { text: '每天新卡' }), h('th', { text: '預期記憶率' }),
      h('th', { text: '學到' }), h('th', { text: '總作答' }),
    )),
  );
  const tb = h('tbody');
  for (const t of rows) {
    tb.append(h('tr', { dataset: { hit: t.dailyNew === win ? '1' : '0' } },
      h('td', { text: String(t.dailyNew) }),
      h('td', { text: pct(t.rate, 1) }),
      h('td', { text: num(t.studied) }),
      h('td', { text: num(t.reviews) }),
    ));
  }
  table.append(tb);
  body.append(h('div.scroll-x', {}, table));
  return panel('要達標得學多少新卡', `掃過 ${sv.tried.length} 種新卡量，每一種都跑一次完整模擬`, body);

}

/**
 * 「學更多反而被稀釋」只在曲線真的往下彎時成立。範圍小的時候（例如只練名詞化）
 * 每一格的記憶率都一樣，那句話就是錯的；推薦值剛好落在掃描上限時，也還沒看到往下彎的那段。
 */
function achievableNote(sv) {
  const rates = sv.tried.map((t) => t.rate);
  const top = Math.max(...sv.tried.map((t) => t.dailyNew));
  if (pct(Math.max(...rates), 1) === pct(Math.min(...rates), 1)) {
    return `在這個範圍裡，每天學幾張新卡幾乎不影響考試當天的記憶率：0 到 ${top} 張都是 ${pct(rates[0], 1)}。`;
  }
  if (sv.recommended.dailyNew === top) return `掃到上限 ${top} 張都還達標，實際能承受的量可能更多。`;
  return '這是「還能達標的最大新卡量」——學得比這個多，考試當天的整體記憶率反而會被稀釋。';
}

// ---- 小工具 --------------------------------------------------------------

/** 還沒推演過時的畫面。說明按鈕會做什麼、要等多久、哪些設定會影響結果。 */
function emptyState() {
  const list = h('ul.fc-empty-list');
  for (const t of [
    '拿你目前每一張卡的記憶狀態，逐日模擬到考試當天。',
    '算出那天的期望答對率，以及需要每天做幾張才追得上。',
    '再反推「要達到目標答對率，每天得學幾張新卡」。',
  ]) list.append(h('li', { text: t }));

  return h('div.card.empty.fc-empty', {},
    h('p.fc-empty-lead', { text: '填好上面四格，按「推演」。' }),
    list,
    h('p.fc-empty-note', {
      text: '整輪大約一秒，因為反推那一步要跑六十幾次完整模擬。側欄的題型篩選會一起算進去。',
    }),
  );
}

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
  // 底色那一格要描邊，見 views.css 的 .legend i.blank。
  const dot = h(color === 'var(--sunken)' ? 'i.blank' : 'i');
  dot.style.background = color;
  return h('span', {}, dot, name);
}

function bucketLabel(b) {
  return `記得牢 ${num(b.strong)}、不太穩 ${num(b.shaky)}、大概忘了 ${num(b.weak)}、沒學到 ${num(b.untouched)}`;
}

/** 沒設考試日期時，預設兩個月後——夠遠到看得出排程效果，夠近到還有壓力。 */
/**
 * 從掃描結果挑出值得列表的幾列：頭、尾、勝出的那一格，中間等距補到約 10 列。
 * 全部列出來的話一次會有 61 列，讀的人只會往下捲過去。
 */
function pickRows(tried, win) {
  if (tried.length <= 12) return tried;
  const keep = new Set([0, tried.length - 1]);
  const winAt = tried.findIndex((t) => t.dailyNew === win);
  if (winAt >= 0) keep.add(winAt);
  const step = Math.max(1, Math.round(tried.length / 9));
  for (let i = 0; i < tried.length; i += step) keep.add(i);
  return [...keep].sort((a, b) => a - b).map((i) => tried[i]);
}

function examHint(saved) {
  return saved
    ? '改了日期再推演，會一併改掉設定裡的考試日期'
    : '還沒設考試日期，先用 60 天後；改了日期再推演才會記住';
}

function defaultExam() {
  const d = new Date(Date.now() + 60 * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
