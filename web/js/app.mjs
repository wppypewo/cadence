/**
 * 外殼與路由。
 *
 * 沒有路由函式庫，就是一個 hashchange 監聽器加一張表。導覽列四項（今天／複習／進度／辭典；雲端模式多一項資源），
 * 「進度」底下是統計與推演兩頁，另有兩個次級工作台；沒有巢狀路由、沒有參數——
 * 這種規模引框架，維護成本會比省下的多。
 *
 * 這一層負責四件跨頁面的事：
 *   範圍篩選　選了哪些題型與程度。複習／統計／推演三頁吃這組條件，所以它屬於外殼，
 *   　　　　　不屬於任何一頁；存在 localStorage，關掉再開還在。面板只有一份，
 *   　　　　　由各頁用 ctx.scopeMenu() 放進自己的頁首（見 PAGES.scoped）。
 *   專注模式　複習時整條導覽收起來。由複習頁自己開，換頁時外殼一律關掉。
 *   到期數量　側欄那顆數字。作答後由 review 頁呼叫 refreshBadge() 更新，
 *             因為只有它知道自己剛剛改了什麼。
 *   設定　　　目標記憶率、每天新卡量與考試日期。三個都會改變往後所有卡的排程，
 *             所以按「儲存」才生效——拖動滑桿的中間值不該被寫進去。
 */

import { h, clear, icon, announce } from './dom.mjs';
import { api } from './net.mjs';
import { requireSession, signOut } from './auth.mjs';
import { isCloudRuntime } from './runtime.mjs';
import { todayView } from './today.mjs';
import { reviewView } from './review.mjs';
import { statsView } from './stats.mjs';
import { forecastView } from './forecast.mjs';
import { browseView } from './browse.mjs';
import { practiceView } from './practice.mjs';
import { mockView } from './mock.mjs';
import { KIND_ZH } from './kinds.mjs';
import { resourcesView } from './resources.mjs';

// scoped 標的是「這一頁的內容真的會跟著範圍選單的題型／程度變」，也只有這幾頁的頁首放得出那顆範圍鈕。
// 沒標的兩頁各有理由：「今天」問的是今天整體該做什麼，本來就要看全部四科；
// 「辭典」查的是整個題庫，把它限制在勾選範圍內只會讓人以為題庫裡沒有那個字。
// 標了才有意義——選單一直在卻不生效，比沒有選單還糟。
const PAGES = [
  // 「今天」排第一也是預設頁：這個 App 最常見的失敗不是練錯，是根本沒打開來練。
  { id: 'today', label: '今天', view: todayView, scoped: false },
  { id: 'review', label: '複習', view: reviewView, scoped: true },
  { id: 'stats', label: '進度', view: statsView, scoped: true },
  { id: 'forecast', label: '推演', view: forecastView, scoped: true },
  { id: 'browse', label: '辭典', view: browseView, scoped: false },
  // 資源清單只存在雲端資料庫（supabase/migrations 的種子資料），本機伺服器沒有對應端點，
  // 本機模式列出來只會得到一頁錯誤訊息，所以只在雲端模式出現。
  { id: 'resources', label: 'B2 資源', view: resourcesView, scoped: false, cloudOnly: true },
  // 工作台由今天／進度頁帶著科目進入，不佔導覽列的位置。
  { id: 'practice', label: '練習', view: practiceView, scoped: false },
  { id: 'mock', label: '模考紀錄', view: mockView, scoped: false },
].filter((p) => !p.cloudOnly || isCloudRuntime());

// 導覽列。pages 列出哪些頁面算在這一項底下，停在那些頁時這一項亮起來——
// 從今天頁進工作台、從進度頁進推演，側欄都不該看起來像是跳到別的地方。
const NAV = [
  { id: 'today', label: '今天', pages: ['today', 'practice'] },
  { id: 'review', label: '複習', pages: ['review'], badge: true },
  { id: 'stats', label: '進度', pages: ['stats', 'forecast', 'mock'] },
  { id: 'browse', label: '辭典', pages: ['browse'] },
  { id: 'resources', label: '資源', pages: ['resources'], cloudOnly: true },
].filter((item) => !item.cloudOnly || isCloudRuntime());

const KINDS = Object.entries(KIND_ZH).map(([id, label]) => ({ id, label }));
const LEVELS = ['A2', 'B1'];

const STORE_KEY = 'cadence.scope';
const THEME_KEY = 'cadence.theme';

const state = {
  scope: loadScope(),
  settings: { desiredRetention: 0.9, dailyNewLimit: 15, examDate: null },
  meta: null,
  page: null,
  cleanup: null,
  practiceSkill: 'PE',
  reviewPreset: null,
  guided: false,
};

const els = { popovers: [] };

const ctx = {
  get settings() { return state.settings; },
  scopeQuery,
  scopeMenu,
  setScope,
  setFocus,
  refreshBadge,
  toast,
  go,
  saveSettings,
  openPractice,
  startReview,
  takeReviewPreset,
  get guided() { return state.guided; },
  endGuided() { state.guided = false; },
  get practiceSkill() { return state.practiceSkill; },
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
  const session = await requireSession();
  if (!session) return;
  buildShell();
  window.addEventListener('hashchange', () => {
    const id = hashPage();
    // 不認得的 hash 不換頁，只把網址改回目前這一頁。replaceState 不會再觸發 hashchange。
    if (location.hash !== `#${id}`) history.replaceState(null, '', `#${id}`);
    go(id);
  });

  try {
    const s = await api.summary();
    state.settings = s.settings;
    state.meta = s.meta;
    els.meta.textContent = metaLine(s);
    if (isCloudRuntime() && !s.cloudReady) {
      renderCloudWaiting();
      return;
    }
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
  for (const item of NAV) {
    const badge = item.badge ? h('span.badge', { text: '', hidden: true }) : null;
    const a = h('a', { href: `#${item.id}` }, h('span.label', { text: item.label }), badge);
    els.tabs.set(item.id, { a, badge, pages: item.pages, label: item.label });
    nav.append(a);
  }
  rail.append(nav);
  els.scope = scopePanel();

  const more = moreMenu();
  rail.append(h('div.rail-foot', {}, more));

  els.main = document.getElementById('view');
  els.toasts = document.getElementById('toasts');
  // 跳過連結的 href="#view" 會改到 hash，而 hash 在這個 App 是路由：
  // 原本按下去會被當成不認得的頁面送回「今天」，複習到一半的進度跟著清掉。只移焦點就好。
  document.querySelector('.skip')?.addEventListener('click', (ev) => {
    ev.preventDefault();
    els.main.focus();
  });
  document.getElementById('brand-sub').textContent = '法文複習';
}

/**
 * 側欄底部的「更多」：匯出、設定、佈景與題庫資訊。
 * 這幾樣一週用不到一次，原本常駐在側欄底部，每一頁都在分散注意力。
 */
function moreMenu() {
  const panel = h('div.menu', { id: 'more-menu', popover: 'auto' });
  const btn = h('button.rail-more', { type: 'button', text: '更多', 'aria-haspopup': 'true' });
  btn.popoverTargetElement = panel;
  els.meta = h('p.menu-meta', { text: '' });
  panel.append(
    h('div.menu-list', {},
      h('button.menu-item', { type: 'button', text: '匯出備份', onclick: () => { panel.hidePopover(); exportBackup(); } }),
      h('button.menu-item', { type: 'button', text: '設定', onclick: () => { panel.hidePopover(); openSettings(); } }),
      isCloudRuntime() ? h('button.menu-item', { type: 'button', text: '登出', onclick: () => { panel.hidePopover(); signOut(); } }) : null,
    ),
    h('hr.menu-sep'),
    h('p.scope-h', { id: 'theme-h', text: '佈景' }),
    themeSwitch(),
    h('hr.menu-sep'),
    els.meta,
  );
  anchor(panel, btn, 'up');
  document.body.append(panel);
  return btn;
}

/**
 * 把 popover 貼在觸發鈕旁邊。沒用 CSS anchor positioning：
 * 這個 App 也會在 Safari 裡開，量一次矩形比較穩。
 * up 往上開（側欄底部的選單），否則往下開、右緣對齊按鈕。
 */
function anchor(panel, btn, dir = 'down') {
  panel.addEventListener('beforetoggle', (ev) => {
    if (ev.newState !== 'open') return;
    const r = btn.getBoundingClientRect();
    const gap = 6;
    if (dir === 'up') {
      panel.style.left = `${Math.max(gap, r.left)}px`;
      panel.style.bottom = `${window.innerHeight - r.top + gap}px`;
      panel.style.top = 'auto';
      panel.style.right = 'auto';
    } else {
      panel.style.right = `${Math.max(gap, window.innerWidth - r.right)}px`;
      panel.style.top = `${r.bottom + gap}px`;
      panel.style.left = 'auto';
      panel.style.bottom = 'auto';
    }
  });
}

function renderCloudWaiting() {
  state.page = 'cloud-setup';
  els.scope.hidden = true;
  els.scope.inert = true;
  for (const { a } of els.tabs.values()) a.removeAttribute('aria-current');
  clear(els.main);
  els.main.dataset.page = 'cloud-setup';
  els.main.append(h('section.cloud-wait', {},
    h('p.eyebrow', { text: 'CLOUD READY' }),
    h('h1', { text: '登入與雲端資料庫已接通' }),
    h('p', { text: '目前仍是空庫。下一階段會先搬入題庫與複習紀錄，核對無誤後才啟用完整學習頁面。' }),
    h('div.cloud-checks', {},
      h('p', { text: '帳號驗證　已啟用' }),
      h('p', { text: '匿名存取　已封鎖' }),
      h('p', { text: '個人資料　尚未上傳' }),
    ),
  ));
  document.title = '雲端設定 · cadence';
  els.main.focus();
}

/** 從今天頁或進度頁進入實作練習，科目只活在這次瀏覽器工作階段。 */
function openPractice(skill, { guided = false } = {}) {
  if (!['CE', 'PE', 'CO', 'PO'].includes(skill)) return;
  state.practiceSkill = skill;
  state.guided = guided;
  go('practice', { force: true });
}

/** 統一處理一般複習、今日引導與弱點批次，避免各頁自己改半套狀態。 */
function startReview({ kinds = null, preset = null, guided = false } = {}) {
  if (Array.isArray(kinds)) setScope(kinds);
  state.reviewPreset = preset;
  state.guided = guided;
  go('review', { force: true });
}

function takeReviewPreset() {
  const preset = state.reviewPreset;
  state.reviewPreset = null;
  return preset;
}

/**
 * 範圍篩選。用真的 checkbox，只是把外觀換掉——
 * 自己用 div 做開關，鍵盤與螢幕閱讀器就得全部自己補，做不完也做不對。
 *
 * 面板只建一次，各頁用 scopeMenu() 借去放進自己的選單。勾選狀態因此不會跟著頁面重建而丟失。
 */
function scopePanel() {
  const box = h('div.scope');
  // 「今天」頁按下去會直接改題型範圍，勾選框得跟著動，不然選單會跟實際範圍說兩套話。
  els.toggles = new Map();
  // 這兩個字是勾選群組的名字，不是文件的一節。用 h2 的話，讀屏的標題清單會多出兩個
  // 底下沒有內文的「節」，而勾選框本身反而沒有被念出屬於哪一組。
  box.append(h('p.scope-h', { id: 'scope-kinds', text: '題型' }));
  const kinds = h('div.toggles', { role: 'group', 'aria-labelledby': 'scope-kinds' });
  for (const k of KINDS) kinds.append(toggle(k.label, 'kinds', k.id));
  box.append(kinds);

  box.append(h('p.scope-h', { id: 'scope-levels', text: '程度' }));
  const levels = h('div.toggles', { role: 'group', 'aria-labelledby': 'scope-levels' });
  for (const l of LEVELS) levels.append(toggle(l, 'levels', l));
  box.append(levels);

  els.scopeNote = h('p.scope-note', { text: '' });
  box.append(els.scopeNote);
  updateScopeNote();
  return box;
}

/**
 * 給吃範圍的頁面放在頁首的「範圍」鈕。
 * 勾選當下只記下來，選單關掉時才重畫頁面：邊勾邊重畫的話，
 * 選單會跟著頁面一起被拆掉，勾第二個就得再打開一次。
 */
function scopeMenu() {
  const panel = h('div.menu', { popover: 'auto' }, els.scope);
  const label = h('span', { text: scopeLabel() });
  const btn = h('button.btn.btn-sm.scope-btn', { type: 'button', 'aria-haspopup': 'true' }, '範圍：', label);
  btn.popoverTargetElement = panel;
  if (isNarrowed()) btn.dataset.narrowed = '';
  anchor(panel, btn, 'down');
  const before = JSON.stringify(state.scope);
  panel.addEventListener('toggle', (ev) => {
    if (ev.newState !== 'closed') return;
    if (JSON.stringify(state.scope) === before) return;
    refreshBadge();
    // 複習頁換範圍就是整批重抓，正在看的那張卡會直接換掉；不說一聲會像是卡被跳過了。
    if (state.page === 'review') toast('已換範圍，這一批卡依新範圍重抓');
    go(state.page, { force: true });
  });
  document.body.append(panel);
  // 頁面換掉時選單也要跟著走，不然 body 底下會積一疊沒有主人的 popover。
  els.popovers.push(panel);
  return btn;
}

function isNarrowed() {
  return state.scope.kinds.length > 0 || state.scope.levels.length > 0;
}

function scopeLabel() {
  const { kinds, levels } = state.scope;
  if (!isNarrowed()) return '全部';
  const k = kinds.length === 1 ? KINDS.find((x) => x.id === kinds[0]).label : kinds.length ? `${kinds.length} 種題型` : null;
  return [k, levels.length ? levels.join('／') : null].filter(Boolean).join('・');
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
    ? '都不勾就是全部題型與程度。'
    : `只練 ${[kinds.length ? `${kinds.length} 種題型` : null, levels.length ? levels.join('／') : null].filter(Boolean).join('・')}。關掉選單後套用。`;
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

/**
 * 網址對應到哪一頁。`#/review` 這種常見寫法也認。
 * 認不得時留在目前這一頁，只有剛開啟、還沒有目前頁時才落到第一頁——
 * 退回「今天」會重畫整個檢視，複習頁手上的佇列與打到一半的答案都會不見。
 */
function hashPage() {
  const id = location.hash.replace(/^#\/?/, '');
  if (PAGES.some((p) => p.id === id)) return id;
  return state.page ?? PAGES[0].id;
}

function go(id, { force = false } = {}) {
  const page = PAGES.find((p) => p.id === id) ?? PAGES[0];
  if (!force && state.page === page.id) return;
  if (location.hash !== `#${page.id}`) location.hash = page.id;

  if (typeof state.cleanup === 'function') state.cleanup();
  state.cleanup = null;
  state.page = page.id;

  for (const { a, pages } of els.tabs.values()) {
    if (pages.includes(page.id)) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  document.title = `${page.label} · cadence`;
  // 上一頁借走的範圍面板先收回來，popover 本身丟掉。
  for (const p of els.popovers) p.remove();
  els.popovers = [];
  setFocus(false);

  // 上一頁留在 live region 的句子（例如批改結果）不清掉，讀屏換頁後可能再念一次。
  announce('');
  clear(els.main);
  // 每個檢視都需要一個頁面主標題；視覺層級由各頁自己的內容承擔，所以只供讀屏與文件大綱使用。
  els.main.append(h('h1.sr', { text: page.label }));
  state.cleanup = page.view(els.main, ctx) ?? null;
  els.main.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

/** 專注模式：導覽整條收起來。只有複習頁在出卡時會開。 */
function setFocus(on) {
  if (on) document.body.dataset.focus = '';
  else delete document.body.dataset.focus;
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
  entry.badge.textContent = due > 999 ? '999+' : due.toLocaleString('zh-Hant');
  entry.badge.hidden = !due;
  entry.a.setAttribute('aria-label', due ? `複習，${due} 張到期` : '複習');
}

function metaLine(summary) {
  const total = summary.totalCards ?? 0;
  const local = summary.backup?.uncommittedFacts;
  const remote = summary.backup?.unpublishedFacts;
  const backup = remote === 0
    ? '紀錄已推送'
    : Number.isInteger(remote)
      ? `${Number.isInteger(local) && local > 0 ? `${local} 未提交・` : ''}${remote} 未推送`
      : Number.isInteger(local) && local > 0 ? `${local} 筆未提交` : null;
  return [`A2–B1・${total.toLocaleString('zh-Hant')} 張`, backup]
    .filter(Boolean).join('・');
}

async function exportBackup() {
  try {
    const data = await api.backup();
    const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: 'application/json' });
    const href = URL.createObjectURL(blob);
    const link = h('a', { href, download: `cadence-backup-${data.exportedAt.slice(0, 10)}.json` });
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(href);
    toast('備份已下載', 'ok');
  } catch (err) {
    toast(`匯出失敗：${err.message}`, 'bad');
  }
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

  // 上限存成 null 代表不設上限。數字框留著、只是停用，取消勾選時回到原本的數，不必重打。
  const noCapNow = state.settings.dailyNewLimit === null;
  const fresh = h('input.input', {
    type: 'number', min: '0', max: '200', step: '1',
    value: String(state.settings.dailyNewLimit ?? 15),
    disabled: noCapNow,
  });
  const noCap = h('input', { type: 'checkbox', checked: noCapNow });
  noCap.addEventListener('change', () => { fresh.disabled = noCap.checked; });
  const freshRow = h('div.range-row', {},
    fresh,
    h('label.inline-check', {}, noCap, h('span', { text: '不設上限' })),
  );

  const exam = h('input.input', { type: 'date', value: state.settings.examDate ?? '' });

  const err = h('p.field-error', { text: '', hidden: true });
  const form = h('form.sheet-body', { method: 'dialog' },
    h('h2', { text: '設定' }),

    field('目標記憶率', h('div.range-row', {}, retention, retOut),
      '排程要維持的答對率。調高，複習更密、量更大；調低，省時間但忘得多。FSRS 預設 0.90。'),

    field('每天新卡上限', freshRow,
      '一天最多學幾張新卡。學過的卡之後幾週都會回來，不設上限時到期量會跟著變大；會多多少，「進度 › 推演」算得出來。'),

    field('考試日期', exam,
      '「進度 › 推演」的預設日期。還沒報名就留空。'),

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
        dailyNewLimit: noCap.checked ? null : Number(fresh.value),
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

function themeSwitch() {
  const modes = [['auto', '跟隨系統'], ['light', '淺色'], ['dark', '深色']];
  const box = h('div.seg', { role: 'group', 'aria-labelledby': 'theme-h' });
  const paint = () => {
    const now = document.documentElement.dataset.theme ?? 'auto';
    for (const b of box.children) b.setAttribute('aria-pressed', String(b.dataset.mode === now));
  };
  for (const [mode, label] of modes) {
    box.append(h('button', {
      type: 'button', text: label, dataset: { mode },
      onclick: () => {
        if (mode === 'auto') delete document.documentElement.dataset.theme;
        else document.documentElement.dataset.theme = mode;
        try { localStorage.setItem(THEME_KEY, mode); } catch { /* 寫不進去只是下次回到跟隨系統，不影響資料 */ }
        paint();
      },
    }));
  }
  paint();
  return box;
}

/**
 * 提示條。只用在「操作結果」與錯誤，不用在慶祝。
 * aria-live 用 polite，不打斷螢幕閱讀器正在念的批改結果。
 */
function toast(message, tone = 'info', action = null) {
  const node = h('div.toast', { dataset: { tone }, role: 'status' },
    tone === 'bad' ? icon('alert') : null,
    h('span', { text: message }),
    action
      ? h('button.btn.btn-quiet.btn-sm', {
        type: 'button',
        text: action.label,
        onclick: () => { node.remove(); action.run(); },
      })
      : null);
  els.toasts.append(node);
  // 帶按鈕的提示要留得夠久才按得到；滑鼠或焦點還停在上面時不收，否則會在按下去前消失。
  const close = () => {
    if (node.matches(':hover, :focus-within')) setTimeout(close, 1000);
    else node.remove();
  };
  setTimeout(close, action ? 10000 : 4200);
}
