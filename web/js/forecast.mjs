/**
 * 進度頁的「推演」分頁。頁首（分頁與範圍鈕）與分節跟「現況」共用，見 stats.mjs。
 *
 * 這一頁是這個 App 唯一做了「人腦做不到的計算」的地方：拿你目前每一張卡的
 * FSRS 記憶狀態，逐日模擬到考試當天，算出那天的期望答對率。
 *
 * 誠實原則（跟後端一致，這裡負責把它顯示出來）：
 *  - 評分分布來自你自己的歷史；樣本不足 50 筆時一律當 Good，並標示為假設。
 *  - 每張卡的作答秒數用你自己的中位數；不足 30 筆時用預設 8 秒，也標示出來。
 *  - 達不到目標時直接說達不到，並給出上限，不給一個看起來好看的數字。
 *  - 目標比的是「學過的卡」記得的比例；全範圍比例照列，但只當資訊（2026-10-04 使用者決定）。
 *    全範圍比例在 1.6 萬張卡、半年期限下最高只到一成多，拿它比八成五，每個設定都是「達不到」。
 */

import { h, clear, pct, num, announce } from './dom.mjs';
import { api } from './net.mjs';
import { line } from './charts.mjs';
import { progressHead, section } from './stats.mjs';
import * as motion from './motion.mjs';
import { KIND_ZH } from './kinds.mjs';

export function forecastView(root, ctx) {
  const box = h('div.progress');
  root.append(box);
  box.append(progressHead(ctx, 'forecast'));
  let dead = false;

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
    // 跟設定裡的「目標記憶率」同名，但量的東西不同：設定是每張卡到期時的機率，
    // 這裡是考試那天學過的卡記得的比例。同名是因為兩者都是「記得的機率」，差別寫在小字。
    field('目標記憶率 %', target, '考試那天學過的卡記得的比例。守住它，再找記得最多張的新卡量'),
    h('button.btn.btn-primary', { type: 'submit', text: '推演' }),
  );
  box.append(form);

  const out = h('div.prog-body');
  // 這一頁進來是空的，而且是刻意的：一次推演要把範圍內每一張卡逐日模擬到考試當天，
  // 反推目標答對率還要跑六十幾次，開頁就自動算會讓人以為 App 當掉了。
  // 但「空白＋一顆按鈕」看起來也像壞掉，所以先寫清楚按下去會發生什麼事。
  out.append(emptyState());
  box.append(out);

  async function run() {
    clear(out).append(h('p.sec-empty.fc-busy', { 'aria-busy': 'true', text: '模擬中…' }));
    try {
      const data = await api.forecast({
        ...ctx.scopeQuery(),
        exam: exam.value,
        limit: limit.value,
        new: fresh.value,
        target: Number(target.value) / 100,
      });
      if (dead) return;
      render(data);
      // 結果是整塊換掉的，螢幕報讀器不會自己念。焦點移到結論，鍵盤使用者也不必從表單一路 Tab 下來。
      announce(announceText(data, Number(target.value) / 100));
      out.querySelector('.fc-verdict')?.focus({ preventScroll: false });
      if (examTouched && exam.value !== (ctx.settings?.examDate ?? null)) rememberExam(exam.value);
    } catch (err) {
      if (!dead) clear(out).append(h('div.sec-err', {},
        h('p', { text: `推演沒有跑完：${err.message}` }),
        h('button.btn', { type: 'button', text: '再試一次', onclick: run }),
      ));
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
    const curve = [
      line(days, {
        height: 170,
        title: '每天要做的張數',
        marks: peakIdx >= 0 ? [{ at: peakIdx, label: `最高峰 ${num(p.peakDay.reviews + p.peakDay.learned)} 張` }] : [],
      }),
      h('p.sec-note', {
        text: p.days.some((x) => x.minutes)
          ? `依你自己的作答速度（每張 ${d.inputs.secondsPerCard} 秒），最忙的一天約 ${p.peakDay?.minutes ?? 0} 分鐘。`
          : '沒有足夠的作答時間紀錄，暫時無法換算成分鐘。',
      }),
      p.backlogPeak > 0
        ? h('p.sec-note', { text: `每天上限 ${p.dailyLimit} 張的話，最多會有 ${p.backlogPeak} 張被擠到隔天。` })
        : null,
    ];
    out.append(section('每天的負擔', `到 ${p.examDate} 還有 ${p.daysUntilExam} 天`, curve));

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
    out.append(section('考試當天，這些卡的狀態', '依 FSRS 推算的可提取度分組', [
      strip,
      h('div.legend', {},
        swatch('記得牢（≥90%）', 'var(--ok)'),
        swatch('不太穩（70–90%）', 'var(--warn)'),
        swatch('大概忘了（<70%）', 'var(--bad)'),
        swatch('沒學到', 'var(--sunken)'),
      ),
    ]));

    // ---- 反推新卡量 ----
    if (d.solved) out.append(solvedPanel(d.solved));

    // 三個招牌動作：結論的數字滾上來、分布條長出來、各節依序浮上來。
    motion.countUp(out.querySelector('.fc-big .num'), Math.round(p.expectedRecall), { duration: 1.2 });
    motion.grow(strip.children, { delay: 0.3, stagger: 0.08 });
    motion.rise(out.querySelectorAll('.sec'), { delay: 0.2, stagger: 0.06 });
  }

  return () => {
    dead = true;
    motion.killWithin(box);
  };
}

/**
 * 結論。一句話講完，數字放大，其餘退到底下。
 * 大數字本身用墨色，不用綠或紅：它是一個估計值，不是評分；
 * 有沒有達標交給底下那一行小字，那一行才帶語意色。
 */
function verdict(p, inputs, targetRate) {
  const learned = p.studiedByExam;
  const hit = learned > 0 && p.learnedRecallRate >= targetRate;
  // tabindex -1：推演跑完把焦點移過來用，不進 Tab 順序。
  const card = h('section.fc-verdict', { tabindex: '-1', dataset: { tone: hit ? 'ok' : 'bad' } });

  card.append(h('p.fc-kicker', { text: `考試當天（${p.examDate}）預期記得` }));
  card.append(h('p.fc-big', {},
    h('span.num', { text: num(Math.round(p.expectedRecall)) }),
    h('span.of', { text: ` / ${num(p.cardsInScope)} 張` }),
  ));
  // 目標比的是學過的卡記得幾成，這一行帶達標與否的語意色。
  // 全範圍比例放在下一行當資訊：範圍是整個題庫時大部分卡到考試前輪不到，那個比例只會是個位數，
  // 拿它當及格線的話，最大的訊息永遠是「不及格」，看不出學過的卡其實記得很牢。
  card.append(learned > 0
    ? h('p.fc-learned', {},
      '學過的 ', h('b', { text: num(learned) }), ' 張裡，約 ',
      h('b', { text: pct(Math.min(1, p.learnedRecallRate), 1) }), ' 記得',
      h('span.tone', { text: hit ? `，達到 ${pct(targetRate)} 目標。` : `，低於 ${pct(targetRate)} 目標。` }))
    : h('p.fc-learned', {}, h('span.tone', { text: '照這個設定，考試前一張也學不到。' })));
  if (p.buckets?.untouched) {
    card.append(h('p.fc-rate', {},
      '整個範圍 ',
      h('b', { text: pct(p.expectedRecallRate, 1) }),
      h('span', { text: `：有 ${num(p.buckets.untouched)} 張到考試前輪不到，算 0 分。只列出來參考，不拿來比目標。` }),
    ));
  }
  // 前提寫出來。今天頁那兩個數字用的是另一組前提，沒寫的話兩頁對不上會被當成算錯。
  card.append(h('p.sub', {
    text: `前提：從今天到 ${p.examDate} 每天做滿 ${num(p.dailyLimit)} 張，其中新卡 ${num(p.dailyNew)} 張；範圍是上方選的 ${num(p.cardsInScope)} 張卡。`
      + '今天頁的數字照最近 7 天實際做的題數推演，範圍固定是 A2–B2 全部題型，所以跟這裡不同。',
  }));
  card.append(h('p.sub', {
    text: `總作答 ${num(p.totalReviews)} 次・預期答錯 ${num(p.totalLapses)} 次・涵蓋 ${pct(p.coverage)}`,
  }));

  const asm = h('div.assumptions', {}, h('span.chip', { text: '模型假設' }));
  asm.append(p.ratingModel === 'observed'
    ? h('span.chip', { text: `答對評分：${inputs.ratingSample} 筆，樣本足夠時分題型` })
    : h('span.chip', { dataset: { kind: 'assumed' }, text: '評分分布：歷史不足，一律當作 Good' }));
  asm.append(...firstRatingChips(inputs));
  asm.append(inputs.secondsSource === 'observed'
    ? h('span.chip', { text: `時間：中位數 ${inputs.secondsPerCard} 秒，樣本足夠時分題型` })
    : h('span.chip', { dataset: { kind: 'assumed' }, text: `每張 ${inputs.secondsPerCard} 秒（預設值）` }));
  card.append(asm);
  return card;
}

/**
 * 新卡首次作答是逐題型取樣的，樣本不夠的題型一律當 Good。
 * 原本只寫「260 張，分題型」，實際上那 260 張全是看字回想，另外六種都是假設——
 * 所以把實測的題型點名，其餘的另開一個「假設」標籤，範圍只算範圍選單勾到的題型。
 */
function firstRatingChips(inputs) {
  const min = inputs.firstRatingMin ?? 30;
  const inScope = inputs.scope?.kinds?.length ? inputs.scope.kinds : Object.keys(KIND_ZH);
  const sampled = inScope.filter((kind) => inputs.firstRatingKinds?.[kind]);
  const assumed = inScope.filter((kind) => !inputs.firstRatingKinds?.[kind]);
  const chips = [];
  if (sampled.length) {
    const parts = sampled.map((kind) => `${KIND_ZH[kind] ?? kind} ${num(inputs.firstRatingKinds[kind])}`);
    chips.push(h('span.chip', { text: `首次作答實測：${parts.join('、')} 張` }));
  }
  if (assumed.length) {
    const who = assumed.length <= 3 ? assumed.map((kind) => KIND_ZH[kind] ?? kind).join('、')
      : !sampled.length ? '各題型'
        : `其餘 ${assumed.length} 種題型`;
    chips.push(h('span.chip', { dataset: { kind: 'assumed' }, text: `首次作答：${who}不足 ${min} 張，當作 Good` }));
  }
  return chips;
}

function solvedPanel(sv) {
  const body = h('div');
  const rec = sv.recommended;
  // band 是記得張數離最好那格不到 3% 的達標格子（依據見 engine/forecast.mjs 的 NEAR_BAND）。
  // 差距在模擬雜訊以內，只給一個數字是假精確。
  const band = sv.band && sv.band.from !== sv.band.to ? sv.band : null;
  if (sv.achievable) {
    body.append(h('p.lead', {},
      '每天學 ',
      h('b', { text: band ? `${band.from}–${band.to} 張新卡` : `${rec.dailyNew} 張新卡` }),
      // 帶寬內每一格都在雜訊以內，說「最多」會讓人以為那一格真的比較好。
      band ? '，考試那天記得的張數都差不多，約 ' : '，考試那天記得最多，約 ',
      h('b', { text: `${num(Math.round(rec.recall))} 張` }),
      `；學過的卡記得 ${pct(rec.learnedRate, 1)}。`,
    ));
    body.append(h('p.sec-note', { text: achievableNote(sv, band) }));
  } else {
    // 先給做得到的最好結果，再說離目標多遠；「達不到」放句首會讓整段讀起來像判決。
    body.append(h('p.lead', {},
      '每天學 ',
      h('b', { text: `${sv.ceiling.dailyNew} 張新卡` }),
      ' 時，學過的卡記得的比例最高，約 ',
      h('b', { text: pct(sv.ceiling.learnedRate, 1) }),
      `，離 ${pct(sv.target)} 目標還差 ${pct(sv.target - sv.ceiling.learnedRate, 1)}。`,
    ));
    body.append(h('p.sec-note', { text: '要接近目標，可以提高每天上限、少學一點新卡，或把考試日期往後排再重算。' }));
  }

  // 掃過的每一格畫成記得張數的曲線。這條線的形狀就是「新卡學太多反而記得更少」的證據，
  // 只看一個推薦數字是看不出來的。學過的卡記得的比例在實測資料上幾乎是一條平線
  // （0 到 60 張都在 95.7–95.9%），畫它看不出任何取捨，所以比例放進表格。
  const win = sv.achievable ? rec.dailyNew : sv.ceiling.dailyNew;
  const winAt = sv.tried.findIndex((t) => t.dailyNew === win);
  body.append(line(
    sv.tried.map((t) => ({ x: String(t.dailyNew), label: `每天 ${t.dailyNew} 張新卡`, a: Math.round(t.recall) })),
    {
      height: 170,
      title: '每天新卡量對考試那天記得張數的影響',
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
      h('th', { text: '每天新卡' }), h('th', { text: '記得張數' }),
      h('th', { text: '學過的卡記得' }), h('th', { text: '整個範圍' }), h('th', { text: '總作答' }),
    )),
  );
  const tb = h('tbody');
  for (const t of rows) {
    tb.append(h('tr', { dataset: { hit: t.dailyNew === win ? '1' : '0' } },
      h('td', { text: String(t.dailyNew) }),
      h('td', { text: num(Math.round(t.recall)) }),
      h('td', { text: pct(t.learnedRate, 1) }),
      h('td', { text: pct(t.rate, 1) }),
      h('td', { text: num(t.reviews) }),
    ));
  }
  table.append(tb);
  body.append(h('div.scroll-x', {}, table));
  return section('每天該學多少新卡', `掃過 ${sv.tried.length} 種新卡量，每一種都跑一次完整模擬`, body);
}

/**
 * 推薦值為什麼是它。每一句都要有數字撐著：範圍小的時候（例如只練名詞化）每一格都一樣，
 * 「學更多反而記得更少」就是錯的；推薦值落在掃描上限時，也還沒看到往下彎的那段。
 */
function achievableNote(sv, band) {
  const recalls = sv.tried.map((t) => Math.round(t.recall));
  const last = sv.tried[sv.tried.length - 1];
  if (Math.max(...recalls) === Math.min(...recalls)) {
    return `在這個範圍裡，每天學幾張新卡都不影響結果：0 到 ${last.dailyNew} 張都是記得 ${num(recalls[0])} 張。`;
  }
  const parts = [];
  if (band) parts.push(`這一段記得的張數相差不到 3%，在模擬的抽樣誤差以內，分不出哪一格真的比較好；這次模擬的最高點落在 ${sv.recommended.dailyNew} 張。`);
  // 超過哪一格之後學過的卡掉到目標以下，那一格就是上限。
  const over = sv.tried.find((t) => t.dailyNew > sv.recommended.dailyNew && t.learnedRate < sv.target);
  if (over) parts.push(`每天 ${over.dailyNew} 張起，學過的卡記得的比例會掉到 ${pct(sv.target)} 以下。`);
  if (sv.recommended.dailyNew === last.dailyNew) {
    parts.push(`掃到上限 ${last.dailyNew} 張，記得的張數都還在增加，實際能承受的量可能更多。`);
  } else if (Math.round(last.recall) <= Math.round(sv.recommended.recall)) {
    parts.push(`再多學也不會記得更多：每天上限是固定的，新卡多了，到期的複習就被擠到後面。`);
  }
  return parts.join('');
}

/** 推演跑完念給螢幕報讀器的一句。只講結論，細節留在畫面上。 */
function announceText(d, targetRate) {
  const p = d.plan;
  let text = `推演完成。考試那天預期記得 ${num(Math.round(p.expectedRecall))} 張`;
  if (p.studiedByExam > 0) {
    text += `，學過的卡記得 ${pct(p.learnedRecallRate, 1)}，${p.learnedRecallRate >= targetRate ? '達到' : '低於'}目標`;
  }
  return `${text}。`;
}

// ---- 小工具 --------------------------------------------------------------

/** 還沒推演過時的畫面。說明按鈕會做什麼、要等多久、哪些設定會影響結果。 */
function emptyState() {
  return h('div.fc-empty', {},
    h('p.fc-empty-lead', { text: '按「推演」，把範圍內每一張卡逐日模擬到考試那天。' }),
    h('p.fc-empty-note', { text: '算出那天記得幾張，以及每天該學多少新卡。約需一秒。' }),
  );
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

/** 沒設考試日期時，預設兩個月後——夠遠到看得出排程效果，夠近到還有壓力。 */
function defaultExam() {
  const d = new Date(Date.now() + 60 * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
