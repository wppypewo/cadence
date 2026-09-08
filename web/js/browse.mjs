/**
 * 查詢頁。用途很窄，但少了會痛：
 * 寫作業寫到一半想確認 accueillir 的 nous 是什麼，不該為此開一輪複習。
 *
 * 兩個刻意的決定：
 *  1. 查詢**會**直接顯示答案。這裡不是考試，遮起來只會逼人繞去別的網站。
 *     （出題用的 /api/queue 仍然把答案剝掉，兩條路徑不共用。）
 *  2. 查到動詞就把整張變位表攤開。784 個動詞的六個時態都已經在題庫裡，
 *     只回一行「這個字有出題」是浪費。
 */

import { h, clear, icon, relDays } from './dom.mjs';
import { api } from './net.mjs';

const KIND_ZH = {
  'vocab-recall': '看字回想',
  'vocab-produce': '中翻法',
  conj: '動詞變位',
  connector: '連接詞',
};

const PRONOUNS = ['je', 'tu', 'il', 'nous', 'vous', 'ils'];
const IMPERATIVE_PRONOUNS = ['tu', 'nous', 'vous'];

/** 變位表的顯示順序。題庫只考前五個 + passé composé，其餘也一併列出供查閱。 */
const TENSE_ORDER = [
  'présent', 'imparfait', 'futur simple', 'conditionnel présent',
  'subjonctif présent', 'passé simple', 'impératif',
  'passé composé', 'plus-que-parfait', 'futur antérieur',
  'conditionnel passé', 'subjonctif passé',
];

const TENSE_ZH = {
  'présent': '現在式',
  'imparfait': '未完成過去式',
  'futur simple': '簡單未來式',
  'conditionnel présent': '條件式現在',
  'subjonctif présent': '虛擬式現在',
  'passé simple': '簡單過去式',
  'impératif': '命令式',
  'passé composé': '複合過去式',
  'plus-que-parfait': '愈過去式',
  'futur antérieur': '先未來式',
  'conditionnel passé': '條件式過去',
  'subjonctif passé': '虛擬式過去',
};

/** 出題時態。表格上標一顆點，讓人知道哪些是會被考的。 */
const DRILLED = new Set([
  'présent', 'imparfait', 'futur simple',
  'conditionnel présent', 'subjonctif présent', 'passé composé',
]);

export function browseView(root) {
  const box = h('div.browse');
  root.append(box);

  const field = h('input.input.fr', {
    type: 'search', lang: 'fr', placeholder: '單字、動詞、連接詞…',
    autocomplete: 'off', spellcheck: false, 'aria-label': '搜尋題庫',
  });
  box.append(h('form.search-form', {
    onsubmit: (ev) => { ev.preventDefault(); clearTimeout(timer); run(field.value); },
  }, field, h('button.btn.btn-primary', { type: 'submit', text: '找' })));

  const out = h('div.browse-out', { 'aria-live': 'polite', 'aria-busy': 'false' });
  box.append(out);
  clear(out).append(hint());
  queueMicrotask(() => field.focus());

  // 打字時延遲 220ms 再送，避免每個鍵都打一次 SQL LIKE。
  let timer = null;
  let seq = 0;
  field.addEventListener('input', () => {
    clearTimeout(timer);
    const q = field.value;
    timer = setTimeout(() => run(q), 220);
  });

  async function run(raw) {
    const q = raw.trim();
    if (!q) return void clear(out).append(hint());
    const mine = ++seq;
    out.setAttribute('aria-busy', 'true');
    try {
      const { hits } = await api.search(q);
      if (mine !== seq) return; // 已經有更新的查詢，這一份丟掉
      clear(out);
      if (!hits.length) {
        out.append(h('div.card.empty', {}, icon('find'),
          h('p', {}, '題庫裡沒有 ', h('span.fr', { text: q }), ' 。'),
          h('p.sub', { text: '題庫只收 A1–B1 的高頻詞與 784 個不規則動詞，不是完整字典。' })));
        return;
      }
      const rows = group(hits);
      const list = h('div.hits');
      const back = () => run(q);
      for (const row of rows) {
        list.append(row.verb ? verbRow(row, out, back) : hitRow(row.hit, out, back));
      }
      out.append(h('p.hits-count', { text: countText(hits, rows) }), list);
    } catch (err) {
      if (mine !== seq) return;
      clear(out).append(h('div.card.errorbox', {}, h('p', { text: err.message })));
    } finally {
      if (mine === seq) out.setAttribute('aria-busy', 'false');
    }
  }
}

/**
 * 同一個動詞的變位卡會塞滿整個結果——accueillir 一次就是 36 張。
 * 收成一列，點開就是完整變位表；那張表本來就比 36 行「答案是什麼」好讀。
 */
function group(hits) {
  const rows = [];
  const byVerb = new Map();
  for (const hit of hits) {
    const verb = hit.card.kind === 'conj' ? hit.card.front?.verb : null;
    if (!verb) {
      rows.push({ hit });
      continue;
    }
    let entry = byVerb.get(verb);
    if (!entry) {
      entry = { verb, hit, count: 0, seen: 0, tenses: new Set() };
      byVerb.set(verb, entry);
      rows.push(entry);
    }
    entry.count += 1;
    if (hit.state) entry.seen += 1;
    if (hit.card.front?.tenseZh) entry.tenses.add(hit.card.front.tenseZh);
  }
  return rows;
}

function countText(hits, rows) {
  const verbs = rows.filter((r) => r.verb);
  const capped = hits.length === 40 ? '（已達顯示上限）' : '';
  if (verbs.length === 0) return `${hits.length} 筆${capped}`;
  const cards = verbs.reduce((a, r) => a + r.count, 0);
  return `${hits.length} 筆${capped}，其中 ${cards} 張變位卡收成 ${verbs.length} 個動詞`;
}

/** 收合後的動詞列。右邊給的是「這個動詞練到哪」，不是單張卡的排程。 */
function verbRow(entry, out, back) {
  const f = entry.hit.card.front ?? {};
  const left = h('div.hit-main', {},
    h('div.w.fr', { lang: 'fr', text: entry.verb }),
    h('div.m', { text: [f.gloss, `${entry.tenses.size} 個時態共 ${entry.count} 張`].filter(Boolean).join('・') }),
    h('div.m.open-hint', { text: '按一下看完整變位表' }),
  );
  const right = h('div.hit-state', {},
    h('span.tag', { text: '動詞變位' }),
    f.level ? h('span.tag', { text: f.level }) : null,
    entry.seen
      ? h('span.s.num', { text: `已學 ${entry.seen}/${entry.count} 張` })
      : h('span.s.dim', { text: '未學過' }),
  );
  return openable(h('div.hit', {}, left, right), entry.verb, out, back);
}

function hitRow({ card, state }, out, back) {
  const f = card.front ?? {};
  const head = f.word || f.connector || f.verb || card.answer || card.id;
  const sub = [f.posZh, f.gloss || f.zh || f.tenseZh].filter(Boolean).join('・');

  const left = h('div.hit-main',
    {},
    h('div.w.fr', { lang: 'fr', text: head }),
    h('div.m', { text: sub }),
  );
  if (card.kind === 'conj') {
    left.append(h('div.m', {},
      h('span.fr', { lang: 'fr', text: `${f.pronoun} ${card.answer}` }),
      ` — ${f.tenseZh}`));
  }

  const right = h('div.hit-state', {},
    h('span.tag', { text: KIND_ZH[card.kind] ?? card.kind }),
    f.level ? h('span.tag', { text: f.level }) : null,
    state
      ? h('span.s.num', { text: `S ${state.stability.toFixed(1)}d・${relDays(daysTo(state.due))}` })
      : h('span.s.dim', { text: '未學過' }),
  );

  const row = h('div.hit', {}, left, right);

  const verb = f.pos === 'VER' ? f.word : null;
  if (!verb) return row;
  left.append(h('div.m.open-hint', { text: '按一下看完整變位表' }));
  return openable(row, verb, out, back);
}

/** 讓一列變成可點、可用鍵盤打開的按鈕。滑鼠與鍵盤走同一條路。 */
function openable(row, verb, out, back) {
  row.classList.add('hit-open');
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  row.setAttribute('aria-label', `展開 ${verb} 的變位表`);
  const open = () => showVerb(verb, out, back);
  row.addEventListener('click', open);
  row.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); }
  });
  return row;
}

async function showVerb(name, out, back) {
  const panel = h('section.verb', {}, h('div.verb-head', {}, h('h2.fr', { lang: 'fr', text: name })));
  clear(out).append(panel);
  panel.scrollIntoView({ block: 'start', behavior: 'auto' });

  let data;
  try {
    data = await api.verb(name);
  } catch (err) {
    clear(panel).append(h('div.card.errorbox', {}, h('p', { text: err.message })));
    return;
  }

  clear(panel);
  // 回去要回到剛才那份結果，不是回到空白頁——查完一個動詞常常還要查下一個。
  const backBtn = h('button.btn.btn-quiet.btn-sm', { text: '← 回搜尋結果', onclick: back });
  panel.append(h('div.verb-head', {},
    h('div', {},
      h('h2.fr', { lang: 'fr', text: name }),
      h('p.verb-sub', { text: verbSub(data) }),
    ),
    backBtn,
  ));
  if (data.impersonal) {
    panel.append(h('p.verb-note', { text: '無人稱動詞，只有第三人稱單數。' }));
  }
  if (data.auxDual) {
    panel.append(h('p.verb-note', { text: '複合時態可用 avoir 或 être：有直接受詞用 avoir，沒有用 être，兩者意思不同。' }));
  }

  const grid = h('div.tenses');
  const all = { ...(data.simple ?? {}), ...(data.compound ?? {}) };
  const names = [
    ...TENSE_ORDER.filter((t) => all[t]),
    ...Object.keys(all).filter((t) => !TENSE_ORDER.includes(t)),
  ];
  for (const tense of names) grid.append(tenseTable(tense, all[tense], data.impersonal));
  panel.append(grid);
  panel.append(h('p.verb-foot', { text: '有點的時態會出現在複習題裡；其餘只供查閱。' }));
}

function verbSub(data) {
  const bits = [];
  if (data.gloss) bits.push(data.gloss);
  if (data.level) bits.push(data.level);
  if (data.aux) bits.push(`助動詞 ${data.aux}`);
  if (data.pastParticiple) bits.push(`過去分詞 ${data.pastParticiple}`);
  if (data.presentParticiple) bits.push(`現在分詞 ${data.presentParticiple}`);
  return bits.join('・');
}

function tenseTable(tense, forms, impersonal) {
  const pronouns = tense === 'impératif' ? IMPERATIVE_PRONOUNS : PRONOUNS;
  const box = h('div.tense');
  box.append(h('h3', {},
    h('span', { text: TENSE_ZH[tense] ?? tense }),
    DRILLED.has(tense) ? h('span.dot', { title: '這個時態會出題', 'aria-label': '會出題' }) : null,
    h('span.fr.raw', { lang: 'fr', text: tense }),
  ));
  const tb = h('tbody');
  forms.forEach((form, i) => {
    if (!form) return;
    if (impersonal && tense !== 'impératif' && i !== 2) return;
    tb.append(h('tr', {},
      h('td.p', { text: pronouns[i] ?? '' }),
      h('td.f.fr', { lang: 'fr', text: form }),
    ));
  });
  box.append(h('table.verb-table', {}, tb));
  return box;
}

function hint() {
  return h('div.card.empty', {}, icon('find'),
    h('h2', { text: '查一個字' }),
    h('p', { text: '查詢不會改動任何卡片的排程，也不會被記成一次作答。' }),
    h('p.sub', { text: '搜尋範圍是題庫本身：A1–B1 詞彙、784 個不規則動詞、25 個連接詞。查到動詞時可以展開完整變位表。' }),
  );
}

function daysTo(iso) {
  return Math.round((new Date(iso) - Date.now()) / 86_400_000);
}
