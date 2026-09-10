/**
 * 外殼與路由。
 *
 * 沒有路由函式庫，就是一個 hashchange 監聽器加一張表。五個頁面、
 * 沒有巢狀路由、沒有參數——這種規模引框架，維護成本會比省下的多。
 *
 * 這一層負責三件跨頁面的事：
 *   範圍篩選　選了哪些題型與程度。複習／統計／推演三頁吃這組條件，所以它屬於外殼，
 *   　　　　　不屬於任何一頁；存在 localStorage，關掉再開還在。「今天」與「查詢」
 *   　　　　　刻意不吃，那兩頁的面板會收起來（見 PAGES.scoped）。
 *   到期數量　側欄那顆數字。作答後由 review 頁呼叫 refreshBadge() 更新，
 *             因為只有它知道自己剛剛改了什麼。
 *   設定　　　目標記憶率、每天新卡量與考試日期。三個都會改變往後所有卡的排程，
 *             所以按「儲存」才生效——拖動滑桿的中間值不該被寫進去。
 */

import { h, clear, icon } from './dom.mjs';
import { api } from './net.mjs';
import { todayView } from './today.mjs';
import { reviewView } from './review.mjs';
import { statsView } from './stats.mjs';
import { forecastView } from './forecast.mjs';
import { browseView } from './browse.mjs';

// scoped 標的是「這一頁的內容真的會跟著側欄的題型／程度變」。
// 沒標的兩頁各有理由：「今天」問的是今天整體該做什麼，本來就要看全部四科；
// 「查詢」查的是整個題庫，把它限制在勾選範圍內只會讓人以為題庫裡沒有那個字。
// 標了才有意義——面板一直亮著卻不生效，比沒有面板還糟。
const PAGES = [
  // 「今天」排第一也是預設頁：這個 App 最常見的失敗不是練錯，是根本沒打開來練。
  { id: 'today', label: '今天', icon: 'today', view: todayView, scoped: false },
  { id: 'review', label: '複習', icon: 'cards', view: reviewView, badge: true, scoped: true },
  { id: 'stats', label: '統計', icon: 'chart', view: statsView, scoped: true },
  { id: 'forecast', label: '推演', icon: 'route', view: forecastView, scoped: true },
  { id: 'browse', label: '查詢', icon: 'find', view: browseView, scoped: false },
];

const KINDS = [
  { id: 'vocab-recall', label: '看字回想' },
  { id: 'vocab-produce', label: '中翻法' },
  { id: 'conj', label: '動詞變位' },
  { id: 'connector', label: '連接詞' },
  { id: 'pick', label: '挑連接詞' },
  { id: 'rw', label: '改寫整句' },
  { id: 'nom', label: '名詞化' },
];
const LEVELS = ['A1', 'A2', 'B1'];

const STORE_KEY = 'cadence.scope';
const THEME_KEY = 'cadence.theme';

const state = {
  scope: loadScope(),
  settings: { desiredRetention: 0.9, dailyNewLimit: 15, examDate: null },
  meta: null,
  page: null,
  cleanup: null,
};

const els = {};

const ctx = {
  get settings() { return state.settings; },
  scopeQuery,
  setScope,
  refreshBadge,
  toast,
  go,
  saveSettings,
};

applyStoredTheme();
boot();

/** CSP 不允許 inline script，佈景只能在這裡套。模組載入很快，實測看不到閃色。 */
function applyStoredTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
  } catch {
    // 讀不到就跟隨系統，這是本來的預設值。
  }
}

async function boot() {
  buildShell();
  window.addEventListener('hashchange', () => go(hashPage()));

  try {
    const s = await api.summary();
    state.settings = s.settings;
    state.meta = s.meta;
    els.meta.textContent = metaLine(s);
    // 側欄的數字要跟著篩選範圍走，summary 的 dueNow 是全題庫的，不能直接用。
    refreshBadge();
  } catch (err) {
    // 題庫載不出來時仍然把外殼畫出來，才有地方顯示這個錯誤。
    toast(err.message, 'bad');
  }
  go(hashPage());
}

/* ── 外殼 ─────────────────────────────────────────────────────── */

function buildShell() {
  const rail = document.getElementById('rail');
  const nav = h('nav.nav', { 'aria-label': '主要導覽' });
  els.tabs = new Map();
  for (const page of PAGES) {
    const badge = page.badge ? h('span.badge.num', { text: '', hidden: true }) : null;
    const a = h('a', { href: `#${page.id}` },
      icon(page.icon), h('span.label', { text: page.label }), badge);
    els.tabs.set(page.id, { a, badge });
    nav.append(a);
  }
  rail.append(nav);
  els.scope = scopePanel();
  rail.append(els.scope);

  const foot = h('div.rail-foot', {},
    h('div.rail-actions', {},
      h('button.btn.btn-quiet.btn-sm', { type: 'button', text: '設定', onclick: openSettings }),
      themeButton(),
    ),
  );
  els.meta = h('p.built', { text: '' });
  foot.append(els.meta);
  rail.append(foot);

  els.main = document.getElementById('view');
  els.toasts = document.getElementById('toasts');
  document.getElementById('brand-sub').textContent = '法文複習';
}

/**
 * 範圍篩選。用真的 checkbox，只是把外觀換掉——
 * 自己用 div 做開關，鍵盤與螢幕閱讀器就得全部自己補，做不完也做不對。
 */
function scopePanel() {
  const box = h('div.scope');
  // 「今天」頁按下去會直接改題型範圍，勾選框得跟著動，不然側欄會跟實際範圍說兩套話。
  els.toggles = new Map();
  box.append(h('h2.scope-h', { text: '題型' }));
  const kinds = h('div.toggles');
  for (const k of KINDS) kinds.append(toggle(k.label, 'kinds', k.id));
  box.append(kinds);

  box.append(h('h2.scope-h', { text: '程度' }));
  const levels = h('div.toggles');
  for (const l of LEVELS) levels.append(toggle(l, 'levels', l));
  box.append(levels);

  els.scopeNote = h('p.scope-note', { text: '' });
  box.append(els.scopeNote);
  updateScopeNote();
  return box;
}

function toggle(label, group, value) {
  const input = h('input', {
    type: 'checkbox',
    checked: state.scope[group].includes(value),
    onchange: () => {
      const list = state.scope[group];
      const at = list.indexOf(value);
      if (at >= 0) list.splice(at, 1);
      else list.push(value);
      saveScope();
      updateScopeNote();
      go(state.page, { force: true });
      refreshBadge();
    },
  });
  els.toggles.set(`${group}:${value}`, input);
  return h('label.toggle', {}, input, h('span', { text: label }));
}

/**
 * 由「今天」頁指定要練哪些題型。只動題型，不動程度——
 * 使用者可能刻意只練 B1，那個選擇不該被一顆「開始練」按鈕吃掉。
 */
function setScope(kinds) {
  state.scope.kinds = KINDS.map((k) => k.id).filter((id) => kinds.includes(id));
  for (const k of KINDS) {
    const input = els.toggles.get(`kinds:${k.id}`);
    if (input) input.checked = state.scope.kinds.includes(k.id);
  }
  saveScope();
  updateScopeNote();
  refreshBadge();
}

function updateScopeNote() {
  const { kinds, levels } = state.scope;
  els.scopeNote.textContent = !kinds.length && !levels.length
    ? '目前是全部題型與程度。'
    : `只練 ${[kinds.length ? `${kinds.length} 種題型` : null, levels.length ? levels.join('／') : null].filter(Boolean).join('・')}。`;
}

function scopeQuery() {
  return { kinds: state.scope.kinds, levels: state.scope.levels };
}

function loadScope() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null');
    const clean = (list, allowed) => (Array.isArray(list) ? list.filter((x) => allowed.includes(x)) : []);
    return {
      kinds: clean(raw?.kinds, KINDS.map((k) => k.id)),
      levels: clean(raw?.levels, LEVELS),
    };
  } catch {
    return { kinds: [], levels: [] };
  }
}

function saveScope() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state.scope));
  } catch {
    // 無痕模式寫不進去。篩選條件掉了不影響任何資料，不必打擾使用者。
  }
}

/* ── 路由 ─────────────────────────────────────────────────────── */

function hashPage() {
  const id = location.hash.replace(/^#/, '');
  return PAGES.some((p) => p.id === id) ? id : PAGES[0].id;
}

function go(id, { force = false } = {}) {
  const page = PAGES.find((p) => p.id === id) ?? PAGES[0];
  if (!force && state.page === page.id) return;
  if (location.hash !== `#${page.id}`) location.hash = page.id;

  if (typeof state.cleanup === 'function') state.cleanup();
  state.cleanup = null;
  state.page = page.id;

  for (const [pid, { a }] of els.tabs) {
    if (pid === page.id) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  document.title = `${page.label} · cadence`;
  setScopeVisible(page);

  clear(els.main);
  // 五個檢視都需要一個頁面主標題；視覺層級由各頁自己的內容承擔，所以只供讀屏與文件大綱使用。
  els.main.append(h('h1.sr', { text: page.label }));
  state.cleanup = page.view(els.main, ctx) ?? null;
  els.main.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

/**
 * 篩選面板只在真的吃 scope 的頁面出現。
 *
 * 用 hidden 而不是每次重建：勾選狀態要留著，切回「複習」時側欄得跟切走之前一樣。
 * inert 一起下，免得面板收起來之後 Tab 還跳得進去。
 */
function setScopeVisible(page) {
  if (!els.scope) return;
  els.scope.hidden = !page.scoped;
  els.scope.inert = !page.scoped;
}

/* ── 到期數量 ─────────────────────────────────────────────────── */

/** 回傳整包 queue 摘要，讓複習頁的上方計數器共用同一次請求。 */
async function refreshBadge() {
  try {
    const data = await api.queue({ ...scopeQuery(), limit: 1 });
    setBadge(data.remaining.due);
    return data;
  } catch {
    // 數字更新不了不值得跳錯誤；下一次作答會再試一次。
    return null;
  }
}

function setBadge(due) {
  const entry = els.tabs.get('review');
  if (!entry?.badge) return;
  entry.badge.textContent = due > 99 ? '99+' : String(due);
  entry.badge.hidden = !due;
  entry.a.setAttribute('aria-label', due ? `複習，${due} 張到期` : '複習');
}

function metaLine(summary) {
  const total = summary.totalCards ?? 0;
  const built = state.meta?.builtAt ? state.meta.builtAt.slice(0, 10) : null;
  return [`題庫 ${total.toLocaleString('zh-Hant')} 張`, built ? `建於 ${built}` : null]
    .filter(Boolean).join('・');
}

/* ── 設定 ─────────────────────────────────────────────────────── */

function openSettings() {
  // 不靠 dialog 的 close 事件清場。實測這台的 Electron 殼（Chrome 148）
  // 呼叫 close() 之後不會派送 close，靠它 remove 就會在 DOM 裡積一疊關著的 dialog。
  // 關的地方自己 remove，另外開新的之前先掃掉舊的——Esc 關掉的那種只能靠這一道。
  for (const stale of document.querySelectorAll('dialog.sheet')) stale.remove();

  const dlg = h('dialog.sheet');
  const dismiss = () => { dlg.close(); dlg.remove(); };
  const retention = h('input', {
    type: 'range', min: '0.7', max: '0.98', step: '0.01',
    value: String(state.settings.desiredRetention),
  });
  const retOut = h('output.num', { text: fmtPct(state.settings.desiredRetention) });
  // 讀屏軟體念 range 只會念到 0.9。這裡是百分比，念「90%」才對得上旁邊看到的字。
  const syncRet = () => {
    const v = Number(retention.value);
    retOut.textContent = fmtPct(v);
    retention.setAttribute('aria-valuetext', fmtPct(v));
  };
  syncRet();
  retention.addEventListener('input', syncRet);

  const fresh = h('input.input', {
    type: 'number', min: '0', max: '200', step: '1',
    value: String(state.settings.dailyNewLimit),
  });
  const exam = h('input.input', { type: 'date', value: state.settings.examDate ?? '' });

  const err = h('p.field-error', { text: '', hidden: true });
  const form = h('form.sheet-body', { method: 'dialog' },
    h('h2', { text: '設定' }),

    field('目標記憶率', h('div.range-row', {}, retention, retOut),
      '排程時要維持的答對率。調高複習變密、總量變大；調低省時間但忘得多。FSRS 預設 0.90。'),

    field('每天新卡上限', fresh,
      '一天最多引入幾張沒學過的卡。今天學的每一張，未來幾週都會回來找你。'),

    field('考試日期', exam,
      '推演頁的預設日期。留空表示還沒有確定的考試。'),

    err,
    h('div.sheet-foot', {},
      h('button.btn.btn-quiet', { type: 'button', text: '取消', onclick: dismiss }),
      h('button.btn.btn-primary', { type: 'submit', text: '儲存' }),
    ),
  );
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      await saveSettings({
        desiredRetention: Number(retention.value),
        dailyNewLimit: Number(fresh.value),
        examDate: exam.value || null,
      });
      dismiss();
      // 今天與推演直接顯示考試日期或新卡額度，儲存後若不重畫會繼續顯示舊值。
      // 複習頁保留正在輸入的答案；它會在下一次作答或重新抓佇列時套用新額度。
      if (state.page === 'today' || state.page === 'forecast') go(state.page, { force: true });
      refreshBadge();
      toast('設定已儲存', 'ok');
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
    }
  });
  dlg.append(form);
  document.body.append(dlg);
  dlg.showModal();
}

/**
 * 一組「標題 + 控制項 + 說明」。
 * control 可能是包了一層的容器（滑桿旁邊還有數值），label 要指到真正的輸入元件，
 * 不然點標題不會聚焦，讀屏軟體也只會念到一個沒有名字的滑桿。
 */
function field(label, control, help) {
  const input = control.matches('input, select, textarea')
    ? control
    : control.querySelector('input, select, textarea');
  input.id ||= `f-${Math.random().toString(36).slice(2, 8)}`;
  return h('div.field', {},
    h('label', { for: input.id, text: label }),
    control,
    h('p.hint', { text: help }),
  );
}

async function saveSettings(patch) {
  const next = await api.saveSettings(patch);
  state.settings = next;
  return next;
}

function fmtPct(x) {
  return `${Math.round(x * 100)}%`;
}

/* ── 佈景與提示 ───────────────────────────────────────────────── */

function themeButton() {
  const btn = h('button.btn.btn-quiet.btn-sm.theme', { type: 'button' });
  const paint = () => {
    const mode = document.documentElement.dataset.theme ?? 'auto';
    clear(btn);
    btn.append(icon(mode === 'dark' ? 'moon' : 'sun'),
      h('span', { text: mode === 'auto' ? '跟隨系統' : (mode === 'dark' ? '深色' : '淺色') }));
    btn.setAttribute('aria-label', `佈景：${mode === 'auto' ? '跟隨系統' : (mode === 'dark' ? '深色' : '淺色')}，按一下切換`);
  };
  btn.addEventListener('click', () => {
    const order = ['auto', 'light', 'dark'];
    const now = document.documentElement.dataset.theme ?? 'auto';
    const next = order[(order.indexOf(now) + 1) % order.length];
    if (next === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = next;
    try { localStorage.setItem(THEME_KEY, next); } catch { /* 同上，不影響資料 */ }
    paint();
  });
  paint();
  return btn;
}

/**
 * 提示條。只用在「操作結果」與錯誤，不用在慶祝。
 * aria-live 用 polite，不打斷螢幕閱讀器正在念的批改結果。
 */
function toast(message, tone = 'info') {
  const node = h('div.toast', { dataset: { tone }, role: 'status' },
    tone === 'bad' ? icon('alert') : null,
    h('span', { text: message }));
  els.toasts.append(node);
  setTimeout(() => node.remove(), 4200);
}
