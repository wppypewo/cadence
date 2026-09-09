/**
 * 複習頁。這是整個 App 每天真正會被用到的那一頁，其餘都是它的附屬品。
 *
 * 互動設計的幾個判斷：
 *  - 鍵盤優先。打字題 Enter 送出、再 Enter 下一張；自評題 1–4 給分、空白鍵翻面。
 *    這頁會被連續按幾百次，手離開鍵盤去點滑鼠是最貴的動作。
 *  - 批改結果不會自動跳下一張。錯的時候需要時間看清楚差在哪，
 *    自動前進會把「學到東西」的那一秒鐘吃掉。
 *  - 重音鍵盤常駐。沒有法文輸入法就打不出 é，而這個 App 認真計較重音，
 *    不給輸入手段就等於逼使用者作弊。
 */

import { h, icon, clear, announce, relDays } from './dom.mjs';
import { api } from './net.mjs';
import { diffChars, missingAccents } from './shared/grade.mjs';

const ACCENTS = ['é', 'è', 'ê', 'ë', 'à', 'â', 'î', 'ï', 'ô', 'ù', 'û', 'ü', 'ç', 'œ', 'æ'];

const KIND_ZH = {
  'vocab-recall': '看字回想',
  'vocab-produce': '中翻法',
  conj: '動詞變位',
  connector: '連接詞語氣',
  pick: '挑連接詞',
  rw: '改寫整句',
  nom: '名詞化',
};

const REASON_ZH = {
  exact: '完全正確',
  case: '大小寫不同，算對',
  accent: '只差重音',
  wrong: '拼錯了',
  empty: '沒作答',
  // 挑連接詞專用的兩級。選對了格子，但寫出來的形不對。
  elision: '選對了，省音沒處理',
  family: '選對了，性數或形式不對',
  // 改寫題：缺的是指定的連接詞或它要求的語氣。
  missing: '少了必要要素',
  // 名詞化：名詞挑對了，錯在冠詞。
  article: '名詞對了，冠詞錯',
};

const RATING_ZH = [null, '忘了', '很吃力', '想起來了', '太簡單'];
// 改寫題自評的三格。問的是「整句跟解答比」，不是「記得牢不牢」，所以另一套字。
const RW_RATING_ZH = [null, '差很多', '有出入', '一致'];

export function reviewView(root, ctx) {
  const state = {
    cards: [],
    idx: 0,
    done: 0,
    startedAt: 0,
    // 改寫題第一趟的結果：要素齊全、正在等自評。這時還沒寫進紀錄。
    selfPhase: null,
    verdict: null,
    remaining: null,
    loading: true,
    error: null,
  };

  const body = h('div');
  root.append(body);

  async function load() {
    state.loading = true;
    state.error = null;
    render();
    try {
      const data = await api.queue({ ...ctx.scopeQuery(), limit: 20 });
      state.cards = data.cards;
      state.remaining = data;
      state.idx = 0;
      state.verdict = null;
      state.selfPhase = null;
      state.startedAt = performance.now();
    } catch (err) {
      state.error = err.message;
    }
    state.loading = false;
    render();
  }

  function current() {
    return state.cards[state.idx] ?? null;
  }

  function next() {
    state.verdict = null;
    state.selfPhase = null;
    state.idx += 1;
    state.startedAt = performance.now();
    if (state.idx >= state.cards.length) load();
    else render();
  }

  /** 送出一次作答。打字題在本地先批一次只為了立刻上色，記分以伺服器為準。 */
  async function submit({ answer = null, rating = null }) {
    const card = current();
    if (!card || state.verdict) return;
    const ms = Math.round(performance.now() - state.startedAt);
    try {
      const res = await api.review({ cardId: card.id, answer, rating, ms });
      // 改寫題要素齊全時伺服器只回解答、還沒記分，等使用者自評再送一次。
      if (res.phase === 'self') {
        state.selfPhase = { ...res, answered: answer };
        render();
        announce(`要素齊全。解答：${res.answer}`);
        return;
      }
      // 自評送出後就離開第一趟：兩塊面板同時留在畫面上會變成兩份解答。
      state.selfPhase = null;
      state.verdict = { ...res, answered: answer };
      state.done += 1;
      announce(verdictText(res, answer));
      render();
      // 上方那行「待複習 n・新卡 x/y」是作答後才會變的，隨佇列一起抓的那份已經過期。
      // 側欄的數字問的是同一支端點，借它回來的結果就地補上，不另外再打一次請求。
      // 只改文字不重畫，避免在使用者正要按「下一張」時把焦點搶走。
      ctx.refreshBadge().then((fresh) => {
        if (!fresh) return;
        state.remaining = fresh;
        const el = body.querySelector('.study-bar .remain');
        if (el) el.textContent = remainText(fresh);
      });
    } catch (err) {
      ctx.toast(err.message, 'bad');
    }
  }

  function render() {
    clear(body);
    if (state.loading) return void body.append(skeleton());
    if (state.error) {
      return void body.append(h('div.card.errorbox', {},
        h('p', { text: `讀不到題目：${state.error}` }),
        h('button.btn', { onclick: load, text: '再試一次' }),
      ));
    }
    const card = current();
    if (!card) return void body.append(finished(state, ctx, load));
    body.append(h('div.study', {},
      topBar(state),
      face(card, state, submit),
      state.verdict ? verdictPanel(card, state.verdict, next) : null,
    ));
    focusInput(body);
  }

  // 鍵盤：捕捉在 document 上，因為批改後焦點在按鈕上也要能按 1–4。
  function onKey(ev) {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const card = current();
    if (!card) return;
    if (state.verdict) {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); next(); }
      return;
    }
    if (card.mode === 'rewrite') {
      if (state.selfPhase && ['1', '2', '3'].includes(ev.key)) {
        ev.preventDefault();
        submit({ answer: state.selfPhase.answered, rating: Number(ev.key) });
      }
      return;
    }
    if (card.mode === 'self') {
      if (ev.key === ' ') { ev.preventDefault(); revealSelf(body); return; }
      if (['1', '2', '3', '4'].includes(ev.key) && isRevealed(body)) {
        ev.preventDefault();
        submit({ rating: Number(ev.key) });
      }
    }
  }
  document.addEventListener('keydown', onKey);

  load();
  return () => document.removeEventListener('keydown', onKey);
}

// ---- 版面片段 ------------------------------------------------------------

function topBar(state) {
  const total = state.cards.length;
  const bar = h('i');
  bar.style.width = `${total ? (state.idx / total) * 100 : 0}%`;
  const r = state.remaining;
  // 分母是這一批的張數（`api.queue` 的 limit，目前 20），不是今天要做的總數——
  // 做完這批 `load()` 會再抓一批。光寫「1 / 20」會被讀成「今天做完 20 張就收工」，
  // 但今天到期 9 張加上新卡額度 15 張其實是 24 張。所以前面明寫「這批」，
  // 今天還剩多少交給右邊那行講。
  return h('div.study-bar', {},
    h('span.num', { text: `這批 ${state.idx + 1} / ${total}` }),
    h('div.progress', { role: 'progressbar', 'aria-label': '這一批的進度', 'aria-valuenow': state.idx, 'aria-valuemin': 0, 'aria-valuemax': total }, bar),
    h('span.spacer'),
    r ? h('span.remain', { text: remainText(r) }) : null,
  );
}

function remainText(r) {
  return `待複習 ${r.remaining.due}・新卡 ${r.newToday}/${r.newLimit}`;
}

function face(card, state, submit) {
  const f = card.front ?? {};
  const box = h('div.card-face');

  box.append(h('div.face-tags', {},
    h('span.chip.chip-accent', { text: KIND_ZH[card.kind] ?? card.kind }),
    f.level ? h('span.chip', { text: f.level }) : null,
    card.state ? h('span.chip', { text: `第 ${card.state.reps + 1} 次` }) : h('span.chip', { text: '新卡' }),
    f.noisy ? h('span.chip', { text: '釋義可能不精確' }) : null,
  ));

  box.append(prompt(card, f));

  if (card.mode === 'typed') box.append(typedAnswer(card, state, submit));
  else if (card.mode === 'rewrite') box.append(rewriteAnswer(card, state, submit));
  else if (card.mode === 'choice') box.append(choiceAnswer(card, state, submit));
  else box.append(selfAnswer(card, f, state, submit));

  return box;
}

/** 題目本體。四種卡的問法不同，這裡把差異集中在一個地方。 */
function prompt(card, f) {
  const p = h('div.prompt');
  if (card.kind === 'conj') {
    p.append(h('div.cue', { text: `${f.tenseZh}・請填入變位` }));
    p.append(h('div.conj-line', {},
      h('span', { text: f.pronoun }),
      h('span.blank'),
    ));
    p.append(h('div.prompt-en', { text: `${f.verb}　${f.gloss ?? ''}`.trim() }));
    if (f.note) p.append(h('div.prompt-note', { text: f.note }));
  } else if (card.kind === 'pick') {
    p.append(h('div.cue', { text: '從方框裡挑一個填進空格，該省的音要省、性數要配好' }));
    // 方框照印。這一大題考的就是「在六個裡認出哪一個」，
    // 把選項藏起來等於換了一種題目。
    const boxEl = h('div.pick-box', { role: 'group', 'aria-label': '可選的連接詞' });
    for (const opt of f.options ?? []) boxEl.append(h('span.chip.fr', { lang: 'fr', text: opt }));
    p.append(boxEl);
    p.append(h('div.pick-sentence.fr', { lang: 'fr', text: f.prompt }));
    if (f.src) p.append(h('div.prompt-note', { text: f.src }));
  } else if (card.kind === 'rw') {
    p.append(h('div.cue', { text: '用指定的連接詞改寫整句' }));
    // 指定工具比題幹還重要：整題就是「非得用這個字不可」。
    if (f.tool) p.append(h('div.rw-tool.fr', { lang: 'fr', text: f.tool }));
    // 考卷第 III 大題給的是法文原句，擴充題庫給的是中文——標錯 lang 會讓朗讀器念錯語言。
    const fr = f.sec === 'III';
    p.append(h(fr ? 'div.rw-source.fr' : 'div.rw-source', fr ? { lang: 'fr', text: f.prompt } : { text: f.prompt }));
    if (f.src) p.append(h('div.prompt-note', { text: f.src }));
  } else if (card.kind === 'nom') {
    p.append(h('div.cue', { text: '改寫成名詞組，冠詞要一起寫' }));
    p.append(h('div.prompt-word.fr', { lang: 'fr', text: f.base }));
    // 中文釋義一定要印：規則推出來的配對不保證語意貼合，釋義擺在眼前才看得出配對有沒有問題。
    p.append(h('div.prompt-zh', { text: f.gloss || '（題庫沒有中文釋義）' }));
    // 這裡不印性別——那正是要考的東西。
    p.append(h('div.prompt-note', { text: [f.posZh, f.src].filter(Boolean).join('・') }));
  } else if (card.kind === 'connector') {
    p.append(h('div.cue', { text: '這個連接詞後面接什麼語氣？' }));
    p.append(h('div.prompt-word.fr', { lang: 'fr', text: f.connector }));
    if (f.zh) p.append(h('div.prompt-en', { text: f.zh }));
  } else if (card.kind === 'vocab-produce') {
    p.append(h('div.cue', { text: '這個意思的法文怎麼寫？' }));
    p.append(h('div.prompt-zh', { text: f.gloss || f.en || '（沒有釋義）' }));
    if (f.en && f.gloss) p.append(h('div.prompt-en', { lang: 'en', text: f.en }));
    p.append(h('div.prompt-note', { text: [f.posZh, f.gender].filter(Boolean).join('・') }));
  } else {
    p.append(h('div.cue', { text: '這個字是什麼意思？' }));
    p.append(h('div.prompt-word.fr', { lang: 'fr', text: f.word }));
    p.append(h('div.prompt-note', { text: [f.posZh, f.gender, f.level].filter(Boolean).join('・') }));
  }
  return p;
}

function typedAnswer(card, state, submit) {
  const input = h('input.answer-input.answer-target', {
    type: 'text', lang: 'fr', autocomplete: 'off', autocapitalize: 'off',
    spellcheck: false, placeholder: '打上法文，重音要打對',
    'aria-label': '作答',
    disabled: Boolean(state.verdict),
  });
  if (state.verdict) input.value = state.verdict.answered ?? '';

  const form = h('form.answer-row', {
    onsubmit: (ev) => { ev.preventDefault(); submit({ answer: input.value }); },
  }, input);

  // Enter 明寫成 keydown，不靠表單的隱式送出。隱式送出交給瀏覽器自己判斷按鍵，
  // 實測自動化工具送進來的 Enter（key 是 Enter、keyCode 卻是 0）就不會觸發；
  // 真人打字兩條路都通，但只有明寫的這條測得到。
  // isComposing／keyCode 229 是給輸入法的——選字階段的 Enter 是在確認候選字，不是要交卷。
  input.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' || ev.isComposing || ev.keyCode === 229) return;
    ev.preventDefault();
    submit({ answer: input.value });
  });

  if (!state.verdict) {
    form.append(accentBar(input));
    form.append(h('div.study-actions', {},
      h('button.btn.btn-primary', { type: 'submit', text: '對答案' }),
      h('button.btn.btn-quiet', {
        type: 'button', text: '不會，直接看',
        onclick: () => submit({ answer: '' }),
      }),
      h('span.spacer'),
      h('span.kbd-hint', {}, h('kbd', { text: 'Enter' }), ' 送出'),
    ));
  }
  return form;
}

/**
 * 重音列。用 setRangeText 插在游標處，而且刻意不搶焦點——
 * 點完符號還要繼續打字，焦點跳走就得再點一次輸入框。
 */
function accentBar(input) {
  const bar = h('div.accents', { role: 'group', 'aria-label': '插入法文重音字母' });
  for (const ch of ACCENTS) {
    bar.append(h('button', {
      type: 'button', text: ch, tabindex: -1, title: `插入 ${ch}`,
      onmousedown: (ev) => ev.preventDefault(),
      onclick: () => {
        const at = input.selectionStart ?? input.value.length;
        input.setRangeText(ch, at, input.selectionEnd ?? at, 'end');
        input.focus();
      },
    }));
  }
  return bar;
}

/**
 * 改寫題。兩趟：先寫整句，要素齊全才看得到解答並自評。
 *
 * 解答不能在作答前就送到前端——這一題唯一的難處就是自己造得出那個句子，
 * 提早看到解答等於整題作廢。所以第一趟只送作答，伺服器判完要素才把解答給下來。
 */
function rewriteAnswer(card, state, submit) {
  const self = state.selfPhase;
  const input = h('textarea.answer-input.answer-area.answer-target', {
    lang: 'fr', autocomplete: 'off', autocapitalize: 'off', spellcheck: false,
    rows: '3', placeholder: '把整句寫出來，重音要打對',
    'aria-label': '改寫後的句子',
    disabled: Boolean(state.verdict || self),
  });
  if (state.verdict || self) input.value = (state.verdict?.answered ?? self?.answered) ?? '';

  const form = h('form.answer-row', {
    onsubmit: (ev) => { ev.preventDefault(); submit({ answer: input.value }); },
  }, input);

  // 換行對一個句子沒有用處，Enter 直接送出，跟其他題型一致。
  input.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' || ev.isComposing || ev.keyCode === 229) return;
    ev.preventDefault();
    submit({ answer: input.value });
  });

  if (self) {
    form.append(rwSelfRating(self, submit));
    return form;
  }
  if (!state.verdict) {
    form.append(accentBar(input));
    form.append(h('div.study-actions', {},
      h('button.btn.btn-primary', { type: 'submit', text: '對答案' }),
      h('button.btn.btn-quiet', {
        type: 'button', text: '不會，直接看',
        onclick: () => submit({ answer: '' }),
      }),
      h('span.spacer'),
      h('span.kbd-hint', {}, h('kbd', { text: 'Enter' }), ' 送出'),
    ));
  }
  return form;
}

/** 要素齊全之後的自評：整句沒有唯一解，只有自己看得出差在哪。 */
function rwSelfRating(self, submit) {
  const box = h('div.rw-self');
  box.append(h('div.verdict-head', {}, icon('check'), h('span', {
    text: self.grade.accent?.length ? '要素齊全，但有字漏了重音' : '指定的連接詞與語氣都對了',
  })));
  if (self.grade.accent?.length) {
    box.append(h('p.verdict-note', {
      text: `漏重音的是：${self.grade.accent.map((alts) => alts[0]).join('、')}`,
    }));
  }
  box.append(h('div.cue', { text: '解答' }));
  box.append(h('div.rw-answer.fr', { lang: 'fr', text: self.answer ?? '' }));
  if (self.note) box.append(h('p.verdict-note', { text: self.note }));
  if (self.src) box.append(h('p.verdict-note', { text: self.src }));

  box.append(h('div.cue', { text: '整句跟解答比' }));
  const rate = h('div.ratings', { dataset: { n: '3' }, role: 'group', 'aria-label': '整句跟解答比' });
  for (let r = 1; r <= 3; r += 1) {
    rate.append(h('button', {
      type: 'button', dataset: { r: String(r) },
      onclick: () => submit({ answer: self.answered, rating: r }),
    }, h('b', { text: RW_RATING_ZH[r] }), h('small', { text: String(r) })));
  }
  box.append(rate);
  box.append(h('span.kbd-hint', {}, h('kbd', { text: '1' }), '–', h('kbd', { text: '3' }), ' 給分'));
  queueMicrotask(() => rate.querySelector('button')?.focus());
  return box;
}

function choiceAnswer(card, state, submit) {
  const box = h('div.choices', { role: 'group', 'aria-label': '選一個答案' });
  const picked = state.verdict?.answered ?? null;
  for (const opt of card.front?.options ?? []) {
    let mark = null;
    if (state.verdict) {
      if (opt === state.verdict.answer) mark = 'ok';
      else if (opt === picked) mark = 'bad';
    }
    box.append(h('button', {
      type: 'button', lang: 'fr', text: opt,
      disabled: Boolean(state.verdict),
      dataset: mark ? { mark } : {},
      onclick: () => submit({ answer: opt }),
    }));
  }
  return box;
}

/**
 * 自評題（看字回想意思）。先翻面看答案，再誠實給分。
 * 不做自動批改是因為「這個字的意思」沒有唯一字串答案，
 * 硬要比對只會製造假錯誤。
 */
function selfAnswer(card, f, state, submit) {
  const box = h('div.answer-row');
  const back = h('div.prompt', { hidden: true });
  back.append(h('div.prompt-zh', { text: f.gloss || '（題庫沒有中文釋義）' }));
  if (f.en) back.append(h('div.prompt-en', { lang: 'en', text: f.en }));
  if (f.glossSource) back.append(h('div.prompt-note', { text: `釋義來源：${f.glossSource}` }));

  const reveal = h('button.btn.btn-primary.reveal-btn', {
    type: 'button', text: '看答案',
    onclick: () => {
      back.hidden = false;
      reveal.hidden = true;
      rate.hidden = false;
      rate.querySelector('button')?.focus();
    },
  });

  const rate = h('div.ratings', { hidden: true, role: 'group', 'aria-label': '這張卡剛才回想得如何' });
  for (let r = 1; r <= 4; r += 1) {
    rate.append(h('button', {
      type: 'button', dataset: { r: String(r) },
      onclick: () => submit({ rating: r }),
    }, h('b', { text: RATING_ZH[r] }), h('small', { text: String(r) })));
  }

  box.append(back, reveal, rate);
  if (!state.verdict) {
    box.append(h('span.kbd-hint', {}, h('kbd', { text: 'Space' }), ' 看答案，', h('kbd', { text: '1' }), '–', h('kbd', { text: '4' }), ' 給分'));
  }
  return box;
}

// ---- 批改結果 ------------------------------------------------------------

function tone(res) {
  // 改寫題（grade 帶 miss 陣列）要素齊全時，語氣由自評決定，不看 reason——
  // reason 只說「要素在不在」，說不出整句寫得好不好。
  if (res.grade?.miss) {
    if (!res.grade.correct) return 'bad';
    return res.rating >= 3 ? 'ok' : res.rating === 2 ? 'near' : 'bad';
  }
  if (!res.grade) return res.rating >= 3 ? 'ok' : res.rating === 2 ? 'near' : 'bad';
  if (res.grade.reason === 'exact' || res.grade.reason === 'case') return 'ok';
  if (res.grade.reason === 'accent') return 'near';
  return 'bad';
}

function verdictText(res, answered) {
  if (!res.grade) return `記為「${RATING_ZH[res.rating]}」，下次 ${relDays(res.state.intervalDays)}`;
  if (res.grade.miss) return `${headText(res)}。下次 ${relDays(res.state.intervalDays)}`;
  const r = REASON_ZH[res.grade.reason] ?? res.grade.reason;
  return `${r}。正確答案 ${res.answer}${answered ? `，你寫的是 ${answered}` : ''}`;
}

/** 批改面板最上面那一行。改寫題自評過就報自評，其餘報錯法。 */
function headText(res) {
  if (!res.grade) return `記為「${RATING_ZH[res.rating]}」`;
  if (res.grade.miss && res.grade.correct) return `要素齊全，自評「${RW_RATING_ZH[res.rating] ?? RATING_ZH[res.rating]}」`;
  return REASON_ZH[res.grade.reason] ?? res.grade.reason ?? '';
}

function verdictPanel(card, res, next) {
  const t = tone(res);
  const box = h('div.verdict', { dataset: { tone: t }, tabindex: -1 });

  box.append(h('div.verdict-head', {},
    icon(t === 'ok' ? 'check' : t === 'near' ? 'alert' : 'cross'),
    h('span', { text: headText(res) }),
  ));

  // 改寫題不做逐字比對：整句有好幾種寫法都對，拿解答當骨架比一遍會整片標紅。
  if (card.kind === 'rw') {
    if (res.grade?.miss?.length) {
      box.append(h('p.verdict-note', {
        text: `少了：${res.grade.miss.map((alts) => alts.join('／')).join('、')}。指定的連接詞與它要求的語氣是這一題的考點，缺一就不算改對。`,
      }));
    }
    if (res.answer) {
      box.append(h('div.cue', { text: '解答' }));
      box.append(h('div.rw-answer.fr', { lang: 'fr', text: res.answer }));
    }
  } else if (res.answer) {
    // 逐字比對：以正確答案為骨架，把使用者沒打對的字元標出來。
    const line = h('div.verdict-answer.fr', { lang: 'fr' });
    for (const { ch, ok } of diffChars(res.answered ?? '', res.answer)) {
      line.append(h('span', { class: ok ? 'ch' : 'ch bad', text: ch }));
    }
    box.append(line);
  }

  if (res.grade && res.grade.reason === 'article') {
    box.append(h('p.verdict-note', {
      text: '名詞挑對了，錯的是冠詞。陰陽性是這一題型的一半分數，考卷上寫錯 le／la 一樣不給分。',
    }));
  }

  if (res.grade && (res.grade.reason === 'elision' || res.grade.reason === 'family')) {
    box.append(h('p.verdict-note', {
      text: res.grade.reason === 'elision'
        ? '方框選對了，錯在省音：後面接的字以母音開頭，que／de／si 要縮寫。考卷上這樣寫不給分。'
        : '方框選對了，錯在形式：quel que 這一組要跟後面的主語配性數。考卷上這樣寫不給分。',
    }));
  }

  // 改寫題的重音提示來自要素比對，不能拿整句去對——
  // 使用者寫的句子跟解答本來就不一樣長，逐字比會挑出一堆不存在的漏字。
  if (card.kind === 'rw' && res.grade?.accent?.length) {
    box.append(h('p.verdict-note', {
      text: `要素齊全，但漏了重音：${res.grade.accent.map((alts) => alts[0]).join('、')}。這在 cadence 裡算對，考卷上會被扣分。`,
    }));
  } else if (card.kind !== 'rw' && res.grade && res.grade.reason === 'accent') {
    const missed = missingAccents(res.answered ?? '', res.answer ?? '');
    box.append(h('p.verdict-note', {
      text: missed.length
        ? `字母全對，漏的是 ${missed.join('、')}。這在 cadence 裡算錯——考卷上也是。`
        : '字母全對，差在變音符號。',
    }));
  }

  if (res.answered && res.grade && (card.kind === 'rw' || res.grade.reason !== 'exact')) {
    box.append(h('p.verdict-yours', {}, '你寫的：', h('span', { lang: 'fr', text: res.answered || '（空白）' })));
  }
  if (res.accept && res.accept.length > 1) {
    box.append(h('p.verdict-note', { lang: 'fr', text: `也接受：${res.accept.slice(1).join('、')}` }));
  }
  if (res.note) box.append(h('p.verdict-note', { text: res.note }));

  box.append(h('div.verdict-sched', {},
    h('span', {}, '下次複習　', h('b', { text: relDays(res.state.intervalDays) })),
    h('span', {}, '記憶穩定度　', h('b', { text: `${res.state.stability.toFixed(1)} 天` })),
    h('span', {}, '累計答錯　', h('b', { text: String(res.state.lapses) })),
  ));

  box.append(h('div.study-actions', {},
    h('button.btn.btn-primary', { type: 'button', text: '下一張', onclick: next }),
    h('span.spacer'),
    h('span.kbd-hint', {}, h('kbd', { text: 'Enter' }), ' 繼續'),
  ));

  queueMicrotask(() => box.querySelector('.btn-primary')?.focus());
  return box;
}

// ---- 空狀態與載入 --------------------------------------------------------

function finished(state, ctx, reload) {
  const r = state.remaining;
  const nothingLeft = r && r.remaining.due === 0 && (r.newToday >= r.newLimit || r.remaining.new === 0);
  return h('div.card.empty', {},
    icon('check'),
    h('h2', { text: state.done ? `這一輪做完了，共 ${state.done} 張` : '現在沒有到期的卡' }),
    h('p', {
      text: nothingLeft
        ? '今天的新卡額度也用完了。休息比硬撐有效——FSRS 的排程已經替明天算好了。'
        : '還有卡可以練，按下面繼續。',
    }),
    h('div.study-actions', {},
      nothingLeft ? null : h('button.btn.btn-primary', { text: '再來一輪', onclick: reload }),
      h('button.btn', { text: '看統計', onclick: () => ctx.go('stats') }),
    ),
  );
}

function skeleton() {
  const box = h('div.card-face');
  for (const [w, hh] of [['30%', 18], ['70%', 40], ['100%', 56]]) {
    const bar = h('div.skeleton');
    bar.style.width = w;
    bar.style.height = `${hh}px`;
    box.append(bar);
  }
  box.setAttribute('aria-busy', 'true');
  return box;
}

// ---- 焦點 ----------------------------------------------------------------

function focusInput(root) {
  const target = root.querySelector('.answer-target:not([disabled])');
  if (target) target.focus();
}

function isRevealed(root) {
  const btn = root.querySelector('.reveal-btn');
  return Boolean(btn && btn.hidden);
}

function revealSelf(root) {
  const btn = root.querySelector('.reveal-btn');
  if (btn && !btn.hidden) btn.click();
}
