/**
 * 招牌動作。每頁最多三個，其餘狀態變化交給 CSS 的 160ms 過渡。
 *
 * 用 GSAP（web/vendor/gsap.mjs，3.15.0，Standard no-charge 授權）而不是 CSS keyframes，
 * 是因為這幾個動作都要串接：先逐字浮出、再抖錯字、再帶出評分鈕，CSS 要靠一串 delay 硬對時間。
 *
 * 規則：
 *   - prefers-reduced-motion 時一律直接跳到終點，不做任何位移或淡入。
 *   - GSAP 不能補間 var()，顏色要先用 getComputedStyle 取出實際值。
 *   - from() 被中斷會停在半路，下一輪再播會把半路當成終點；所以每個 from 都帶 clearProps。
 *   - 曲線與時長只用下面的 EASE、DUR，和 tokens.css 的 --ease-out／--dur-in／--dur-out 同一套：
 *     進場減速、離場加速且比進場短；同一頁反覆做的操作（換卡、翻面）用最短的那一級。
 *   - 只補間 transform 與 opacity。寬度、高度會觸發重排，長頁面掉幀。
 */
// 相對路徑：瀏覽器解析成 /vendor/，Node 跑測試時也找得到同一份檔。
// practice.mjs 的 countWords 有單元測試，會把這支一起載進 Node，那邊沒有 matchMedia。
import { gsap } from '../vendor/gsap.mjs';

// 用 let 加 change 監聽，不在載入時讀一次就定死：系統設定裡切換「減少動態效果」之後，
// 這個 App 常常整天開著不重新整理，只讀一次的話要等下次重開才生效。
// ESM 的 export let 是活的綁定，其他模組 import 到的會跟著變。已經在播的補間不追回，最長 0.5 秒。
const reduceQuery = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
export let REDUCE = reduceQuery?.matches ?? true;
reduceQuery?.addEventListener?.('change', (ev) => { REDUCE = ev.matches; });

/** 曲線：enter 對應 CSS 的 --ease-out，exit 是加速離開。 */
const EASE = { enter: 'power3.out', exit: 'power2.in' };
/** 時長（秒）。in／out 與 tokens.css 的 --dur-in／--dur-out 相同。 */
const DUR = { in: 0.16, out: 0.1, settle: 0.24, grow: 0.45, count: 0.5 };

const fmt = new Intl.NumberFormat('zh-Hant');

/** 取 token 的實際色值，給 GSAP 補間用。 */
function token(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** 錯開的間隔：整組錯開總長不超過 cap 秒，長清單不會拖成一條慢動作。 */
function each(n, stagger, cap = 0.24) {
  return n > 1 ? Math.min(stagger, cap / (n - 1)) : 0;
}

/**
 * 數字從 0 滾到 to。只給「剛算出來的結果」用（交卷分數、預測結論），
 * 常駐的數字（倒數天數、統計頁的累計）直接顯示，每次進頁都滾一遍只是在拖時間。
 * el 的文字最後一定是 to 的格式化結果，動畫中斷也一樣。
 */
export function countUp(el, to, { delay = 0, duration = DUR.count } = {}) {
  if (!el) return;
  const done = () => { el.textContent = fmt.format(to); };
  if (REDUCE || !to) { done(); return; }
  const o = { v: 0 };
  el.textContent = fmt.format(0);
  gsap.to(o, {
    v: to, duration, delay, ease: EASE.enter,
    onUpdate: () => { el.textContent = fmt.format(Math.round(o.v)); },
    onComplete: done,
  });
}

/** 一組元素依序浮上來。只用在「使用者這一下操作帶出來的新東西」，例如翻面後的答案與評分鈕。 */
export function rise(targets, { y = 6, stagger = 0.04, delay = 0, duration = DUR.settle } = {}) {
  const list = [...targets].filter(Boolean);
  if (REDUCE || !list.length) return;
  gsap.from(list, {
    y, opacity: 0, duration, delay, ease: EASE.enter,
    stagger: each(list.length, stagger), clearProps: 'transform,opacity',
  });
}

/**
 * 資料到了、骨架換成內容：整塊只淡入，不位移、不錯開。
 * 換頁本身已經有 pageIn 的 4px 位移，這裡再浮一次就會疊成兩段。
 */
export function swapIn(targets) {
  const list = [targets].flat().filter(Boolean);
  if (REDUCE || !list.length) return;
  gsap.from(list, { opacity: 0, duration: DUR.settle, ease: EASE.enter, clearProps: 'opacity' });
}

/** 換頁：新頁主容器淡入、上移 4px。舊頁直接拆掉，不等它離場。 */
export function pageIn(el) {
  if (REDUCE || !el) return;
  gsap.fromTo(el, { opacity: 0, y: 4 }, {
    opacity: 1, y: 0, duration: DUR.in, ease: EASE.enter, overwrite: true, clearProps: 'transform,opacity',
  });
}

/** 橫條從左邊長出來。統計條、摘要的評分比例條用。 */
export function grow(targets, { delay = 0, stagger = 0.04, duration = DUR.grow } = {}) {
  const list = [...targets].filter(Boolean);
  if (REDUCE || !list.length) return;
  gsap.from(list, {
    scaleX: 0, transformOrigin: 'left center', duration, delay, ease: EASE.enter,
    stagger: each(list.length, stagger), clearProps: 'transform',
  });
}

/**
 * 打卡的章：略大、略斜地落下，停在 CSS 給的 -7 度；整列底色閃一下強調色再退掉。
 * GSAP 會把 CSS 的 rotate 屬性併進它自己的 transform（inline 設 rotate:none），所以這裡寫的是絕對角度，
 * 終點要和 views.css 的 -7deg 一致；播完 clearProps 拿掉 inline，交回 CSS，不會跳。
 */
export function stamp(el, row) {
  if (REDUCE || !el) return;
  gsap.fromTo(el,
    { scale: 1.3, opacity: 0, rotation: -12 },
    { scale: 1, opacity: 1, rotation: -7, duration: 0.22, ease: 'back.out(1.4)', clearProps: 'transform,opacity' });
  if (row) {
    gsap.fromTo(row,
      { backgroundColor: token('--accent-weak') },
      { backgroundColor: 'rgba(0,0,0,0)', duration: 0.6, delay: 0.12, ease: EASE.enter, clearProps: 'backgroundColor' });
  }
}

/**
 * 批改結果：答案逐字浮出，錯的字抖一下，最後帶出其餘元素（你寫的、評分鈕）。
 * letters 是比對結果的每個字母 span，錯的帶 .bad。逐字的總長封頂 0.3 秒，長句不會念經。
 */
export function revealGrade(letters, rest = []) {
  const spans = [...letters];
  const after = [...rest].filter(Boolean);
  if (REDUCE || !spans.length) return;
  const tl = gsap.timeline();
  tl.from(spans, {
    y: 8, opacity: 0, duration: 0.2, stagger: each(spans.length, 0.03, 0.3), ease: EASE.enter, clearProps: 'transform,opacity',
  });
  const bad = spans.filter((x) => x.classList.contains('bad'));
  if (bad.length) tl.to(bad, { keyframes: { x: [0, -4, 4, -2, 2, 0] }, duration: 0.32, ease: 'none', clearProps: 'transform' }, '-=0.05');
  if (after.length) {
    tl.from(after, {
      opacity: 0, y: 6, duration: DUR.settle, stagger: each(after.length, 0.04), ease: EASE.enter, clearProps: 'transform,opacity',
    }, '-=0.15');
  }
}

/**
 * 換卡：舊卡往左滑出、swap() 換內容、新卡從右滑入。
 * 回傳 Promise，呼叫端可以等換完再移焦點，免得焦點落在正要被拆掉的元素上。
 * 換卡一輪要做幾十次，所以位移只有 24px、全程 0.34 秒；滑動中再按一次用 finishSlide 直接跳到終點。
 */
export function slideCard(el, swap) {
  if (REDUCE || !el) { swap(); return Promise.resolve(); }
  return new Promise((resolve) => {
    el.slideTl = gsap.timeline({ onComplete: () => { el.slideTl = null; resolve(); } })
      .to(el, { x: -24, opacity: 0, duration: 0.12, ease: EASE.exit })
      .add(swap)
      // fromTo 放進時間軸預設 immediateRender：建立當下就把卡片打到 x24、透明，滑出那段整個看不見。
      .fromTo(el, { x: 24, opacity: 0 }, { x: 0, opacity: 1, duration: 0.22, ease: EASE.enter, immediateRender: false, clearProps: 'transform,opacity' });
  });
}

/** 換卡動畫還在播就直接播完（swap 會在這一刻執行）。沒有在播就什麼都不做。 */
export function finishSlide(el) {
  el?.slideTl?.progress(1);
}

/** 進度條。用 scaleX，不動 width：width 每一幀都要重排整個出卡區。 */
export function progress(el, ratio) {
  if (!el) return;
  const r = Math.max(0, Math.min(1, ratio));
  if (REDUCE) { gsap.set(el, { scaleX: r, transformOrigin: 'left center' }); return; }
  gsap.to(el, { scaleX: r, transformOrigin: 'left center', duration: 0.3, ease: EASE.enter, overwrite: true });
}

/**
 * 摘要畫面：標題、大數字、比例條、圖例、下一步依序出現。
 * 全部在 0.4 秒內開始，0.7 秒內落定：這是剛做完一輪的結果，使用者在等，不是在看片頭。
 * parts 的每一項都可以是 null，缺的就跳過，時間軸不會因此錯位。
 */
export function introSummary({ kicker, number, to, cap, bars, legend, tail }) {
  countUp(number, to, { delay: 0.05 });
  if (REDUCE) return;
  const tl = gsap.timeline();
  const step = (targets, vars, at) => {
    const list = [targets].flat().filter(Boolean);
    if (list.length) tl.from(list, { ease: EASE.enter, ...vars, clearProps: 'transform,opacity' }, at);
  };
  step(kicker, { opacity: 0, y: 6, duration: DUR.settle }, 0);
  step(cap, { opacity: 0, duration: DUR.settle }, 0.15);
  const barList = bars ? [...bars] : [];
  step(barList, { scaleX: 0, transformOrigin: 'left center', duration: DUR.grow, stagger: each(barList.length, 0.06, 0.12) }, 0.2);
  const legendList = legend ? [...legend] : [];
  step(legendList, { opacity: 0, y: 4, duration: DUR.settle, stagger: each(legendList.length, 0.04, 0.08) }, 0.3);
  const tailList = tail ? [...tail] : [];
  step(tailList, { opacity: 0, y: 6, duration: DUR.settle, stagger: each(tailList.length, 0.05, 0.1) }, 0.4);
}

/** 捲進畫面才播。沒捲到就播完的動畫等於沒有。 */
export function onView(el, fn, threshold = 0.35) {
  if (!el) return () => {};
  if (REDUCE || !('IntersectionObserver' in window)) { fn(); return () => {}; }
  const io = new IntersectionObserver((entries) => {
    if (entries.some((x) => x.isIntersecting)) { io.disconnect(); fn(); }
  }, { threshold });
  io.observe(el);
  return () => io.disconnect();
}

/** 換頁時把還在跑的補間收掉，免得對已經被拆掉的節點繼續寫樣式。 */
export function killWithin(root) {
  if (!root) return;
  gsap.killTweensOf(root.querySelectorAll('*'));
}
