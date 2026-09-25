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
 */
// 相對路徑：瀏覽器解析成 /vendor/，Node 跑測試時也找得到同一份檔。
// practice.mjs 的 countWords 有單元測試，會把這支一起載進 Node，那邊沒有 matchMedia。
import { gsap } from '../vendor/gsap.mjs';

export const REDUCE = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? true;

const fmt = new Intl.NumberFormat('zh-Hant');

/** 取 token 的實際色值，給 GSAP 補間用。 */
function token(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** 數字從 0 滾到 to。el 的文字最後一定是 to 的格式化結果，動畫中斷也一樣。 */
export function countUp(el, to, { delay = 0, duration = 1.4 } = {}) {
  if (!el) return;
  const done = () => { el.textContent = fmt.format(to); };
  if (REDUCE || !to) { done(); return; }
  const o = { v: 0 };
  el.textContent = fmt.format(0);
  gsap.to(o, {
    v: to, duration, delay, ease: 'power3.out',
    onUpdate: () => { el.textContent = fmt.format(Math.round(o.v)); },
    onComplete: done,
  });
}

/** 一組元素依序浮上來。頁面進場用。 */
export function rise(targets, { y = 12, stagger = 0.06, delay = 0, duration = 0.5 } = {}) {
  const list = [...targets].filter(Boolean);
  if (REDUCE || !list.length) return;
  gsap.from(list, { y, opacity: 0, duration, stagger, delay, ease: 'power2.out', clearProps: 'transform,opacity' });
}

/** 橫條從左邊長出來。統計條、摘要的評分比例條用。 */
export function grow(targets, { delay = 0, stagger = 0.04, duration = 0.9 } = {}) {
  const list = [...targets].filter(Boolean);
  if (REDUCE || !list.length) return;
  gsap.from(list, { scaleX: 0, transformOrigin: 'left center', duration, stagger, delay, ease: 'power3.out', clearProps: 'transform' });
}

/** 打卡的章：大而斜地落下，停在 -7 度；整列底色閃一下強調色再退掉。 */
export function stamp(el, row) {
  if (REDUCE || !el) return;
  gsap.fromTo(el,
    { scale: 1.8, opacity: 0, rotate: -16 },
    { scale: 1, opacity: 1, rotate: -7, duration: 0.42, ease: 'back.out(2.2)' });
  if (row) {
    gsap.fromTo(row,
      { backgroundColor: token('--accent-weak') },
      { backgroundColor: 'rgba(0,0,0,0)', duration: 1.2, delay: 0.2, clearProps: 'backgroundColor' });
  }
}

/**
 * 批改結果：答案逐字浮出，錯的字抖一下，最後帶出其餘元素（你寫的、評分鈕）。
 * letters 是比對結果的每個字母 span，錯的帶 .bad。
 */
export function revealGrade(letters, rest = []) {
  const spans = [...letters];
  const after = [...rest].filter(Boolean);
  if (REDUCE || !spans.length) return;
  const tl = gsap.timeline();
  tl.from(spans, { y: 14, opacity: 0, duration: 0.32, stagger: 0.035, ease: 'power2.out', clearProps: 'transform,opacity' });
  const bad = spans.filter((x) => x.classList.contains('bad'));
  if (bad.length) tl.to(bad, { keyframes: { x: [0, -5, 5, -3, 3, 0] }, duration: 0.4, ease: 'none', clearProps: 'transform' }, '-=0.05');
  if (after.length) tl.from(after, { opacity: 0, y: 6, duration: 0.3, stagger: 0.04, clearProps: 'transform,opacity' }, '-=0.15');
}

/**
 * 換卡：舊卡往左滑出、swap() 換內容、新卡從右滑入。
 * 回傳 Promise，呼叫端可以等換完再移焦點，免得焦點落在正要被拆掉的元素上。
 */
export function slideCard(el, swap) {
  if (REDUCE || !el) { swap(); return Promise.resolve(); }
  return new Promise((resolve) => {
    gsap.timeline({ onComplete: resolve })
      .to(el, { x: -48, opacity: 0, duration: 0.2, ease: 'power2.in' })
      .add(swap)
      .fromTo(el, { x: 48, opacity: 0 }, { x: 0, opacity: 1, duration: 0.38, ease: 'power3.out', clearProps: 'transform,opacity' });
  });
}

/** 進度條寬度。 */
export function progress(el, ratio) {
  if (!el) return;
  const w = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
  if (REDUCE) { el.style.width = w; return; }
  gsap.to(el, { width: w, duration: 0.5, ease: 'power2.out' });
}

/**
 * 摘要畫面：標題、大數字、比例條、圖例、下一步依序出現。
 * parts 的每一項都可以是 null，缺的就跳過，時間軸不會因此錯位。
 */
export function introSummary({ kicker, number, to, cap, bars, legend, tail }) {
  countUp(number, to, { delay: 0.15 });
  if (REDUCE) return;
  const tl = gsap.timeline();
  const step = (targets, vars, at) => {
    const list = [targets].flat().filter(Boolean);
    if (list.length) tl.from(list, { ...vars, clearProps: 'transform,opacity' }, at);
  };
  step(kicker, { opacity: 0, y: 10, duration: 0.5, ease: 'power2.out' }, 0);
  step(cap, { opacity: 0, duration: 0.4 }, 0.9);
  step(bars ? [...bars] : null, { scaleX: 0, transformOrigin: 'left center', duration: 0.55, stagger: 0.12, ease: 'power3.out' }, 1.0);
  step(legend ? [...legend] : null, { opacity: 0, y: 6, duration: 0.3, stagger: 0.08 }, 1.2);
  step(tail ? [...tail] : null, { opacity: 0, y: 8, duration: 0.4, stagger: 0.1 }, 1.6);
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
