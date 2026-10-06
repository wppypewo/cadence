/**
 * 外部資源入口。資料由雲端資料庫提供，畫面只負責把「拿來做什麼」說清楚。
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
      clear(box).append(h('div.card.errorbox', {},
        icon('alert'),
        h('p', { text: `讀不到資源清單：${err.message}` }),
        h('button.btn', { type: 'button', text: '再試一次', onclick: () => { clear(box).append(skeleton()); load(); } }),
      ));
    }
  }
}

function skeleton() {
  // 形狀照最後的版面：頁首一條、三節各一個標題加幾列。
  const box = h('div.resource-loading', { 'aria-busy': 'true', 'aria-label': '正在載入資源' });
  for (const [w, hh] of [['40%', 36], ['100%', 1], ['70%', 18], ['100%', 160], ['100%', 260]]) {
    const bar = h('div.skeleton');
    bar.style.width = w;
    bar.style.height = `${hh}px`;
    box.append(bar);
  }
  return box;
}

/*
 * 版面跟其他頁同一套：頁首一條實線、各節靠頂線分開、列與列之間一條細線。
 * 舊版是一張漸層大卡加浮水印「B2」、反白的週計畫、圓角卡片牆，自成一個視覺世界，
 * 從今天頁點過來像換了一個網站。這一頁的內容是清單與時程，用帳本的排法就讀得清楚。
 */
function render(box, data, ctx) {
  const rows = Array.isArray(data.resources) ? data.resources : [];
  const meta = [`${rows.length} 個免費來源`, '四科都有入口', data.checkedAt ? `${data.checkedAt} 查證` : '尚未記錄查證日期'];
  clear(box).append(
    h('header.page-head', {},
      h('div', {},
        h('h1', { text: '資源' }),
        h('p', { text: meta.join('・') }))),
    h('p.res-lead', { text: '這裡不堆連結。每一個來源都標明最適合練什麼、怎麼排進一週，以及最後查證日期。連結都留在原站，不鏡像、不嵌入。' }),
    journey(),
    weeklyPlan(ctx),
  );

  if (!rows.length) {
    box.append(h('div.empty', {}, icon('library'), h('p', { text: '目前沒有啟用中的資源。' })));
    return;
  }

  const filters = h('div.seg.res-filter', { role: 'group', 'aria-label': '依能力篩選資源' });
  const list = h('div.res-list');
  let active = 'ALL';
  const buttons = new Map();
  const paint = () => {
    const shown = rows.filter((row) => active === 'ALL' || skillsFor(row).includes(active));
    list.replaceChildren(...shown.map(resourceRow));
    for (const [id, button] of buttons) button.setAttribute('aria-pressed', String(id === active));
  };
  for (const [id, label] of [['ALL', '全部'], ...Object.entries(SKILLS)]) {
    const button = h('button', {
      type: 'button', text: label, 'aria-pressed': String(id === active),
      onclick: () => { active = id; paint(); },
    });
    buttons.set(id, button);
    filters.append(button);
  }
  box.append(block('已查證的免費資源', '每個來源寫明拿來練什麼、多久用一次。', list, filters));
  paint();
}

/** 一節：頂線、標題、一句說明、右邊可放一個控制項。跟進度頁的 section() 同一個樣子。 */
function block(title, why, body, action = null) {
  return h('section.sec.res-sec', {},
    h('header.sec-head', {},
      h('h2', { text: title }),
      why ? h('p.sec-why', { text: why }) : null,
      action ? h('div.sec-act', {}, action) : null),
    body);
}

function weeklyPlan(ctx) {
  const sessions = [
    ['週一', 'CE', '讀一篇，寫三句摘要', '30 分鐘'],
    ['週二', 'CO', '盲聽、對稿、口頭摘要', '25 分鐘'],
    ['週四', 'PE', '限時完成一篇立場文', '45 分鐘'],
    ['週六', 'PO', '錄一段立論與追問', '20 分鐘'],
  ];
  // 這一頁不放實心鍵：全站唯一的實心鍵在今天頁，這裡四顆「開始」並排，實心只會互相搶。
  const list = h('ol.res-week', {}, sessions.map(([day, skill, title, time]) => h('li', {},
    h('span.res-day', { text: day }),
    h('span.lrow-code', { text: skill }),
    h('span.res-task', { text: title }),
    h('span.res-time.num', { text: time }),
    h('button.btn.btn-sm', {
      type: 'button', text: '開始', onclick: () => ctx.openPractice(skill),
      'aria-label': `開始 ${skill}：${title}`,
    }),
  )));
  const mock = h('button.btn.btn-sm', { type: 'button', text: '每四週記一次模考', onclick: () => ctx.go('mock') });
  return block('一週四次', '每次只做一件完整任務；工作台會保留時間、來源、字數與自評分數。', list, mock);
}

function journey() {
  const steps = [
    ['輸入', '每週兩次聽讀', 'TV5MONDE、RFI，把真實語速拆成可重做的練習。'],
    ['輸出', '每週一篇一講', '寫作與口說依 DELF 格式計時，留下可比較的紀錄。'],
    ['校準', '每四週一次模考', '用官方題型與 CEFR 自評表找下一輪最弱的一科。'],
  ];
  const list = h('ol.res-steps', {}, steps.map(([title, rhythm, copy]) => h('li', {},
    h('h3', { text: title }),
    h('p.res-rhythm', { text: rhythm }),
    h('p.res-copy', { text: copy }),
  )));
  return block('輸入、輸出、校準', 'B1 要求聽讀懂熟悉主題的重點，也能簡短說明理由與看法。', list);
}

function resourceRow(row) {
  const p = row.payload ?? {};
  const skills = skillsFor(row);
  const url = safeExternalUrl(row.url);
  const link = url
    ? h('a.resource-link', {
      href: url, target: '_blank', rel: 'noopener noreferrer',
      'aria-label': `前往 ${row.title}（另開新分頁）`,
    }, h('span', { text: '前往原站' }), icon('arrow'))
    : null;
  return h('article.res-row', {},
    h('div.res-main', {},
      h('p.res-source', {},
        h('span', { text: row.source_name }),
        h('span.res-skills', { text: skills.map((skill) => SKILLS[skill] ?? skill).join('・') })),
      h('h3', { text: row.title }),
      p.description ? h('p.res-desc', { text: p.description }) : null,
      h('p.res-meta', { text: `${row.level}・${row.license_note}・${row.checked_at} 查證` })),
    h('dl.resource-notes', {},
      detail('最適合', p.bestFor),
      detail('建議節奏', p.cadence),
      detail('形式', p.format)),
    h('div.res-go', {}, link),
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
