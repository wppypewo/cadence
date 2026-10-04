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
 *  - 出卡時進專注模式：導覽整條收起來，畫面上只剩這張卡。Esc 離開，不記任何東西。
 *
 * 版面分兩層：外框（進度條、離開、計數、範圍）只建一次，換卡只重畫中間的 stage。
 * 外框不重建，進度條才有前一個寬度可以補間，範圍選單的 popover 也不會每張卡生一個。
 */

import { h, icon, clear, announce, relDays } from './dom.mjs';
import { api } from './net.mjs';
import { diffChars, missingAccents } from './shared/grade.mjs';
import * as motion from './motion.mjs';
import { KIND_ZH } from './kinds.mjs';

const ACCENTS = ['é', 'è', 'ê', 'ë', 'à', 'â', 'î', 'ï', 'ô', 'ù', 'û', 'ü', 'ç', 'œ', 'æ'];

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
  cadence: '中文釋義為 cadence 逐筆整理',
};

// 題庫存 m／f／mf（src/build/bank.mjs），前端印中文。
// mf 多半是 artiste、adulte 這類同形兩性的字，也有 après-midi、automne 這類兩種性別都有人用的字，
// 所以寫「皆可」不寫「同形」。
const GENDER_ZH = { m: '陽性', f: '陰性', mf: '陽性陰性皆可' };

/**
 * 卡背的例句（lexicon/examples.json，取自 Tatoeba，CC BY 2.0 FR）。
 * 授權要求署名，所以每句都帶作者與原句連結。
 * hit 是句中實際出現的詞形；2026-09-26 實測 16,485 句裡有 455 句只差大小寫（句首），
 * 找不到時退回不分大小寫，再找不到就整句不標。
 */
function examplesBlock(examples) {
  if (!examples?.length) return null;
  const list = h('ul.examples', { 'aria-label': '例句' });
  for (const ex of examples) {
    let at = ex.fr.indexOf(ex.hit);
    if (at < 0) at = ex.fr.toLowerCase().indexOf(ex.hit.toLowerCase());
    const fr = h('p.example-fr.fr', { lang: 'fr' });
    if (at < 0 || !ex.hit) fr.append(ex.fr);
    else fr.append(ex.fr.slice(0, at), h('b.example-hit', { text: ex.fr.slice(at, at + ex.hit.length) }), ex.fr.slice(at + ex.hit.length));
    const credit = h('p.example-credit', {},
      h('a', {
        href: `https://tatoeba.org/sentences/show/${ex.id}`, target: '_blank', rel: 'noopener noreferrer',
        text: `Tatoeba #${ex.id}`,
      }),
      `・${ex.by}`,
    );
    list.append(h('li.example', {}, fr, ex.zh ? h('p.example-zh', { text: ex.zh }) : null, credit));
  }
  return list;
}

const fmt = new Intl.NumberFormat('zh-Hant');

export function reviewView(root, ctx) {
  const preset = ctx.takeReviewPreset();
  const state = {
    cards: [],
    idx: 0,
    // 這次進頁面以來的累計，給停頓頁與完成畫面的摘要用。ms 只算作答時間，不含看批改。
    done: 0,
    again: 0,
    ms: 0,
    // 各評分的張數，index 即 FSRS 的 1..4。摘要頁的比例條用；更正評分時兩邊各調一格。
    byRating: [0, 0, 0, 0, 0],
    startedAt: 0,
    // 改寫題第一趟的結果：要素齊全、正在等自評。這時還沒寫進紀錄。
    selfPhase: null,
    verdict: null,
    // 批改結果只在第一次畫出來時播動畫；更正評分會重畫同一份結果，那時再播一次像是又答了一題。
    fresh: false,
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
    // 換卡動畫進行中。這段時間畫面上是舊卡正在滑走，按鍵一律不收。
    sliding: false,
    focusOn: false,
    // 自評卡評分後不停在批改畫面，直接換下一張；這兩欄留給 toast 上的「改評分」。
    // last 是最近一次自評的 { card, verdict }，只有它能被叫回來改——
    // 之後又答了別張，那則提示就收掉，免得改到一張已經不在眼前的卡。
    // amend 是叫回來正在改的那張卡，畫面暫時蓋過佇列目前那張。
    last: null,
    amend: null,
  };
  let dismissAmend = null;

  // ---- 外框 ----
  const bar = h('i');
  const progressEl = h('div.focus-progress', {
    role: 'progressbar', 'aria-label': '這一批的進度', 'aria-valuemin': 0,
  }, bar);
  const countEl = h('p.focus-count.num');
  const remainEl = h('span.remain');
  // 範圍選單只在一般複習給。弱點批次是一組固定的卡，換範圍會整頁重抓，preset 就丟了。
  const scopeBtn = state.preset ? null : ctx.scopeMenu();
  // toast 上的「改評分」十秒就收，報讀器使用者也不一定找得到它。這顆常駐在上方，
  // 有效期跟 state.last 一樣：直到答下一張為止，不看時間。
  // 放在「離開」旁邊不放右邊工具列：375px 手機上右邊那列已經是剩餘數＋範圍鈕，再塞一顆實測溢出 48px。
  const amendBtn = h('button.btn.btn-quiet.btn-sm.focus-amend', {
    type: 'button', hidden: true, 'aria-keyshortcuts': 'Z',
    onclick: () => { if (state.last) amend(state.last); },
  }, '改上一張', h('kbd', { text: 'Z', 'aria-hidden': 'true' }));
  const tools = h('div.focus-tools', {}, remainEl, scopeBtn);
  const leave = h('button.btn.btn-quiet.btn-sm.focus-leave', {
    type: 'button', 'aria-keyshortcuts': 'Escape', onclick: () => ctx.go('today'),
  }, '離開', h('kbd', { text: 'Esc', 'aria-hidden': 'true' }));
  const stage = h('div.stage');
  const frame = h('div.focus', { dataset: { mode: 'card' } },
    progressEl,
    h('div.focus-top', {}, h('div.focus-start', {}, leave, amendBtn), countEl, tools),
    stage,
  );
  root.append(frame);

  function focusMode(on) {
    if (state.focusOn === on) return;
    state.focusOn = on;
    ctx.setFocus(on);
  }

  function updateTop() {
    const total = state.cards.length;
    // 分母是這一批的張數（`api.queue` 的 limit，目前 20），不是今天要做的總數——
    // 做完這批 `load()` 會再抓一批。光寫「1 / 20」會被讀成「今天做完 20 張就收工」，
    // 但今天到期 9 張加上新卡額度 15 張其實是 24 張。所以前面明寫「這批」，
    // 今天還剩多少交給右邊那行講。
    countEl.textContent = total && !state.loading ? `這批 ${Math.min(state.idx + 1, total)} / ${total}` : '';
    progressEl.setAttribute('aria-valuenow', String(state.idx));
    progressEl.setAttribute('aria-valuemax', String(total));
    motion.progress(bar, total ? state.idx / total : 0);
    if (state.remaining) remainEl.textContent = remainText(state.remaining);
    // 範圍鈕在空狀態時會被借去放在畫面中間，回到出卡時放回右上角。
    if (scopeBtn && scopeBtn.parentNode !== tools) tools.append(scopeBtn);
  }

  async function load() {
    state.loading = true;
    state.error = null;
    render();
    try {
      const data = await api.queue({ ...ctx.scopeQuery(), limit: 20, preset: state.preset });
      state.cards = data.cards;
      state.remaining = data;
      state.idx = 0;
      // 抓下一批時使用者可能正在改上一張的評分，那份批改結果不能被清掉。
      if (!state.amend) state.verdict = null;
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
    if (!card || !state.study?.data || state.sliding) return;
    state.previewed.add(card.id);
    state.study = null;
    const [moved] = state.cards.splice(state.idx, 1);
    state.cards.splice(Math.min(state.idx + PREVIEW_GAP, state.cards.length), 0, moved);
    slide();
    announce('這張稍後再考');
  }

  function keepGoing() {
    state.checkpoint = false;
    state.startedAt = performance.now();
    render();
  }

  function current() {
    return state.amend ?? state.cards[state.idx] ?? null;
  }

  /** 換卡動畫。計時從新卡真的出現才開始，滑動那半秒不算作答時間。 */
  function slide() {
    state.sliding = true;
    motion.slideCard(stage, () => {
      state.sliding = false;
      state.startedAt = performance.now();
      render();
    });
  }

  function next() {
    if (state.sliding) return;
    state.verdict = null;
    state.selfPhase = null;
    if (state.amend) {
      // 改完評分回到原本排著的那張，idx 在自動前進時已經加過了。
      state.amend = null;
      if (state.loading || !current()) render();
      else slide();
      return;
    }
    state.idx += 1;
    state.startedAt = performance.now();
    if (state.idx >= state.cards.length) {
      if (state.preset) render();
      else load();
    }
    else slide();
  }

  /**
   * 自評後的提示。按鈕叫「改評分」不叫「撤銷」：紀錄只增不改，按下去不會讓這次作答消失，
   * 只是追加一筆更正事件，跟批改畫面裡「評分按錯了？」走同一條路。
   */
  function offerAmend(card, verdict) {
    const entry = { card, verdict };
    state.last = entry;
    syncAmend();
    const labels = card.kind === 'rw' ? RW_RATING_ZH : RATING_ZH;
    dismissAmend = ctx.toast(`記為「${labels[verdict.rating]}」，下次 ${relDays(verdict.state.intervalDays)}`, 'info', {
      label: '改評分',
      run: () => amend(entry),
    });
  }

  function amend(entry) {
    // 從上方那顆或 Z 叫回來時 toast 還掛著，一起收掉，不然它的按鈕會指向一個已經在改的評分。
    dismissAmend?.();
    dismissAmend = null;
    // 離開頁面、或之後又答了別張，這則提示就不再對應眼前任何一張卡。
    if (state.last !== entry || !stage.isConnected || state.pending) return;
    state.last = null;
    state.amend = entry.card;
    state.verdict = entry.verdict;
    state.fresh = false;
    syncAmend();
    // 換卡動畫還在跑時不能重畫：killWithin 會把動畫連同收尾的 render 一起砍掉，sliding 就再也不會歸零。
    // 動畫跑完自己會 render，那時 amend 已經設好。
    if (!state.sliding) render();
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
      state.byRating[old.rating] -= 1;
      state.byRating[rating] += 1;
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
      const verdict = { ...res, answered: answer };
      // 新的作答一進來，上一張的「改評分」就過期了。
      dismissAmend?.();
      dismissAmend = null;
      state.last = null;
      state.done += 1;
      state.byRating[res.rating] += 1;
      if (res.rating === 1) state.again += 1;
      if (res.rating === 1) {
        const key = res.grade?.reason ?? card.kind;
        state.focus.set(key, (state.focus.get(key) ?? 0) + 1);
      }
      // 加總時單張封頂，送給伺服器的仍是原始 ms。卡片開著人走開，計時會一直跑：
      // 實測有一張 pick 記到 25 分鐘，一張就能把「作答時間共 n 分鐘」灌大好幾倍。
      // 上限跟進度頁取中位數時的 120 秒一致。
      state.ms += Math.min(ms, SESSION_MS_CAP);
      announce(verdictText(card, res, answer));
      if (res.selfRated) {
        // 自評卡翻面時已經看過釋義、例句和每顆鍵會排到哪天，分數也是自己給的，
        // 再停一頁批改結果只是多按一次 Enter。按錯的出口留在 toast 上。
        offerAmend(card, verdict);
        next();
      } else {
        state.verdict = verdict;
        state.fresh = true;
        render();
      }
      // 右上角那行「待複習 n・新卡 x/y」是作答後才會變的，隨佇列一起抓的那份已經過期。
      // 導覽的數字問的是同一支端點，借它回來的結果就地補上，不另外再打一次請求。
      // 只改文字不重畫，避免在使用者正要按「下一張」時把焦點搶走。
      ctx.refreshBadge().then((fresh) => {
        if (!fresh) return;
        state.remaining = fresh;
        remainEl.textContent = remainText(fresh);
      });
    } catch (err) {
      ctx.toast(err.message, 'bad');
    } finally {
      state.pending = false;
    }
  }

  /** 「改上一張」只在出卡畫面露出；停頓頁、完成頁的上方列是藏起來的，按鍵也不該在那裡生效。 */
  function syncAmend() {
    amendBtn.hidden = !state.last || Boolean(state.amend) || frame.dataset.mode !== 'card';
  }

  function render() {
    draw();
    syncAmend();
  }

  function draw() {
    motion.killWithin(stage);
    clear(stage);
    if (state.amend) {
      frame.dataset.mode = 'card';
      focusMode(true);
      // 進度數字這時指的是排在後面的那張；跨批叫回來時甚至是下一批的第 1 張，照印會對不上眼前這張。
      countEl.textContent = '改上一張的評分';
      const box = face(state.amend, state, submit);
      box.append(verdictPanel(state.amend, state.verdict, next, correct, false, true));
      stage.append(box);
      return;
    }
    if (state.loading) {
      frame.dataset.mode = 'card';
      focusMode(true);
      updateTop();
      stage.append(skeleton());
      return;
    }
    if (state.error) {
      frame.dataset.mode = 'end';
      focusMode(false);
      stage.append(h('div.errorbox', {},
        icon('alert'),
        h('p', { text: `讀不到題目：${state.error}` }),
        h('button.btn', { type: 'button', onclick: load, text: '再試一次' }),
      ));
      return;
    }
    if (state.checkpoint) {
      frame.dataset.mode = 'end';
      focusMode(true);
      stage.append(checkpoint(state, ctx, keepGoing));
      stage.querySelector('.landing')?.focus();
      return;
    }
    const card = current();
    if (!card) {
      frame.dataset.mode = 'end';
      // 一張都沒做就沒有東西要專注，導覽放回來，讓人直接去別頁。
      focusMode(state.done > 0);
      stage.append(state.done
        ? summary(state, ctx, load)
        : emptyScreen(state, ctx, state.done ? null : scopeBtn));
      // 上一張的「下一張」鈕已經被清掉，不接住的話焦點掉回 body，報讀器也不會念出做完了。
      stage.querySelector('.landing')?.focus();
      return;
    }
    frame.dataset.mode = 'card';
    focusMode(true);
    updateTop();
    if (needsPreview(card, state)) {
      if (state.study?.id !== card.id) loadPreview(card);
      stage.append(studyFace(card, state.study, seenPreview));
      focusInput(stage);
      return;
    }
    const box = face(card, state, submit);
    if (state.verdict) {
      box.append(verdictPanel(card, state.verdict, next, correct, state.fresh));
      state.fresh = false;
    }
    stage.append(box);
    focusInput(stage);
  }

  // 鍵盤：捕捉在 document 上，因為批改後焦點在按鈕上也要能按 1–4。
  function onKey(ev) {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    // 按住不放的自動重複一律不算：按住 Enter 會一路「下一張」，批改結果連看都沒看到。
    if (ev.repeat) return;
    if (ev.key === 'Escape') return void leaveKey(ev);
    if (state.sliding) return;
    if (state.amend) {
      const t = ev.target;
      // 焦點在更正評分的按鈕或摘要上時，Enter／Space 是按那顆，不是離開。
      if (t?.closest?.('.correction button, .correction summary')) return;
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); next(); }
      return;
    }
    // 停頓頁底下的下一批已經抓好，current() 會回傳一張畫面上看不到的卡，
    // 不擋的話按 Space、3 會替那張沒看過的卡評分。
    if (state.checkpoint) return;
    // 設定對話框開著、或焦點在輸入框裡時，按鍵是打給那裡的——
    // 在設定裡打「3」不該順手替這張卡評分。作答框自己的 Enter 由它自己的 keydown 處理。
    const t = ev.target;
    if (t?.closest?.('dialog[open]') || t?.matches?.('input, textarea, select, [contenteditable="true"]')) return;
    // 打字題的焦點在輸入框裡，上一行已經擋掉，Z 在那裡就是打字；要改評分得 Shift+Tab 到上方那顆。
    if (ev.key.toLowerCase() === 'z' && !amendBtn.hidden) { ev.preventDefault(); amend(state.last); return; }
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
      if (ev.key === ' ') { ev.preventDefault(); revealSelf(stage); return; }
      if (['1', '2', '3', '4'].includes(ev.key) && isRevealed(stage)) {
        ev.preventDefault();
        submit({ rating: Number(ev.key) });
      }
    }
  }

  /**
   * Esc 離開專注模式回今天。作答框裡也收：打到一半想走，不必先把焦點移出來。
   * 離開不送任何東西，這張卡照樣到期，所以誤按的代價只是重新進來一次。
   * 對話框、選單、輸入法選字時的 Esc 是在關那些東西，不能順手把整頁換掉。
   */
  function leaveKey(ev) {
    if (!state.focusOn || ev.isComposing || ev.keyCode === 229) return;
    if (document.querySelector('dialog[open]')) return;
    try { if (document.querySelector(':popover-open')) return; } catch { /* 舊瀏覽器不認得這個選擇器，當作沒開 */ }
    ev.preventDefault();
    ctx.go('today');
  }

  document.addEventListener('keydown', onKey);

  load();
  return () => {
    document.removeEventListener('keydown', onKey);
    dismissAmend?.();
    motion.killWithin(frame);
  };
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

/** 卡片最上面那一行小字：題型・等級・第幾次。 */
function kindLine(...parts) {
  return h('p.card-kind', {}, ...parts.filter(Boolean).map((text) => h('span', { text })));
}

function studyFace(card, study, seen) {
  const f = card.front ?? {};
  const box = h('div.focus-card');
  box.append(kindLine(KIND_ZH[card.kind] ?? card.kind, '新卡・先看解答'));
  box.append(prompt(card, f));

  const panel = h('div.study-answer');
  const d = study?.data;
  if (!d) {
    panel.append(h('p.verdict-note', { text: '讀取解答中…' }));
  } else {
    panel.append(h('p.cue', { text: '解答' }));
    panel.append(h(card.kind === 'rw' ? 'p.rw-answer.fr' : 'p.verdict-answer.fr', { lang: 'fr', text: d.answer ?? '' }));
    if (d.note) panel.append(h('p.verdict-note', { text: d.note }));
    panel.append(h('p.verdict-note', { text: '這次不計分，隔幾張後再考。' }));
  }
  box.append(panel);
  box.append(h('div.focus-actions', {},
    h('button.btn.btn-primary.answer-target', {
      type: 'button', onclick: seen, disabled: !d, 'aria-keyshortcuts': 'Enter',
    }, '看過了', h('kbd', { text: 'Enter', 'aria-hidden': 'true' })),
  ));
  return box;
}

function remainText(r) {
  // newLimit 為 null 是不設上限，寫成「3/null」或「3/∞」都不如直接說今天學了幾張。
  if (r.newLimit === null) return `待複習 ${r.remaining.due}・今天新學 ${r.newToday}`;
  return `待複習 ${r.remaining.due}・新卡 ${r.newToday}/${r.newLimit}`;
}

function face(card, state, submit) {
  const f = card.front ?? {};
  const box = h('div.focus-card');
  const v = state.verdict;

  box.append(kindLine(
    KIND_ZH[card.kind] ?? card.kind,
    f.level,
    card.state ? `第 ${card.state.reps + 1} 次` : '新卡',
    f.noisy ? '釋義可能不精確' : null,
  ));

  box.append(prompt(card, f));

  // 批改之後作答區不再畫：打字題的答案由比對行重印一次（錯字標在正確答案上），
  // 留一個停用的輸入框只是同一個字串出現兩遍。選擇題例外，標好對錯的選項本身就是批改。
  if (card.mode === 'typed') { if (!v) box.append(typedAnswer(submit)); }
  else if (card.mode === 'rewrite') box.append(rewriteAnswer(state, submit));
  else if (card.mode === 'choice') box.append(choiceAnswer(card, state, submit));
  else if (!v) box.append(selfAnswer(card, submit));

  return box;
}

/** 題目本體。四種卡的問法不同，這裡把差異集中在一個地方。 */
function prompt(card, f) {
  const p = h('div.prompt');
  if (card.kind === 'conj') {
    p.append(h('p.cue', { text: `${f.tenseZh}・填入變位` }));
    p.append(h('p.conj-line.fr', { lang: 'fr' },
      h('span', { text: f.pronoun }),
      h('span.blank'),
    ));
    p.append(h('p.prompt-en', { text: `${f.verb}　${f.gloss ?? ''}`.trim() }));
    if (f.note) p.append(h('p.prompt-note', { text: f.note }));
  } else if (card.kind === 'pick') {
    p.append(h('p.cue', { text: '選一個填進空格・注意省音與性數' }));
    // 方框照印。這一大題考的就是「在六個裡認出哪一個」，
    // 把選項藏起來等於換了一種題目。
    const boxEl = h('div.pick-box', { role: 'group', 'aria-label': '可選的連接詞' });
    for (const opt of f.options ?? []) boxEl.append(h('span.fr', { lang: 'fr', text: opt }));
    p.append(boxEl);
    p.append(h('p.pick-sentence.fr', { lang: 'fr', text: f.prompt }));
    if (f.src) p.append(h('p.prompt-note', { text: f.src }));
  } else if (card.kind === 'rw') {
    p.append(h('p.cue', { text: '用指定的連接詞改寫整句' }));
    // 指定工具比題幹還重要：整題就是「非得用這個字不可」。
    if (f.tool) p.append(h('p.rw-tool.fr', { lang: 'fr', text: f.tool }));
    // 考卷第 III 大題給的是法文原句，擴充題庫給的是中文——標錯 lang 會讓朗讀器念錯語言。
    const fr = f.sec === 'III';
    p.append(h(fr ? 'p.rw-source.fr' : 'p.rw-source', fr ? { lang: 'fr', text: f.prompt } : { text: f.prompt }));
    if (f.src) p.append(h('p.prompt-note', { text: f.src }));
  } else if (card.kind === 'nom') {
    p.append(h('p.cue', { text: '寫成名詞組，連冠詞' }));
    p.append(h('p.prompt-word.fr', { lang: 'fr', text: f.base }));
    // 中文釋義一定要印：規則推出來的配對不保證語意貼合，釋義擺在眼前才看得出配對有沒有問題。
    p.append(h('p.prompt-zh', { text: f.gloss || '（題庫沒有中文釋義）' }));
    // 這裡不印性別——那正是要考的東西。
    p.append(h('p.prompt-note', { text: [f.posZh, f.src].filter(Boolean).join('・') }));
  } else if (card.kind === 'connector') {
    p.append(h('p.cue', { text: '後面接什麼語氣？' }));
    p.append(h('p.prompt-word.fr', { lang: 'fr', text: f.connector }));
    if (f.zh) p.append(h('p.prompt-en', { text: f.zh }));
  } else if (card.kind === 'vocab-produce') {
    p.append(h('p.cue', { text: '法文怎麼寫？' }));
    p.append(h('p.prompt-zh.prompt-lead', { text: f.gloss || f.en || '（沒有釋義）' }));
    if (f.en && f.gloss) p.append(h('p.prompt-en', { lang: 'en', text: f.en }));
    p.append(h('p.prompt-note', { text: [f.posZh, GENDER_ZH[f.gender]].filter(Boolean).join('・') }));
  } else {
    p.append(h('p.cue', { text: '什麼意思？' }));
    p.append(h('p.prompt-word.fr', { lang: 'fr', text: f.word }));
    p.append(h('p.prompt-note', { text: [f.posZh, GENDER_ZH[f.gender], f.level].filter(Boolean).join('・') }));
  }
  return p;
}

function typedAnswer(submit) {
  const input = h('input.answer-input.answer-target', {
    type: 'text', lang: 'fr', autocomplete: 'off', autocapitalize: 'off',
    spellcheck: false, placeholder: '打出法文，重音要對',
    'aria-label': '作答',
  });

  const form = h('form.answer-form', {
    onsubmit: (ev) => { ev.preventDefault(); submit({ answer: input.value }); },
  }, input);

  // Enter 明寫成 keydown，不靠表單的隱式送出。隱式送出交給瀏覽器自己判斷按鍵，
  // 實測自動化工具送進來的 Enter（key 是 Enter、keyCode 卻是 0）就不會觸發；
  // 真人打字兩條路都通，但只有明寫的這條測得到。
  // isComposing／keyCode 229 是給輸入法的——選字階段的 Enter 是在確認候選字，不是要交卷。
  input.addEventListener('keydown', (ev) => answerKey(ev, input, submit));

  form.append(accentBar(input));
  form.append(answerActions(submit));
  return form;
}

/**
 * 作答框的 Enter。Shift+Enter 等於「不會，直接看」：手已經在鍵盤上，
 * 為了放棄一題去摸滑鼠是這頁最貴的動作。不用 Esc，是因為 Esc 常被順手按來關東西，
 * 誤觸就是一筆「忘了」寫進只增不改的紀錄。（Esc 現在是「離開」，不記任何東西。）
 */
function answerKey(ev, input, submit) {
  if (ev.key !== 'Enter' || ev.isComposing || ev.keyCode === 229) return;
  ev.preventDefault();
  if (ev.repeat) return;
  submit({ answer: ev.shiftKey ? '' : input.value });
}

/** 按鍵提示直接寫在按鈕上，不另外排一行說明：看得到按鈕的地方就看得到快捷鍵。 */
function answerActions(submit) {
  return h('div.focus-actions', {},
    h('button.btn', { type: 'submit', 'aria-keyshortcuts': 'Enter' },
      '對答案', h('kbd', { text: 'Enter', 'aria-hidden': 'true' })),
    h('button.btn.btn-quiet', {
      type: 'button', 'aria-keyshortcuts': 'Shift+Enter',
      onclick: () => submit({ answer: '' }),
    }, '不會', h('kbd', { text: 'Shift Enter', 'aria-hidden': 'true' })),
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
  const keys = ACCENTS.map((ch, i) => h('button.fr', {
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
function rewriteAnswer(state, submit) {
  // 記分之後「你寫的」由批改面板印，這裡不重複。
  if (state.verdict) return null;
  const self = state.selfPhase;
  if (self) {
    // 自評時要拿自己的句子跟解答對照，所以印成可讀的文字，不是一個停用的輸入框。
    return h('div.rw-phase', {},
      h('div.rw-yours', {},
        h('p.cue', { text: '你寫的' }),
        h('p.fr', { lang: 'fr', text: self.answered || '（空白）' }),
      ),
      rwSelfRating(self, submit),
    );
  }
  const input = h('textarea.answer-input.answer-area.answer-target', {
    lang: 'fr', autocomplete: 'off', autocapitalize: 'off', spellcheck: false,
    rows: '3', placeholder: '把整句寫出來，重音要對',
    'aria-label': '改寫後的句子',
  });

  const form = h('form.answer-form', {
    onsubmit: (ev) => { ev.preventDefault(); submit({ answer: input.value }); },
  }, input);

  // 換行對一個句子沒有用處，Enter 直接送出，跟其他題型一致。
  input.addEventListener('keydown', (ev) => answerKey(ev, input, submit));

  form.append(accentBar(input));
  form.append(answerActions(submit));
  return form;
}

/** 評分鈕。數字鍵放角落，跟選擇題的選項同一套：主體是字，數字只是告訴你按哪個鍵。 */
function rateButton(r, label, onclick, extra = null) {
  return h('button.rate', { type: 'button', dataset: { r: String(r) }, 'aria-keyshortcuts': String(r), onclick },
    h('kbd', { text: String(r), 'aria-hidden': 'true' }),
    h('b', { text: label }),
    extra,
  );
}

/** 要素齊全之後的自評：整句沒有唯一解，只有自己看得出差在哪。 */
function rwSelfRating(self, submit) {
  const box = h('div.verdict.rw-self', { dataset: { tone: 'ok' } });
  box.append(h('p.verdict-head', {}, icon('check'), h('span', {
    text: self.grade.accent?.length ? '要素齊全，但有字漏了重音' : '指定的連接詞與語氣都對了',
  })));
  if (self.grade.accent?.length) {
    box.append(h('p.verdict-note', {
      text: `漏重音的是：${self.grade.accent.map((alts) => alts[0]).join('、')}`,
    }));
  }
  box.append(h('p.cue', { text: '解答' }));
  box.append(h('p.rw-answer.fr', { lang: 'fr', text: self.answer ?? '' }));
  if (self.note) box.append(h('p.verdict-note', { text: self.note }));
  if (self.src) box.append(h('p.verdict-note', { text: self.src }));

  box.append(h('p.cue', { text: '整句跟解答比' }));
  const rate = h('div.ratings', { dataset: { n: '3' }, role: 'group', 'aria-label': '整句跟解答比' });
  for (let r = 1; r <= 3; r += 1) {
    rate.append(rateButton(r, RW_RATING_ZH[r], () => submit({ answer: self.answered, rating: r })));
  }
  box.append(rate);
  queueMicrotask(() => rate.querySelector('button')?.focus());
  return box;
}

function choiceAnswer(card, state, submit) {
  // 群組本身是焦點落點（tabindex -1）：上一張的「下一張」鈕被清掉後焦點要有地方接，
  // 又不能直接落在第一個選項上——那樣一按 Enter 就替使用者選了第一個。
  const box = h('div.choices.answer-target.landing', { role: 'group', 'aria-label': '選一個答案', tabindex: -1 });
  const picked = state.verdict?.answered ?? null;
  const opts = card.front?.options ?? [];
  // 選項數寫在 data-n，給 CSS 排欄數用（六個排成 3+3，不讓 auto-fit 排成 4+2）。
  box.dataset.n = String(opts.length);
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
    }, key ? h('kbd', { text: key, 'aria-hidden': 'true' }) : null, h('span.fr', { lang: 'fr', text: opt }));
    btn.addEventListener('click', () => submit({ answer: opt }));
    // 中文放在法文底下，不取代它：考卷上印的是 subjonctif，
    // 只認得「虛擬式」的人到了考場一樣認不出來。
    if (zh[opt]) btn.append(h('small', { text: zh[opt] }));
    box.append(btn);
  });
  return box;
}

/**
 * 自評題（看字回想意思）。先翻面看答案，再誠實給分。
 * 不做自動批改是因為「這個字的意思」沒有唯一字串答案，
 * 硬要比對只會製造假錯誤。
 */
function selfAnswer(card, submit) {
  const box = h('div.self-answer');
  const back = h('div.self-back', { hidden: true });
  const err = h('p.field-error', { hidden: true });

  // answer-target：新卡出來時焦點落在這顆上，Enter 與 Space 都能翻面。
  const reveal = h('button.btn.btn-primary.reveal-btn.answer-target', {
    type: 'button', 'aria-keyshortcuts': 'Space',
    onclick: async () => {
      reveal.disabled = true;
      try {
        const answer = await api.reveal(card.id);
        back.append(h('p.prompt-zh.prompt-lead', { text: answer.gloss || '（題庫沒有中文釋義）' }));
        if (answer.en) back.append(h('p.prompt-en', {
          lang: 'en', text: Array.isArray(answer.en) ? answer.en.join('；') : answer.en,
        }));
        if (GLOSS_SOURCE_ZH[answer.glossSource]) back.append(h('p.prompt-note', { text: GLOSS_SOURCE_ZH[answer.glossSource] }));
        const ex = examplesBlock(answer.examples);
        if (ex) back.append(ex);
        // 每顆評分鍵寫上它會把這張卡排到哪一天。「想起來了」與「太簡單」差三天還是三十天，
        // 看不到就很難誠實地分。舊伺服器沒有這個欄位時留白。
        rate.querySelectorAll('.iv').forEach((node, i) => {
          node.textContent = answer.intervals?.[i] ? relDays(answer.intervals[i]) : '';
        });
        back.hidden = false;
        reveal.hidden = true;
        rate.hidden = false;
        motion.rise([back, rate], { y: 8, stagger: 0.08, duration: 0.35 });
        // 焦點落在群組上，不落在第一顆「忘了」：翻面之後順手再按一次 Enter，
        // 落在按鈕上就是一筆「忘了」寫進只增不改的紀錄。
        rate.focus();
      } catch (e) {
        err.textContent = `讀不到答案：${e.message}`;
        err.hidden = false;
        reveal.disabled = false;
      }
    },
  }, '看答案', h('kbd', { text: 'Space', 'aria-hidden': 'true' }));

  const rate = h('div.ratings.landing', { hidden: true, role: 'group', 'aria-label': '這張卡剛才回想得如何，按 1 到 4 給分', tabindex: -1 });
  for (let r = 1; r <= 4; r += 1) {
    rate.append(rateButton(r, RATING_ZH[r], () => submit({ rating: r }), h('small.iv')));
  }

  box.append(back, h('div.focus-actions', {}, reveal), err, rate);
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

/**
 * 批改結果。三種語氣對應三種語意，顏色只是輔助——
 * 標題永遠有文字說明，不靠顏色傳達資訊。
 * animate 只在剛作答完為真；更正評分後的重畫不再播一次。
 */
function verdictPanel(card, res, next, correct, animate, amending = false) {
  const t = tone(res);
  const box = h('div.verdict', { dataset: { tone: t }, tabindex: -1 });
  let letters = [];

  box.append(h('p.verdict-head', {},
    icon(t === 'ok' ? 'check' : t === 'near' ? 'alert' : 'cross'),
    h('span', { text: headText(card, res) }),
  ));

  // 改寫題不做逐字比對：整句有好幾種寫法都對，拿解答當骨架比一遍會整片標紅。
  if (card.mode === 'self') {
    if (res.answer) box.append(h('p.prompt-zh.prompt-lead', { text: res.answer }));
    if (res.en?.length) box.append(h('p.prompt-en', {
      lang: 'en', text: Array.isArray(res.en) ? res.en.join('；') : res.en,
    }));
    if (GLOSS_SOURCE_ZH[res.glossSource]) box.append(h('p.verdict-note', { text: GLOSS_SOURCE_ZH[res.glossSource] }));
  } else if (card.kind === 'rw') {
    if (res.grade?.miss?.length) {
      box.append(h('p.verdict-note', {
        text: `少了：${res.grade.miss.map((alts) => alts.join('／')).join('、')}。連接詞和它要求的語氣少一個就不算對。`,
      }));
    }
    if (res.answer) {
      box.append(h('p.cue', { text: '解答' }));
      box.append(h('p.rw-answer.fr', { lang: 'fr', text: res.answer }));
    }
  } else if (card.mode === 'choice') {
    // 選擇題沒有拼寫可比：imparfait 對 indicatif 逐字標紅只會標出一排無意義的紅字。
    // 正確答案已經標在選項上，這裡不再印一次。
  } else if (res.answer) {
    // 逐字比對：以正確答案為骨架，把使用者沒打對的字元標出來。
    // 對齊用編輯距離（src/engine/grade.mjs），漏一個字母不會讓後面整排錯位變紅。
    const line = h('p.diff.fr', { lang: 'fr' });
    for (const { ch, ok } of diffChars(res.answered ?? '', res.answer)) {
      const span = h('span', { class: ok ? null : 'bad', text: ch });
      line.append(span);
      letters.push(span);
    }
    if (t === 'ok') line.classList.add('all-ok');
    box.append(line);
  }

  if (res.grade && res.grade.reason === 'article') {
    box.append(h('p.verdict-note', {
      text: '名詞對了，錯在冠詞。考卷上 le／la 寫錯一樣不給分。',
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
        ? `字母全對，漏的是 ${missed.join('、')}。這在 cadence 裡算錯，考卷上也是。`
        : '字母全對，差在變音符號。',
    }));
  }

  // 選擇題選了哪個已經標在選項上。打字題寫錯時把自己寫的劃掉：對照上面那行正確答案，
  // 一眼看出差在哪；大小寫不同這種算對的就不劃，劃掉會讀成「錯了」。
  if (card.mode !== 'choice' && res.answered && res.grade && (card.kind === 'rw' || res.grade.reason !== 'exact')) {
    const struck = card.kind !== 'rw' && t !== 'ok';
    box.append(h('p.verdict-yours', {}, '你寫的　',
      h(struck ? 's.fr' : 'span.fr', { lang: 'fr', text: res.answered || '（空白）' })));
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
  // 例句放在排程資訊之前：翻面後先看字怎麼用，再看下次什麼時候見。
  const ex = examplesBlock(res.examples);
  if (ex) box.append(ex);

  box.append(h('dl.verdict-sched', {},
    h('div', {}, h('dt', { text: '下次' }), h('dd', { text: relDays(res.state.intervalDays) })),
    // FSRS 的 stability 是「記得的機率掉到九成要幾天」。直接寫「穩定度 34.0 天」是內部術語，
    // 小數點後那一位也沒有人用得上，所以換成白話、取整數。
    h('div', {}, h('dt', { text: '九成記憶可撐' }), h('dd.num', { text: res.state.stability < 1 ? '不到 1 天' : `約 ${Math.round(res.state.stability)} 天` })),
    h('div', {}, h('dt', { text: '累計答錯' }), h('dd.num', { text: String(res.state.lapses) })),
  ));

  if (res.reviewId && res.selfRated) {
    const ratings = h('div.ratings.correction-ratings', { role: 'group', 'aria-label': '更正剛才的評分', tabindex: amending ? -1 : null });
    const labels = card.kind === 'rw' ? RW_RATING_ZH : RATING_ZH;
    const maxRating = card.kind === 'rw' ? 3 : 4;
    if (maxRating === 3) ratings.dataset.n = '3';
    for (let rating = 1; rating <= maxRating; rating += 1) {
      const btn = rateButton(rating, labels[rating], () => correct(rating),
        rating === res.rating ? h('small', { text: '目前' }) : null);
      // 更正用滑鼠點，不綁數字鍵：批改畫面上按 1–4 沒有作用，寫著數字會讓人以為按了就改。
      btn.querySelector('kbd').remove();
      btn.removeAttribute('aria-keyshortcuts');
      // 目前那顆不用 disabled：部分報讀器在 Tab 時會跳過停用的按鈕，就聽不到現在記的是哪一個。
      // 改用 aria-current 標出來；按下去 correct() 自己會擋（評分沒變就不送）。
      if (rating === res.rating) btn.setAttribute('aria-current', 'true');
      ratings.append(btn);
    }
    box.append(h('details.correction', { open: amending },
      h('summary', { text: res.corrected ? '評分已更正' : amending ? '改成哪一個？' : '評分按錯了？' }),
      ratings,
    ));
  }

  box.append(h('div.focus-actions', {},
    h('button.btn.btn-primary.verdict-next', { type: 'button', onclick: next, 'aria-keyshortcuts': 'Enter' },
      '下一張', h('kbd', { text: 'Enter', 'aria-hidden': 'true' })),
  ));

  if (animate) {
    const rest = [...box.children].filter((el) => !el.classList.contains('diff') && !el.classList.contains('verdict-head'));
    queueMicrotask(() => {
      if (letters.length) motion.revealGrade(letters, rest);
      else motion.rise(rest, { y: 6, stagger: 0.04, duration: 0.3 });
    });
  }
  // 從 toast 叫回來改評分時，焦點放在評分群組上，不放在第一顆「忘了」：
  // 順手按一下 Enter 就是一筆更正事件，追加之後收不回來。其餘情況放在「下一張」。
  queueMicrotask(() => {
    const target = amending && !res.corrected
      ? box.querySelector('.correction-ratings')
      : box.querySelector('.verdict-next');
    target?.focus();
  });
  return box;
}

// ---- 收尾畫面 ------------------------------------------------------------

/** 評分比例條與圖例。四段寬度直接用張數當 flex-grow，不先換算百分比。 */
function ratingBreakdown(byRating) {
  const cls = [null, 'r1', 'r2', 'r3', 'r4'];
  const bars = h('div.sum-bar', { 'aria-hidden': 'true' });
  const legend = h('dl.sum-legend');
  for (let r = 1; r <= 4; r += 1) {
    const n = byRating[r];
    if (n > 0) {
      const seg = h(`i.${cls[r]}`);
      seg.style.flexGrow = String(n);
      bars.append(seg);
    }
    legend.append(h('div', { class: n ? null : 'zero' },
      h('dt', { text: RATING_ZH[r] }), h('dd.num', { text: fmt.format(n) })));
  }
  return { bars, legend };
}

/** 「明天到期 N 張」。stats 端點比較重，只在收尾畫面打一次。拿不到就整行拿掉。 */
function tomorrowLine(ctx) {
  const b = h('b.num', { text: '…' });
  const line = h('p.sum-next', {}, '明天到期　', b, ' 張');
  api.stats({ ...ctx.scopeQuery(), upcoming: 7, days: 7, weakest: 1 }).then((d) => {
    const t = new Date();
    t.setDate(t.getDate() + 1);
    const day = t.toLocaleDateString('sv');
    const n = d.upcoming?.days?.find((x) => x.day === day)?.count ?? 0;
    b.textContent = fmt.format(n);
  }, () => line.remove());
  return line;
}

/** 收尾畫面共用的骨架：小標、大數字、說明、比例條、圖例，其餘接在後面。 */
function sumScreen(state, { kicker, tail }) {
  const k = h('h2.sum-kicker.landing', { tabindex: -1, text: kicker });
  const n = h('span', { text: fmt.format(state.done) });
  const number = h('p.sum-num.num', {}, n, h('small', { text: '張' }));
  const cap = h('p.sum-cap', { text: capLine(state) });
  const { bars, legend } = ratingBreakdown(state.byRating);
  const list = tail.filter(Boolean);
  const box = h('section.summary', {}, k, number, cap, bars, legend, ...list);
  motion.introSummary({
    kicker: k, number: n, to: state.done, cap,
    bars: bars.children, legend: legend.children, tail: list,
  });
  return box;
}

function summary(state, ctx, reload) {
  if (state.preset === 'weak') {
    return sumScreen(state, {
      kicker: '弱點練習',
      tail: [
        followUps(state),
        tomorrowLine(ctx),
        h('div.sum-act', {},
          h('button.btn.btn-primary', { type: 'button', text: '看進度', onclick: () => ctx.go('stats') }),
          h('button.btn', { type: 'button', text: '回今天', onclick: () => ctx.go('today') }),
        ),
      ],
    });
  }
  const r = state.remaining;
  // 不設上限（newLimit 為 null）時額度永遠用不完，只剩「新卡學光了」這一種收工方式。
  const capHit = r && r.newLimit !== null && r.newToday >= r.newLimit;
  const noneLeft = r && r.remaining.new === 0;
  const nothingLeft = r && r.remaining.due === 0 && (capHit || noneLeft);
  // state.done 是這次進頁面以來的累計，不是最後一批——舊字樣「這一輪做完了，共 40 張」會被讀成一批 40 張。
  return sumScreen(state, {
    kicker: '這次複習',
    tail: [
      h('p.sum-note', {
        text: nothingLeft
          ? (noneLeft ? '這個範圍的新卡也學完了。' : '今天的新卡額度用完了。')
          : '還有卡可以練。',
      }),
      tomorrowLine(ctx),
      h('div.sum-act', {},
        nothingLeft
          ? h('button.btn.btn-primary', { type: 'button', text: '回今天', onclick: () => ctx.go('today') })
          : h('button.btn.btn-primary', { type: 'button', text: '再來一輪', onclick: reload }),
        h('button.btn', { type: 'button', text: '看進度', onclick: () => ctx.go('stats') }),
        nothingLeft ? null : h('button.btn.btn-quiet', { type: 'button', text: '回今天', onclick: () => ctx.go('today') }),
      ),
    ],
  });
}

/** 一張都沒做就沒卡可出：範圍太窄、或今天真的做完了。範圍鈕借過來放在這裡，這時上方那條是收起來的。 */
function emptyScreen(state, ctx, scopeBtn) {
  const weak = state.preset === 'weak';
  const r = state.remaining;
  const capHit = r && r.newLimit !== null && r.newToday >= r.newLimit;
  const noneLeft = r && r.remaining.new === 0;
  let note = '這個範圍裡沒有答錯過的卡。';
  if (!weak) note = noneLeft ? '這個範圍的新卡也學完了。' : capHit ? '今天的新卡額度用完了。' : '這個範圍裡沒有可以出的卡。';
  return h('section.summary.summary-empty', {},
    h('h2.sum-title.landing', { tabindex: -1, text: weak ? '目前沒有弱點卡' : '現在沒有到期的卡' }),
    h('p.sum-cap', { text: note }),
    weak ? null : tomorrowLine(ctx),
    h('div.sum-act', {},
      h('button.btn.btn-primary', { type: 'button', text: '回今天', onclick: () => ctx.go('today') }),
      weak ? h('button.btn', { type: 'button', text: '看進度', onclick: () => ctx.go('stats') }) : scopeBtn,
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
  return h('div.session-followup', {}, h('p.cue', { text: '接下來兩件事' }), h('ol', {}, ...picked.map((text) => h('li', { text }))));
}

/**
 * 到期卡清完後停一次。主按鈕是離開：到期的做完就是今天的份量，
 * 繼續學新卡是加練，所以放次要——學得越多，之後每天要複習的也越多。
 */
function checkpoint(state, ctx, keepGoing) {
  return sumScreen(state, {
    kicker: '到期的卡清完了',
    tail: [
      h('p.sum-note', { text: `今天新學 ${state.remaining.newToday} 張。再學新卡，之後每天要複習的也會變多。` }),
      tomorrowLine(ctx),
      h('div.sum-act', {},
        h('button.btn.btn-primary', { type: 'button', text: '回今天', onclick: () => ctx.go('today') }),
        h('button.btn', { type: 'button', text: '繼續學新卡', onclick: keepGoing }),
      ),
    ],
  });
}

/** 單張卡計入本次作答時間的上限（毫秒），與 api.mjs 統計中位數的過濾上限相同。 */
const SESSION_MS_CAP = 120_000;

/** 大數字底下那一行。張數已經印成大字，這裡只講要重來幾張與花了多久。 */
function capLine(state) {
  const min = Math.round(state.ms / 60_000);
  const time = min < 1 ? '作答不到 1 分鐘' : `作答 ${min} 分鐘`;
  const again = state.again ? `${state.again} 張要重來` : '沒有要重來的';
  return `${again}，${time}`;
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

/** 載入中的骨架，形狀跟卡片一樣：小字一行、大字一行、作答線一條。 */
function skeleton() {
  const box = h('div.focus-card.focus-skeleton', { 'aria-busy': 'true' });
  for (const [w, hh] of [['22%', 12], ['46%', 72], ['38%', 44]]) {
    const bar = h('div.skeleton');
    bar.style.width = w;
    bar.style.height = `${hh}px`;
    box.append(bar);
  }
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
