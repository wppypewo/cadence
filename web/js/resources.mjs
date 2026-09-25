/**
 * B2 外部資源入口。資料由雲端資料庫提供，畫面只負責把「拿來做什麼」說清楚。
 * 連結全部留在原站，不鏡像、不嵌入，也不把對方內容假裝成 cadence 自有題庫。
 */

import { h, clear, icon } from './dom.mjs';
import { api } from './net.mjs';

const SKILLS = {
  CE: '閱讀',
  PE: '寫作',
  CO: '聽力',
  PO: '口說',
};

export function resourcesView(root, ctx) {
  const box = h('div.resources-page');
  root.append(box);
  box.append(skeleton());
  let dead = false;
  load();
  return () => { dead = true; };

  async function load() {
    try {
      const data = await api.resources();
      if (dead) return;
      render(box, data, ctx);
    } catch (err) {
      if (dead) return;
      clear(box).append(h('div.card.errorbox', {}, icon('alert'), h('p', { text: err.message })));
    }
  }
}

function skeleton() {
  return h('div.resource-loading', { 'aria-label': '正在載入 B2 資源' },
    h('div.skeleton', { style: 'height: 16px; width: 88px' }),
    h('div.skeleton', { style: 'height: 64px; width: min(560px, 90%)' }),
    h('div.skeleton', { style: 'height: 220px; width: 100%' }),
  );
}

function render(box, data, ctx) {
  const rows = Array.isArray(data.resources) ? data.resources : [];
  clear(box);
  box.append(
    h('header.resource-hero', {},
      h('div.resource-kicker', {},
        h('span.level-stamp', { text: 'B2' }),
        h('span', { text: 'OBJECTIF INDÉPENDANT' })),
      h('h2', {}, '把法文用到', h('em', { lang: 'fr', text: '真正能溝通' }), '的程度。'),
      h('p', { text: '這裡不堆連結。每一個來源都標明最適合練什麼、怎麼排進一週，以及最後查證日期。' }),
      h('div.resource-meta', {},
        h('span', { text: `${rows.length} 個免費來源` }),
        h('span', { text: '四科都有入口' }),
        h('span', { text: data.checkedAt ? `查證 ${data.checkedAt}` : '等待查證日期' }),
      ),
    ),
    journey(),
    weeklyPlan(ctx),
  );

  if (!rows.length) {
    box.append(h('div.card.empty', {}, icon('library'), h('p', { text: '目前沒有啟用中的 B2 資源。' })));
    return;
  }

  const filters = h('div.resource-filters', { role: 'group', 'aria-label': '依能力篩選資源' });
  const list = h('div.resource-list');
  let active = 'ALL';
  const buttons = new Map();
  const paint = () => {
    list.replaceChildren(...rows
      .filter((row) => active === 'ALL' || skillsFor(row).includes(active))
      .map((row, index) => resourceCard(row, index)));
    for (const [id, button] of buttons) button.setAttribute('aria-pressed', String(id === active));
  };
  for (const [id, label] of [['ALL', '全部'], ...Object.entries(SKILLS)]) {
    const button = h('button.filter-pill', {
      type: 'button', text: label, 'aria-pressed': String(id === active),
      onclick: () => { active = id; paint(); },
    });
    buttons.set(id, button);
    filters.append(button);
  }
  box.append(h('section.resource-library', {},
    h('div.resource-section-head', {},
      h('div', {}, h('p.eyebrow', { text: 'CURATED LIBRARY' }), h('h2', { text: '已查證的免費資源' })),
      filters),
    list,
  ));
  paint();
}

function weeklyPlan(ctx) {
  const sessions = [
    ['週一', 'CE', '讀一篇，寫三句摘要', '30 分鐘', () => ctx.openPractice('CE')],
    ['週二', 'CO', '盲聽、對稿、口頭摘要', '25 分鐘', () => ctx.openPractice('CO')],
    ['週四', 'PE', '限時完成一篇立場文', '45 分鐘', () => ctx.openPractice('PE')],
    ['週六', 'PO', '錄一段立論與追問', '20 分鐘', () => ctx.openPractice('PO')],
  ];
  return h('section.week-plan', { 'aria-labelledby': 'week-plan-title' },
    h('div.week-plan-head', {},
      h('div', {},
        h('p.eyebrow', { text: 'THIS WEEK' }),
        h('h2#week-plan-title', { text: '一週四次，把輸入變成輸出。' }),
        h('p', { text: '每次只做一件完整任務；工作台會保留時間、來源、字數與自評分數。' }),
      ),
      h('button.btn', { type: 'button', text: '每四週記一次模考', onclick: () => ctx.go('mock') }),
    ),
    h('ol.week-sessions', {}, sessions.map(([day, skill, title, time, start]) => h('li', {},
      h('div.session-day', {}, h('span', { text: day }), h('strong', { text: skill })),
      h('div.session-copy', {}, h('h3', { text: title }), h('p.num', { text: time })),
      h('button.btn.btn-primary.btn-sm', { type: 'button', text: '開始', onclick: start, 'aria-label': `開始 ${skill}：${title}` }),
    ))),
  );
}

function journey() {
  const steps = [
    ['01', '輸入', '每週兩次聽讀', 'TV5MONDE、RFI，把真實語速拆成可重做的練習。'],
    ['02', '輸出', '每週一篇一講', '寫作與口說依 DELF 格式計時，留下可比較的紀錄。'],
    ['03', '校準', '每四週一次模考', '用官方題型與 CEFR 自評表找下一輪最弱的一科。'],
  ];
  return h('section.b2-journey', { 'aria-labelledby': 'journey-title' },
    h('div.journey-intro', {},
      h('p.eyebrow', { text: 'B1 → B2' }),
      h('h2#journey-title', { text: '不是看完，是反覆做出來。' }),
      h('p', { text: 'B2 要求你理解較複雜的內容，也能清楚表達立場。資源依「輸入、輸出、校準」三段安排。' }),
    ),
    h('ol.journey-steps', {}, steps.map(([n, title, rhythm, copy]) => h('li', {},
      h('span.step-no.num', { text: n }),
      h('div', {}, h('h3', { text: title }), h('p.step-rhythm', { text: rhythm }), h('p', { text: copy })),
    ))),
  );
}

function resourceCard(row, index) {
  const p = row.payload ?? {};
  const skills = skillsFor(row);
  const url = safeExternalUrl(row.url);
  const link = h('a.resource-link', {
    href: url, target: '_blank', rel: 'noopener noreferrer',
    'aria-label': `前往 ${row.title}（另開新分頁）`,
  }, h('span', { text: '前往原站' }), icon('arrow'));
  return h('article.resource-card', { dataset: { featured: String(Boolean(p.featured)), order: String(index + 1) } },
    h('div.resource-card-top', {},
      h('div.resource-source', {},
        h('span.resource-index.num', { text: String(index + 1).padStart(2, '0') }),
        h('span', { text: row.source_name })),
      h('div.resource-skills', {}, skills.map((skill) => h('span.chip', { text: SKILLS[skill] ?? skill }))),
    ),
    h('div.resource-card-body', {},
      h('div', {},
        h('h3', { text: row.title }),
        h('p.resource-description', { text: p.description ?? '' }),
      ),
      h('dl.resource-notes', {},
        detail('最適合', p.bestFor),
        detail('建議節奏', p.cadence),
        detail('形式', p.format),
      ),
    ),
    h('footer.resource-card-foot', {},
      h('p', { text: `${row.level}・${row.license_note}・查證 ${row.checked_at}` }),
      url ? link : null,
    ),
  );
}

function detail(term, value) {
  return value ? [h('dt', { text: term }), h('dd', { text: value })] : null;
}

function skillsFor(row) {
  const raw = Array.isArray(row.payload?.skills) ? row.payload.skills : [row.skill];
  return raw.filter((skill) => SKILLS[skill]);
}

/** 即使資料庫內容遭誤改，也不能把 javascript: 之類的網址變成可點連結。 */
function safeExternalUrl(value) {
  try {
    const url = new URL(String(value));
    return ['https:', 'http:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}
