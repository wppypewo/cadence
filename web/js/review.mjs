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

// 題庫存的是機器代碼（src/build/bank.mjs），直接印出來畫面上就是「釋義來源：manual」。
// 認不得的值不印：多一行看不懂的字，比少一行出處更糟。
const GLOSS_SOURCE_ZH = {
  'Wiktionnaire-fr': '中文釋義取自法文維基詞典（Wiktionnaire）',
  manual: '中文釋義為人工整理',
};

export function reviewView(root, ctx) {
  const preset = ctx.takeReviewPreset();
  const state = {
    cards: [],
    idx: 0,
    // 這次進頁面以來的累計，給停頓頁與完成畫面的摘要用。ms 只算作答時間，不含看批改。
    done: 0,
    again: 0,
    ms: 0,
    startedAt: 0,
    // 改寫題第一趟的結果：要素齊全、正在等自評。這時還沒寫進紀錄。
    selfPhase: null,
    verdict: null,
    remaining: null,
    // 到期卡清完後的那一次停頓。為 true 時下一批已經抓好放在 cards，只是先不顯示。
    checkpoint: false,
    loading: true,
    error: null,
    preset,
    focus: new Map(),
    // 名詞化與改寫整句的新卡，這次進頁面已經看過解答的 id。跨批保留：
    // 看過之後的那次考試才是第一次作答，不能因為換批又先給看一次。
    previewed: new Set(),
    // 正在顯示的那張「先看解答」：{ id, data, error }。解答另外抓，佇列裡沒有。
    study: null,
  };

  const body = h('div');
  root.append(body);

  async function load() {
    state.loading = true;
    state.error = null;
    render();
    try {
      const data = await api.queue({ ...ctx.scopeQuery(), limit: 20, preset: state.preset });
      state.cards = data.cards;
      state.remaining = data;
      state.idx = 0;
      state.verdict = null;
      state.selfPhase = null;
      state.startedAt = performance.now();
      // 新卡不設上限之後一批接一批沒有盡頭，到期卡清完是唯一自然的收工點。
      // 用剛抓回來的 remaining 判斷，不用作答後 refreshBadge 補的那份——那份是非同步的，
      // 「下一張」按得快時還沒回來。一天只停一次：停過之後還在練就是要加練，不再攔。
      state.checkpoint = !state.preset && state.done > 0 && data.cards.length > 0
        && data.remaining.due === 0 && !enoughShownToday();
      if (state.checkpoint) markEnoughShown();
    } catch (err) {
      state.error = err.message;
    }
    state.loading = false;
    render();
  }

  function loadPreview(card) {
    state.study = { id: card.id, data: null, error: null };
    api.preview(card.id).then(
      (data) => {
        if (state.study?.id !== card.id) return;
        state.study.data = data;
        render();
      },
      (err) => {
        if (state.study?.id !== card.id) return;
        // 拿不到解答（例如別的分頁剛考過這張）就直接考，不要卡在一個按不下去的畫面。
        state.previewed.add(card.id);
        state.study = null;
        ctx.toast(`讀不到解答，直接作答：${err.message}`, 'bad');
        render();
      },
    );
  }

  /**
   * 看完解答，這張移到這一批後面幾張再考。緊接著考只是抄剛才那一眼，
   * 隔幾張才是從記憶裡拿。這一步不送任何東西給伺服器，reviews.jsonl 一行都不會多。
   */
  function seenPreview() {
    const card = current();
    if (!card || !state.study?.data) return;
    state.previewed.add(card.id);
    state.study = null;
    const [moved] = state.cards.splice(state.idx, 1);
    state.cards.splice(Math.min(state.idx + PREVIEW_GAP, state.cards.length), 0, moved);
    state.startedAt = performance.now();
    render();
    announce('這張稍後再考');
  }

  function keepGoing() {
    state.checkpoint = false;
    state.startedAt = performance.now();
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
    if (state.idx >= state.cards.length) {
      if (state.preset) render();
      else load();
    }
    else render();
  }

  async function correct(rating) {
    const old = state.verdict;
    if (!old?.reviewId || state.pending || rating === old.rating) return;
    const labels = current()?.kind === 'rw' ? RW_RATING_ZH : RATING_ZH;
    state.pending = true;
    try {
      const changed = await api.correctReview({ id: old.reviewId, rating });
      if (old.rating === 1 && rating !== 1) state.again -= 1;
      if (old.rating !== 1 && rating === 1) state.again += 1;
      state.verdict = { ...old, rating, state: changed.state, corrected: true };
      announce(`剛才的評分已改為「${labels[rating]}」`);
      render();
      ctx.refreshBadge();
    } catch (err) {
      ctx.toast(err.message, 'bad');
    } finally {
      state.pending = false;
    }
  }

  /** 送出一次作答。打字題在本地先批一次只為了立刻上色，記分以伺服器為準。 */
  async function submit({ answer = null, rating = null }) {
    const card = current();
    // pending 擋的是「回應回來之前又送一次」：數字鍵、Enter 連按兩下都會在
    // state.verdict 還沒設好之前再進來一次，reviews.jsonl 只增不改，重複那行刪不掉。
    if (!card || state.verdict || state.pending) return;
    state.pending = true;
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
      if (res.rating === 1) state.again += 1;
      if (res.rating === 1) {
        const key = res.grade?.reason ?? card.kind;
        state.focus.set(key, (state.focus.get(key) ?? 0) + 1);
      }
      // 加總時單張封頂，送給伺服器的仍是原始 ms。卡片開著人走開，計時會一直跑：
      // 實測有一張 pick 記到 25 分鐘，一張就能把「作答時間共 n 分鐘」灌大好幾倍。
      // 上限跟統計頁取中位數時的 120 秒一致。
      state.ms += Math.min(ms, SESSION_MS_CAP);
      announce(verdictText(card, res, answer));
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
    } finally {
      state.pending = false;
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
    if (state.checkpoint) {
      body.append(checkpoint(state, ctx, keepGoing));
      body.querySelector('.empty h2')?.focus();
      return;
    }
    const card = current();
    if (!card) {
      body.append(finished(state, ctx, load));
      // 上一張的「下一張」鈕已經被清掉，不接住的話焦點掉回 body，報讀器也不會念出做完了。
      body.querySelector('.empty h2')?.focus();
      return;
    }
    if (needsPreview(card, state)) {
      if (state.study?.id !== card.id) loadPreview(card);
      body.append(h('div.study', {}, topBar(state), studyFace(card, state.study, seenPreview)));
      focusInput(body);
      return;
    }
    body.append(h('div.study', {},
      topBar(state),
      face(card, state, submit),
      state.verdict ? verdictPanel(card, state.verdict, next, correct) : null,
    ));
    focusInput(body);
  }

  // 鍵盤：捕捉在 document 上，因為批改後焦點在按鈕上也要能按 1–4。
  function onKey(ev) {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    // 按住不放的自動重複一律不算：按住 Enter 會一路「下一張」，批改結果連看都沒看到。
    if (ev.repeat) return;
    // 停頓頁底下的下一批已經抓好，current() 會回傳一張畫面上看不到的卡，
    // 不擋的話按 Space、3 會替那張沒看過的卡評分。
    if (state.checkpoint) return;
    // 設定對話框開著、或焦點在輸入框裡時，按鍵是打給那裡的——
    // 在設定裡打「3」不該順手替這張卡評分。作答框自己的 Enter 由它自己的 keydown 處理。
    const t = ev.target;
    if (t?.closest?.('dialog[open]') || t?.matches?.('input, textarea, select, [contenteditable="true"]')) return;
    const card = current();
    if (!card) return;
    if (needsPreview(card, state)) {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); seenPreview(); }
      return;
    }
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
    if (card.mode === 'choice') {
      // 只收 1–9：選項最多六個（挑連接詞），數字鍵對到第幾個就送第幾個。
      const opts = card.front?.options ?? [];
      const n = /^[1-9]$/.test(ev.key) ? Number(ev.key) : 0;
      if (n && n <= opts.length) { ev.preventDefault(); submit({ answer: opts[n - 1] }); }
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

/** 先看解答的卡，看完之後往後挪幾張再考。 */
const PREVIEW_GAP = 4;

/**
 * 名詞化與改寫整句的新卡第一次出現時先給看解答（2026-09-24 使用者決定）。
 * 這兩種題考的是規則（-eur 陰性、alors que 接直陳式），沒學過規則就要憑空寫，
 * 答錯記下來的不是「忘了」，排程會把它當成一張很難的卡。
 */
function needsPreview(card, state) {
  return (card.kind === 'nom' || card.kind === 'rw') && !card.state && !state.previewed.has(card.id);
}

function studyFace(card, study, seen) {
  const f = card.front ?? {};
  const box = h('div.card-face');
  box.append(h('div.face-tags', {},
    h('span.chip.chip-accent', { text: KIND_ZH[card.kind] ?? card.kind }),
    h('span.chip', { text: '新卡・先看解答' }),
  ));
  box.append(prompt(card, f));

  const panel = h('div.study-answer');
  const d = study?.data;
  if (!d) {
    panel.append(h('p.verdict-note', { text: '讀取解答中…' }));
  } else {
    panel.append(h('div.cue', { text: '解答' }));
    panel.append(h(card.kind === 'rw' ? 'div.rw-answer.fr' : 'div.verdict-answer.fr', { lang: 'fr', text: d.answer ?? '' }));
    if (d.note) panel.append(h('p.verdict-note', { text: d.note }));
    panel.append(h('p.verdict-note', { text: '這次不計分。隔幾張之後會正式考這一題。' }));
  }
  box.append(panel);
  box.append(h('button.btn.btn-primary.answer-target', {
    type: 'button', onclick: seen, disabled: !d, text: '看過了，稍後再考',
  }));
  return box;
}

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
  // newLimit 為 null 是不設上限，寫成「3/null」或「3/∞」都不如直接說今天學了幾張。
  if (r.newLimit === null) return `待複習 ${r.remaining.due}・今天新學 ${r.newToday} 張`;
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
  else box.append(selfAnswer(card, state, submit));

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
  input.addEventListener('keydown', (ev) => answerKey(ev, input, submit));

  if (!state.verdict) {
    form.append(accentBar(input));
    form.append(answerActions(submit));
  }
  return form;
}

/**
 * 作答框的 Enter。Shift+Enter 等於「不會，直接看」：手已經在鍵盤上，
 * 為了放棄一題去摸滑鼠是這頁最貴的動作。不用 Esc，是因為 Esc 常被順手按來關東西，
 * 誤觸就是一筆「忘了」寫進只增不改的紀錄。
 */
function answerKey(ev, input, submit) {
  if (ev.key !== 'Enter' || ev.isComposing || ev.keyCode === 229) return;
  ev.preventDefault();
  if (ev.repeat) return;
  submit({ answer: ev.shiftKey ? '' : input.value });
}

function answerActions(submit) {
  return h('div.study-actions', {},
    h('button.btn.btn-primary', { type: 'submit', text: '對答案', 'aria-keyshortcuts': 'Enter' }),
    h('button.btn.btn-quiet', {
      type: 'button', text: '不會，直接看', 'aria-keyshortcuts': 'Shift+Enter',
      onclick: () => submit({ answer: '' }),
    }),
    h('span.spacer'),
    h('span.kbd-hint', {},
      h('kbd', { text: 'Enter' }), ' 送出　',
      h('kbd', { text: 'Shift' }), '+', h('kbd', { text: 'Enter' }), ' 不會'),
  );
}

/**
 * 重音列。用 setRangeText 插在游標處，而且刻意不搶焦點——
 * 點完符號還要繼續打字，焦點跳走就得再點一次輸入框。
 *
 * 鍵盤走 roving tabindex：整排只佔一個 Tab 停點，進來之後左右鍵換字、Enter 插入並回到輸入框。
 * 原本十五顆全是 tabindex -1，沒有滑鼠就完全用不到；全開成 0 又會讓「對答案」隔著十五下 Tab。
 * 停點記在上次用過的那顆，連打兩個 é 不必每次從頭數。
 */
function accentBar(input) {
  const bar = h('div.accents', { role: 'toolbar', 'aria-label': '插入法文重音字母' });
  const keys = ACCENTS.map((ch, i) => h('button', {
    type: 'button', text: ch, tabindex: i === 0 ? 0 : -1, title: `插入 ${ch}`,
    onmousedown: (ev) => ev.preventDefault(),
    onclick: () => {
      const at = input.selectionStart ?? input.value.length;
      input.setRangeText(ch, at, input.selectionEnd ?? at, 'end');
      rove(i, false);
      input.focus();
    },
  }));
  function rove(to, focus) {
    keys.forEach((k, i) => { k.tabIndex = i === to ? 0 : -1; });
    if (focus) keys[to].focus();
  }
  bar.addEventListener('keydown', (ev) => {
    const i = keys.indexOf(ev.target);
    if (i < 0) return;
    const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: keys.length - 1 }[ev.key];
    if (to === undefined) return;
    ev.preventDefault();
    rove((to + keys.length) % keys.length, true);
  });
  bar.append(...keys);
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
  input.addEventListener('keydown', (ev) => answerKey(ev, input, submit));

  if (self) {
    form.append(rwSelfRating(self, submit));
    return form;
  }
  if (!state.verdict) {
    form.append(accentBar(input));
    form.append(answerActions(submit));
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
  // 群組本身是焦點落點（tabindex -1）：上一張的「下一張」鈕被清掉後焦點要有地方接，
  // 又不能直接落在第一個選項上——那樣一按 Enter 就替使用者選了第一個。
  const box = h('div.choices.answer-target.landing', { role: 'group', 'aria-label': '選一個答案', tabindex: -1 });
  const picked = state.verdict?.answered ?? null;
  const opts = card.front?.options ?? [];
  // 連接詞卡帶 optionZh（語氣的中文），挑連接詞卡的選項本身就是法文詞、沒有這一欄。
  const zh = card.front?.optionZh ?? {};
  opts.forEach((opt, i) => {
    let mark = null;
    if (state.verdict) {
      if (opt === state.verdict.answer) mark = 'ok';
      else if (opt === picked) mark = 'bad';
    }
    // 已經批改過的選項按不動，數字鍵提示一起拿掉，免得看起來還能按。
    const key = i < 9 && !state.verdict ? String(i + 1) : null;
    const btn = h('button', {
      type: 'button',
      disabled: Boolean(state.verdict),
      dataset: mark ? { mark } : {},
      'aria-keyshortcuts': key,
      onclick: () => submit({ answer: opt }),
    }, key ? h('kbd', { text: key, 'aria-hidden': 'true' }) : null, h('span.fr', { lang: 'fr', text: opt }));
    // 中文放在法文底下，不取代它：考卷上印的是 subjonctif，
    // 只認得「虛擬式」的人到了考場一樣認不出來。
    if (zh[opt]) btn.append(h('small', { text: zh[opt] }));
    box.append(btn);
  });
  const last = Math.min(opts.length, 9);
  return h('div.answer-row', {}, box,
    state.verdict || !last ? null
      : h('span.kbd-hint', {}, h('kbd', { text: '1' }), '–', h('kbd', { text: String(last) }), ' 選答案'));
}

/**
 * 自評題（看字回想意思）。先翻面看答案，再誠實給分。
 * 不做自動批改是因為「這個字的意思」沒有唯一字串答案，
 * 硬要比對只會製造假錯誤。
 */
function selfAnswer(card, state, submit) {
  const box = h('div.answer-row');
  const back = h('div.prompt', { hidden: true });
  const err = h('p.field-error', { hidden: true });

  // answer-target：新卡出來時焦點落在這顆上，Enter 與 Space 都能翻面。
  const reveal = h('button.btn.btn-primary.reveal-btn.answer-target', {
    type: 'button', text: '看答案',
    onclick: async () => {
      reveal.disabled = true;
      try {
        const answer = await api.reveal(card.id);
        back.append(h('div.prompt-zh', { text: answer.gloss || '（題庫沒有中文釋義）' }));
        if (answer.en) back.append(h('div.prompt-en', {
          lang: 'en', text: Array.isArray(answer.en) ? answer.en.join('；') : answer.en,
        }));
        if (GLOSS_SOURCE_ZH[answer.glossSource]) back.append(h('div.prompt-note', { text: GLOSS_SOURCE_ZH[answer.glossSource] }));
        // 每顆評分鍵寫上它會把這張卡排到哪一天。「想起來了」與「太簡單」差三天還是三十天，
        // 看不到就很難誠實地分。舊伺服器沒有這個欄位時留白。
        rate.querySelectorAll('.iv').forEach((node, i) => {
          node.textContent = answer.intervals?.[i] ? relDays(answer.intervals[i]) : '';
        });
        back.hidden = false;
        reveal.hidden = true;
        rate.hidden = false;
        rate.querySelector('button')?.focus();
      } catch (e) {
        err.textContent = `讀不到答案：${e.message}`;
        err.hidden = false;
        reveal.disabled = false;
      }
    },
  });

  const rate = h('div.ratings', { hidden: true, role: 'group', 'aria-label': '這張卡剛才回想得如何' });
  for (let r = 1; r <= 4; r += 1) {
    rate.append(h('button', {
      type: 'button', dataset: { r: String(r) },
      onclick: () => submit({ rating: r }),
    }, h('b', { text: RATING_ZH[r] }), h('span.iv'), h('small', { text: String(r) })));
  }

  box.append(back, reveal, err, rate);
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

/**
 * 錯法的中文。選擇題的 wrong 另外講：按錯選項不是拼寫問題，
 * 原本共用「拼錯了」，連接詞卡答錯時畫面說的是一件沒發生的事。
 */
function reasonText(card, reason) {
  if (card?.mode === 'choice' && reason === 'wrong') return '選錯了';
  return REASON_ZH[reason] ?? reason ?? '';
}

function verdictText(card, res, answered) {
  if (!res.grade) return `記為「${RATING_ZH[res.rating]}」，下次 ${relDays(res.state.intervalDays)}`;
  if (res.grade.miss) return `${headText(card, res)}。下次 ${relDays(res.state.intervalDays)}`;
  const r = reasonText(card, res.grade.reason);
  const verb = card?.mode === 'choice' ? '選' : '寫';
  return `${r}。正確答案 ${res.answer}${answered ? `，你${verb}的是 ${answered}` : ''}`;
}

/** 批改面板最上面那一行。改寫題自評過就報自評，其餘報錯法。 */
function headText(card, res) {
  if (!res.grade) return `記為「${RATING_ZH[res.rating]}」`;
  if (res.grade.miss && res.grade.correct) return `要素齊全，自評「${RW_RATING_ZH[res.rating] ?? RATING_ZH[res.rating]}」`;
  return reasonText(card, res.grade.reason);
}

function verdictPanel(card, res, next, correct) {
  const t = tone(res);
  const box = h('div.verdict', { dataset: { tone: t }, tabindex: -1 });

  box.append(h('div.verdict-head', {},
    icon(t === 'ok' ? 'check' : t === 'near' ? 'alert' : 'cross'),
    h('span', { text: headText(card, res) }),
  ));

  // 改寫題不做逐字比對：整句有好幾種寫法都對，拿解答當骨架比一遍會整片標紅。
  if (card.mode === 'self') {
    if (res.answer) box.append(h('div.prompt-zh', { text: res.answer }));
    if (res.en?.length) box.append(h('div.prompt-en', {
      lang: 'en', text: Array.isArray(res.en) ? res.en.join('；') : res.en,
    }));
    if (GLOSS_SOURCE_ZH[res.glossSource]) box.append(h('p.verdict-note', { text: GLOSS_SOURCE_ZH[res.glossSource] }));
  } else if (card.kind === 'rw') {
    if (res.grade?.miss?.length) {
      box.append(h('p.verdict-note', {
        text: `少了：${res.grade.miss.map((alts) => alts.join('／')).join('、')}。指定的連接詞與它要求的語氣是這一題的考點，缺一就不算改對。`,
      }));
    }
    if (res.answer) {
      box.append(h('div.cue', { text: '解答' }));
      box.append(h('div.rw-answer.fr', { lang: 'fr', text: res.answer }));
    }
  } else if (card.mode === 'choice') {
    // 選擇題沒有拼寫可比：imparfait 對 indicatif 逐字標紅只會標出一排無意義的紅字。
    if (res.answer) box.append(h('div.verdict-answer.fr', { lang: 'fr', text: res.answer }));
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
    box.append(h('p.verdict-yours', {}, card.mode === 'choice' ? '你選的：' : '你寫的：', h('span', { lang: 'fr', text: res.answered || '（空白）' })));
  }
  if (res.accept && res.accept.length > 1) {
    box.append(h('p.verdict-note', { lang: 'fr', text: `也接受：${res.accept.slice(1).join('、')}` }));
  }
  // 連接詞的功能分類（時間／對立讓步／條件…）只在作答之後給。
  // 放進題面等於先講一半答案——「對立讓步」那一組幾乎全接 subjonctif。
  // 作答完才出現，它是幫忙歸類記憶的線索，不是提示。
  if (card.kind === 'connector' && res.fn) {
    box.append(h('p.verdict-note', { text: `功能：${res.fn}` }));
  }

  if (res.note) box.append(h('p.verdict-note', { text: res.note }));

  box.append(h('div.verdict-sched', {},
    h('span', {}, '下次複習　', h('b', { text: relDays(res.state.intervalDays) })),
    h('span', {}, '記憶穩定度　', h('b', { text: `${res.state.stability.toFixed(1)} 天` })),
    h('span', {}, '累計答錯　', h('b', { text: String(res.state.lapses) })),
  ));

  if (res.reviewId && res.selfRated) {
    const ratings = h('div.ratings.correction-ratings', { role: 'group', 'aria-label': '更正剛才的評分' });
    const labels = card.kind === 'rw' ? RW_RATING_ZH : RATING_ZH;
    const maxRating = card.kind === 'rw' ? 3 : 4;
    for (let rating = 1; rating <= maxRating; rating += 1) {
      ratings.append(h('button', {
        type: 'button', dataset: { r: String(rating) }, disabled: rating === res.rating,
        onclick: () => correct(rating),
      }, h('b', { text: labels[rating] }), rating === res.rating ? h('small', { text: '目前' }) : null));
    }
    box.append(h('details.correction', {},
      h('summary', { text: res.corrected ? '評分已更正' : '剛才評分按錯了？' }),
      ratings,
    ));
  }

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
  if (state.preset === 'weak') {
    return h('div.card.empty', {},
      icon('check'),
      h('h2.landing', { tabindex: -1, text: state.done ? '弱點這一批做完了' : '目前沒有弱點卡' }),
      state.done ? h('p', { text: sessionLine(state) }) : h('p', { text: '這個範圍裡沒有答錯過的卡。' }),
      state.done ? followUps(state) : null,
      h('div.study-actions', {},
        h('button.btn.btn-primary', { text: '回統計', onclick: () => ctx.go('stats') }),
        ctx.guided ? h('button.btn', { text: '回今天', onclick: () => ctx.go('today') }) : null,
      ),
    );
  }
  const r = state.remaining;
  // 不設上限（newLimit 為 null）時額度永遠用不完，只剩「新卡學光了」這一種收工方式。
  const capHit = r && r.newLimit !== null && r.newToday >= r.newLimit;
  const noneLeft = r && r.remaining.new === 0;
  const nothingLeft = r && r.remaining.due === 0 && (capHit || noneLeft);
  // state.done 是這次進頁面以來的累計，不是最後一批——舊字樣「這一輪做完了，共 40 張」會被讀成一批 40 張。
  return h('div.card.empty', {},
    icon('check'),
    h('h2.landing', { tabindex: -1, text: state.done ? '沒有卡可以做了' : '現在沒有到期的卡' }),
    state.done ? h('p', { text: sessionLine(state) }) : null,
    h('p', {
      text: nothingLeft
        ? `${noneLeft ? '這個範圍裡的新卡也都學過了。' : '今天的新卡額度也用完了。'}休息比硬撐有效——FSRS 的排程已經替明天算好了。`
        : '還有卡可以練，按下面繼續。',
    }),
    h('div.study-actions', {},
      nothingLeft ? null : h('button.btn', { text: '再來一輪', onclick: reload }),
      h('button.btn', { text: '看統計', onclick: () => ctx.go('stats') }),
    ),
  );
}

function followUps(state) {
  const advice = {
    accent: '重做漏重音的字，逐字唸出重音位置。',
    wrong: '把拼錯的答案遮住，再完整寫一次。',
    empty: '挑兩張不會的卡，先認讀再回想。',
    family: '複習性數與詞形變化，再做一題同型題。',
    elision: '口頭說一次省音前後的完整片語。',
    missing: '圈出題目指定的連接詞與語氣，再改寫一次。',
    article: '把名詞連同冠詞一起寫兩次。',
    'vocab-recall': '先看法文說出中文，再確認答案。',
    'vocab-produce': '先看中文完整拼出法文，再核對重音。',
    conj: '把同一動詞的人稱變化口頭跑一輪。',
  };
  const picked = [...state.focus].sort((a, b) => b[1] - a[1]).slice(0, 2)
    .map(([key]) => advice[key]).filter(Boolean);
  while (picked.length < 2) picked.push(picked.length ? '明天先做今天仍答錯的卡。' : '挑一張最卡的題，說出錯因後再答一次。');
  return h('div.session-followup', {}, h('strong', { text: '接下來兩件事' }), h('ol', {}, ...picked.map((text) => h('li', { text }))));
}

/**
 * 到期卡清完後停一次。主按鈕是離開：到期的做完就是今天的份量，
 * 繼續學新卡是加練，所以放次要——學得越多，之後每天要複習的也越多。
 */
function checkpoint(state, ctx, keepGoing) {
  return h('div.card.empty', {},
    icon('check'),
    h('h2.landing', { tabindex: -1, text: '今天到期的卡都清完了' }),
    h('p', { text: `${sessionLine(state)}今天新學 ${state.remaining.newToday} 張。` }),
    h('p', { text: '今天的份量到這裡就夠了。還想練可以繼續學新卡，只是學得越多，之後每天要複習的也越多。' }),
    h('div.study-actions', {},
      h('button.btn.btn-primary', { text: '回今天', onclick: () => ctx.go('today') }),
      h('button.btn', { text: '繼續學新卡', onclick: keepGoing }),
    ),
  );
}

/** 單張卡計入本次作答時間的上限（毫秒），與 api.mjs 統計中位數的過濾上限相同。 */
const SESSION_MS_CAP = 120_000;

function sessionLine(state) {
  const min = Math.round(state.ms / 60_000);
  const time = min < 1 ? '作答時間不到 1 分鐘' : `作答時間共 ${min} 分鐘`;
  const again = state.again ? `其中 ${state.again} 張要重來` : '沒有要重來的';
  return `這次做了 ${state.done} 張，${again}，${time}。`;
}

// 一天只停一次，重新整理頁面也算數，所以記在 localStorage 而不是 state。
// 讀寫丟例外（隱私模式、封鎖網站資料）時當作沒停過：多停一次無害。
const ENOUGH_KEY = 'cadence.enoughShown';
const localDay = () => new Date().toLocaleDateString('sv');

function enoughShownToday() {
  try { return localStorage.getItem(ENOUGH_KEY) === localDay(); } catch { return false; }
}

function markEnoughShown() {
  try { localStorage.setItem(ENOUGH_KEY, localDay()); } catch { /* 見上 */ }
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
