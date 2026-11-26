/**
 * 跟 Gemini 來回對話的元件，雲端版才有。
 *
 * 對話只活在這一頁的記憶體裡，不存資料庫也不寫 localStorage（使用者選的）：
 * 重新整理就沒了。每送一則都是一次 Gemini 呼叫，所以不做自動送出、不做打字中預先請求。
 *
 * 後端每一輪都重算網站自己的資料（週統計、弱點卡），前端送的只有對話文字、
 * 批改結果這類「使用者當下看到的東西」，以及模型回傳的 thoughtSignature（原樣送回才不掉品質）。
 */

import { h, clear } from './dom.mjs';
import { api } from './net.mjs';
import { render } from './markdown.mjs';
import { ROLEPLAY, DEBRIEF_TEXT, MAX_MESSAGE, MAX_MODEL_MESSAGE } from './roleplay.mjs';

/**
 * 一段對話：訊息列、狀態列、輸入框。
 * opener 模式（情境對話、出題）由模型先開口，要呼叫 start() 才會開始；其他模式直接等使用者輸入。
 * context 是函式：情境對話要在按「開始」的當下才讀選單的值。
 */
export function chatThread({
  mode,
  context = () => ({}),
  opener = false,
  label,
  placeholder = '輸入問題',
  modelLang = () => null,
  onChange = () => {},
}) {
  let messages = [];
  // 每次清空都 +1，還在路上的回覆回來時世代對不上就丟掉，不會出現在新的一段對話裡。
  let gen = 0;
  let busy = false;
  let left = null;
  let started = !opener;

  // role="log" 隱含 aria-live="polite"：新的一則加進來讀屏會念，不用另外 announce。
  const log = h('ol.chat-log', { role: 'log', 'aria-label': label });
  const status = h('p.chat-status', { role: 'status' });
  const input = h('textarea.input.chat-input', {
    rows: 2, maxlength: MAX_MESSAGE, placeholder, 'aria-label': `${label}：輸入訊息`,
    onkeydown: onKey,
  });
  const count = h('span.chat-count');
  const reset = h('button.btn.btn-quiet.btn-sm', { type: 'button', text: '清空重來', onclick: clearAll });
  const send = h('button.btn.btn-primary.btn-sm', { type: 'submit', text: '送出' });
  const extras = h('span.chat-extras');
  const form = h('form.chat-form', { onsubmit: (ev) => { ev.preventDefault(); submit(); } },
    input,
    h('div.chat-bar', {}, count, extras, reset, send));
  const el = h('section.chat', { dataset: { mode } }, log, status, form);
  sync();

  return { el, start, submit, clear: clearAll, addAction, focus: () => input.focus(), get state() { return snapshot(); } };

  function onKey(ev) {
    // 注音、拼音選字時按 Enter 是確認選字，不是送出。Safari 選字中的 keydown 只認得出 keyCode 229。
    if (ev.key !== 'Enter' || ev.shiftKey || ev.isComposing || ev.keyCode === 229) return;
    ev.preventDefault();
    submit();
  }

  /** 外面要加的按鈕（例如「結束並講評」），跟著忙碌狀態一起停用。 */
  function addAction(button) {
    extras.append(button);
    sync();
  }

  /** opener 模式的第一輪：送空的歷史，後端補一句隱藏的開場讓模型先說話。 */
  function start() {
    if (busy || started) return;
    started = true;
    ask(gen, () => { started = false; });
  }

  async function submit(raw = input.value, { fromInput = raw === input.value } = {}) {
    const text = String(raw).trim();
    if (busy || !started || left === 0 || !text) return;
    const bubble = userBubble(text);
    messages.push({ role: 'user', text });
    log.append(bubble);
    if (fromInput) input.value = '';
    await ask(gen, () => {
      // 沒送成功：這一則從紀錄拿掉、字放回輸入框，使用者不用重打。
      messages.pop();
      bubble.remove();
      if (fromInput && !input.value) input.value = text;
    });
  }

  async function ask(mine, rollback) {
    busy = true;
    status.textContent = '';
    const pending = h('li.chat-msg.chat-pending', { dataset: { role: 'model' } },
      who('model'), h('p.chat-text', { text: '思考中…' }));
    log.append(pending);
    pending.scrollIntoView?.({ block: 'nearest' });
    sync();
    const lastUser = messages.at(-1)?.role === 'user' ? messages.at(-1).text : null;
    try {
      const data = await api.aiChat({ mode, context: context(), messages });
      if (mine !== gen) return;
      pending.remove();
      // 後端收 model 訊息的上限是 8000 字；超過的回覆畫面照常全顯示，送回去的那份截掉，下一輪才不會被退。
      const text = String(data.reply ?? '');
      const kept = text.slice(0, MAX_MODEL_MESSAGE);
      messages.push(data.signature ? { role: 'model', text: kept, signature: data.signature } : { role: 'model', text: kept });
      const bubble = modelBubble(text, { lang: modelLang(lastUser), truncated: data.truncated });
      log.append(bubble);
      bubble.scrollIntoView?.({ block: 'nearest' });
      left = Number.isFinite(data.turnsLeft) ? data.turnsLeft : left;
    } catch (err) {
      if (mine !== gen) return;
      pending.remove();
      rollback();
      status.textContent = `沒有送出：${err.message}`;
    } finally {
      if (mine === gen) {
        busy = false;
        sync();
      }
    }
  }

  function clearAll() {
    gen += 1;
    messages = [];
    busy = false;
    left = null;
    started = !opener;
    clear(log);
    status.textContent = '';
    input.value = '';
    sync();
  }

  function sync() {
    const closed = !started || left === 0;
    // 忙碌時用 readOnly 不用 disabled：disabled 會把焦點踢回 body，回覆來了還得自己點回輸入框。
    input.readOnly = busy;
    input.disabled = closed;
    send.disabled = busy || closed;
    for (const b of extras.querySelectorAll('button')) b.disabled = busy || closed || messages.length === 0;
    reset.hidden = messages.length === 0 && !busy;
    count.textContent = left === null ? ''
      : left === 0 ? '已到 20 則上限，清空才能開新的一段'
        : `還能送 ${left} 則`;
    onChange(snapshot());
  }

  function snapshot() {
    return { busy, started, left, count: messages.length };
  }
}

function who(role) {
  return h('span.chat-who', { text: role === 'user' ? '你' : 'AI' });
}

function userBubble(text) {
  return h('li.chat-msg', { dataset: { role: 'user' } }, who('user'), h('p.chat-text', { text }));
}

function modelBubble(text, { lang = null, truncated = false } = {}) {
  return h('li.chat-msg', { dataset: { role: 'model' } },
    who('model'),
    h('div.chat-body', { lang }, render(text)),
    truncated ? h('p.chat-note', { text: '回答太長被截斷了，可以請它接著說。' }) : null);
}

/** 批改結果下方的追問。快照在批改完成那一刻定住，之後草稿再改也不會混進這段對話。 */
export function peFollowUp(snapshot) {
  const thread = chatThread({
    mode: 'pe',
    context: () => snapshot,
    label: '追問這次批改',
    placeholder: '例如：第二個修正為什麼要用虛擬式？（Enter 送出，Shift+Enter 換行）',
  });
  return h('div.chat-follow', {}, h('h4', { text: '追問這次批改' }), thread.el);
}

/** 週回顧下方的追問。 */
export function weeklyFollowUp(brief) {
  const thread = chatThread({
    mode: 'weekly',
    context: () => ({ brief }),
    label: '追問這份回顧',
    placeholder: '例如：下週只有三天能讀，要先做哪一項？',
  });
  return h('div.chat-follow', {}, h('h3.ai-brief-h', { text: '追問這份回顧' }), thread.el);
}

/**
 * 右下角的對話按鈕與面板。面板關掉只是藏起來，三段對話都留著，重新整理才清空。
 * 回傳 open(tab)，讓其他頁（例如口說工作台）直接打開某一個分頁。
 */
export function mountChatDock() {
  const tabs = [
    { id: 'free', label: '問答', build: freePane },
    { id: 'roleplay', label: '情境對話', build: roleplayPane },
    { id: 'quiz', label: '出題', build: quizPane },
  ];
  const seg = h('div.seg.chat-tabs', { role: 'group', 'aria-label': '對話類型' });
  const body = h('div.chat-dock-body');
  const panes = new Map();
  for (const tab of tabs) {
    const pane = tab.build();
    pane.el.hidden = true;
    panes.set(tab.id, pane);
    body.append(pane.el);
    seg.append(h('button', { type: 'button', text: tab.label, 'aria-pressed': 'false', dataset: { tab: tab.id }, onclick: () => show(tab.id) }));
  }

  const close = h('button.btn.btn-quiet.btn-sm', { type: 'button', text: '關閉', onclick: () => dlg.close() });
  const dlg = h('dialog.sheet.chat-dock', { 'aria-labelledby': 'chat-dock-h' },
    h('div.chat-dock-head', {}, h('h2#chat-dock-h', { text: '跟 AI 對話' }), close),
    seg,
    body,
    h('p.chat-foot', { text: 'Gemini 回答，不存檔；重新整理就清空。每送一則算一次呼叫。' }));
  // 圖示集裡沒有對話泡泡，用字比硬借一個意思不對的圖示清楚。
  const fab = h('button.chat-fab', { type: 'button', text: '問 AI', 'aria-haspopup': 'dialog', onclick: () => open() });
  document.body.append(dlg, fab);

  let current = 'free';
  show(current);
  return { open };

  function show(id) {
    current = id;
    for (const b of seg.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.tab === id));
    for (const [key, pane] of panes) pane.el.hidden = key !== id;
  }

  function open(tab = current) {
    if (panes.has(tab)) show(tab);
    if (!dlg.open) dlg.showModal();
    panes.get(current).focus();
  }
}

function freePane() {
  const thread = chatThread({
    mode: 'free',
    label: '問答',
    placeholder: '問文法、單字或讀書計畫都可以。AI 看得到你這 7 天的複習數字。',
  });
  return { el: h('div.chat-pane', {}, thread.el), focus: thread.focus };
}

/** 口說情境對話：選題卡 → 模型扮角色先開口 → 用法文來回 → 按「結束並講評」換成中文講評。 */
function roleplayPane() {
  const select = h('select.input.chat-select', { 'aria-label': '情境' },
    ROLEPLAY.map((s) => h('option', { value: s.id, text: `Partie ${s.part}・${s.title}` })));
  const card = h('p.chat-card.fr', { lang: 'fr' });
  const begin = h('button.btn.btn-primary.btn-sm', { type: 'button', text: '開始', onclick: () => thread.start() });
  const picked = () => ROLEPLAY.find((s) => s.id === select.value) ?? ROLEPLAY[0];
  const showCard = () => { card.textContent = picked().card; };
  select.addEventListener('change', showCard);
  showCard();

  const thread = chatThread({
    mode: 'roleplay',
    opener: true,
    context: () => ({ scenario: picked().id }),
    label: '情境對話',
    placeholder: 'Répondez en français…（Enter 送出）',
    // 講評那一輪是中文，其他輪是法文；標 lang 讀屏才會用對的發音念。
    modelLang: (lastUser) => (lastUser === DEBRIEF_TEXT ? null : 'fr'),
    onChange: ({ started, busy }) => {
      select.disabled = started || busy;
      begin.hidden = started;
    },
  });
  thread.addAction(h('button.btn.btn-sm', { type: 'button', text: '結束並講評', onclick: () => thread.submit(DEBRIEF_TEXT, { fromInput: false }) }));
  const el = h('div.chat-pane', {},
    h('div.chat-setup', {}, select, begin),
    card,
    h('p.hint', { text: '打字練習，不評發音。講到一個段落按「結束並講評」，AI 會依 DELF B1 口說評分表講評。題卡是自擬的，不是官方樣題。' }),
    thread.el);
  return { el, focus: () => (thread.state.started ? thread.focus() : select.focus()) };
}

/** 出題：後端從你最近答錯的卡出題，一次一題，答完講解再出下一題。 */
function quizPane() {
  const begin = h('button.btn.btn-primary.btn-sm', { type: 'button', text: '開始出題', onclick: () => thread.start() });
  const thread = chatThread({
    mode: 'quiz',
    opener: true,
    label: '出題',
    placeholder: '輸入答案…（Enter 送出）',
    onChange: ({ started }) => { begin.hidden = started; },
  });
  const el = h('div.chat-pane', {},
    h('div.chat-setup', {},
      h('p.hint', { text: '從最近 30 天答錯最多的卡出題，題目不會照抄卡片。這裡答對答錯都不記進複習排程。' }),
      begin),
    thread.el);
  return { el, focus: () => (thread.state.started ? thread.focus() : begin.focus()) };
}
