/**
 * 辭典頁（原「查詢」）。用途很窄，但少了會痛：
 * 寫作業寫到一半想確認 accueillir 的 nous 是什麼，不該為此開一輪複習。
 *
 * 兩個刻意的決定：
 *  1. 查詢**會**直接顯示答案。這裡不是考試，遮起來只會逼人繞去別的網站。
 *     （出題用的 /api/queue 仍然把答案剝掉，兩條路徑不共用。）
 *  2. 查到動詞就把整張變位表攤開。變位表的六個時態都已經在題庫裡（只在本機版），
 *     只回一行「這個字有出題」是浪費。
 */

import { h, clear, icon, relDays, announce } from './dom.mjs';
import { api } from './net.mjs';
import * as motion from './motion.mjs';
import { KIND_ZH, cardHead } from './kinds.mjs';
import { isCloudRuntime } from './runtime.mjs';

// 範圍說明不寫死動詞數：舊文案的「784 個不規則動詞」在題庫收進 B2 後就錯了，
// 而雲端版刻意不帶 Verbiste 衍生的變位表（GPL-2.0 隔離），兩邊範圍本來就不同。
const SCOPE = isCloudRuntime()
  ? 'A1–B2 詞彙與 50 個連接詞（變位表只在本機版）'
  : 'A1–B2 詞彙、動詞變位表與 50 個連接詞';

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
  const box = h('div.dict');
  root.append(box);

  // 搜尋框就是這一頁的標題：沒有框，只有一條底線，字級跟詞條的字頭一樣大。
  // 查字的人眼睛停在哪裡，打的字就出現在哪裡。
  const field = h('input.dict-input.fr', {
    type: 'search', lang: 'fr', placeholder: '查字：法文、動詞或中文',
    autocomplete: 'off', spellcheck: false, 'aria-label': '搜尋題庫',
  });
  box.append(h('form.dict-search', {
    role: 'search',
    onsubmit: (ev) => { ev.preventDefault(); clearTimeout(timer); run(field.value); },
  }, field, h('button.dict-go', { type: 'submit', 'aria-label': '搜尋' }, icon('find'))));

  // 結果區不設 live：整區設 live 時，每打一個字讀屏就把幾十列結果從頭念一次。
  // 只用 announce() 報一句命中幾張，要細看再自己移進列表。
  const out = h('div.browse-out', { 'aria-busy': 'false' });
  box.append(out);
  const example = (q) => { field.value = q; field.focus(); run(q); };
  clear(out).append(hint(example));
  queueMicrotask(() => field.focus());

  // 打字時延遲 220ms 再送，避免每個鍵都打一次 SQL LIKE。
  let timer = null;
  let seq = 0;
  field.addEventListener('input', () => {
    clearTimeout(timer);
    const q = field.value;
    timer = setTimeout(() => run(q), 220);
  });

  /** reopen：從變位表回來時帶著剛才打開的動詞與它是第幾列，好把焦點放回那一列。 */
  async function run(raw, reopen = null) {
    const q = raw.trim();
    if (!q) return void clear(out).append(hint(example));
    const mine = ++seq;
    out.setAttribute('aria-busy', 'true');
    try {
      const res = await api.search(q);
      const { hits } = res;
      if (mine !== seq) return; // 已經有更新的查詢，這一份丟掉
      clear(out);
      if (!hits.length) {
        out.append(h('div.dict-empty', {},
          h('p.dict-empty-lead', {}, '題庫裡沒有 ', h('span.fr', { lang: 'fr', text: q }), '。'),
          h('p.dict-empty-note', { text: `題庫只收 ${SCOPE}，不是完整字典。` })));
        announce(`題庫裡沒有 ${q}`);
        return;
      }
      const rows = group(hits);
      const list = h('div.hits');
      const back = (verb, at) => run(q, { verb, at });
      for (const row of rows) {
        if (row.verb) list.append(verbRow(row, out, back));
        else if (row.kinds) list.append(vocabRow(row, out, back));
        else list.append(hitRow(row.hit, out, back, q));
      }
      out.append(countLine(res, rows), list);
      // 句子裡帶著查的字：兩次查詢命中數相同時，live region 的字不變就不會再念。
      if (!reopen) announce(`${q}：命中 ${res.total} 張卡，顯示 ${rows.length} 組`);
      // 「回搜尋結果」那顆鈕已經隨變位表一起清掉，不接住的話焦點掉回 body，
      // 下一次 Tab 要從頁首重數。回到剛才那一列，查完一個接著查下一個才順。
      // 同一個動詞可能有好幾列（例如 être 的變位與單字各一列），只比動詞會永遠回到第一列，
      // 所以先試原本的位置，位置對不上（結果變了）才退回找第一列。
      if (reopen) {
        const same = list.children[reopen.at];
        (same?.dataset.verb === reopen.verb
          ? same
          : [...list.querySelectorAll('.hit-open')].find((r) => r.dataset.verb === reopen.verb))?.focus();
      }
    } catch (err) {
      if (mine !== seq) return;
      // 這裡是連線失敗，不是題庫沒有這個字（那是上面的 dict-empty），所以給重試。
      announce('查詢沒有完成');
      clear(out).append(h('div.sec-err', {},
        h('p', { text: `查詢沒有完成：${err.message}` }),
        h('button.btn.btn-sm', { type: 'button', text: '再試一次', onclick: () => run(q, reopen) }),
      ));
    } finally {
      if (mine === seq) out.setAttribute('aria-busy', 'false');
    }
  }

  // 換頁時還在等的那一份查詢與 220ms 計時器要作廢，不然結果會畫進已經拆掉的節點。
  return () => { clearTimeout(timer); seq += 1; motion.killWithin(box); };
}

/** 同一個詞的兩個方向。收成一列時的標籤順序照這個陣列，不照命中順序。 */
const VOCAB_KINDS = ['vocab-recall', 'vocab-produce'];

/**
 * 兩種收合，理由不同：
 *
 *  1. 同一個動詞的變位卡會塞滿整個結果——accueillir 一次就是 36 張。
 *     收成一列，點開就是完整變位表；那張表本來就比 36 行「答案是什麼」好讀。
 *  2. 「看字回想」與「中翻法」是同一個詞的兩個方向，front 一模一樣，
 *     分兩列印出來就是連續兩行看起來完全相同的東西（être／être、fenêtre／fenêtre）。
 *     收成一列、兩個題型標籤並排，一個字只佔一行。
 *
 * 詞性要進 key：`être|VER`（動詞）與 `être|NOM`（名詞「生物」）是兩個不同的詞條，
 * 釋義與級數都不一樣，併在一起會讓其中一個的釋義消失。
 */
function group(hits) {
  const rows = [];
  const byVerb = new Map();
  const byWord = new Map();
  for (const hit of hits) {
    const { card } = hit;
    const f = card.front ?? {};

    if (card.kind === 'conj' && f.verb) {
      let entry = byVerb.get(f.verb);
      if (!entry) {
        entry = { verb: f.verb, hit, count: 0, seen: 0, tenses: new Set() };
        byVerb.set(f.verb, entry);
        rows.push(entry);
      }
      entry.count += 1;
      if (hit.state) entry.seen += 1;
      if (f.tenseZh) entry.tenses.add(f.tenseZh);
      continue;
    }

    if (VOCAB_KINDS.includes(card.kind) && f.word) {
      const key = `${f.word}|${f.pos}`;
      let entry = byWord.get(key);
      if (!entry) {
        entry = { word: f.word, hit, count: 0, seen: 0, kinds: new Set() };
        byWord.set(key, entry);
        rows.push(entry);
      }
      entry.count += 1;
      if (hit.state) entry.seen += 1;
      entry.kinds.add(card.kind);
      continue;
    }

    rows.push({ hit });
  }
  return rows;
}

/**
 * 結果列數說明。要講清楚三件事：一共命中幾張卡、畫面上顯示幾組、
 * 為什麼兩個數字不一樣。只寫「40 筆（已達顯示上限）」等於什麼都沒說——
 * 使用者不知道被截掉的是什麼，也沒有任何辦法看到剩下的。
 * 原本把「幾張變位卡收成幾個動詞」「幾個詞的兩個方向併成一列」逐項列出，
 * 2026-10-05 critique 評為太技術：查字的人要的是規則，不是每條規則各收掉幾張。
 */
function countLine(res, rows) {
  // 兩個方向都命中的詞才算併過；只命中一個方向的收合前後都是一列。
  const why = [];
  if (rows.some((r) => r.verb)) why.push('同一個動詞的變位');
  if (rows.some((r) => r.kinds && r.count > 1)) why.push('同一個詞的兩個方向');
  const text = `${res.total} 張卡，整理成 ${rows.length} 組`
    + (why.length ? `（${why.join('、')}各併成一組）` : '');
  if (!res.truncated) return h('p.hits-count', { text });
  return h('p.hits-count', {},
    text,
    h('span.more', { text: '。還有更多，把關鍵字寫長一點可以縮小範圍。' }),
  );
}

/** 收合後的動詞列。右邊給的是「這個動詞練到哪」，不是單張卡的排程。 */
function verbRow(entry, out, back) {
  const f = entry.hit.card.front ?? {};
  const left = h('div.hit-main', {},
    h('div.w.fr', { lang: 'fr', text: entry.verb }),
    h('div.m', { text: [f.gloss, `${entry.tenses.size} 個時態共 ${entry.count} 張`].filter(Boolean).join('・') }),
  );
  const right = h('div.hit-state', {},
    h('span.tag', { text: '動詞變位' }),
    f.level ? h('span.lv', { text: f.level }) : null,
    entry.seen
      ? h('span.s.num', { text: `已學 ${entry.seen}/${entry.count} 張` })
      : h('span.s.dim', { text: '未學過' }),
    openHint(),
  );
  return openable(h('div.hit', {}, left, right), entry.verb, out, back);
}

/**
 * 收合後的詞彙列。右邊給的是「這個詞練到哪」——分母是這次命中的方向數，
 * 不是固定的 2：只搜到其中一個方向時（例如中文釋義只在其中一張裡）分母就是 1。
 */
function vocabRow(entry, out, back) {
  const f = entry.hit.card.front ?? {};
  const left = h('div.hit-main', {},
    h('div.w.fr', { lang: 'fr', text: f.word }),
    h('div.m', { text: [f.posZh, f.gloss].filter(Boolean).join('・') }),
  );
  const right = h('div.hit-state', {},
    // 兩個方向並排時用間隔號連成一句，不排成兩顆膠囊。
    h('span.tag', { text: VOCAB_KINDS.filter((k) => entry.kinds.has(k)).map((k) => KIND_ZH[k]).join('・') }),
    f.level ? h('span.lv', { text: f.level }) : null,
    entry.seen
      ? h('span.s.num', { text: `已學 ${entry.seen}/${entry.count} 個方向` })
      : h('span.s.dim', { text: '未學過' }),
  );

  const row = h('div.hit', {}, left, right);
  // 詞彙卡查到動詞時一樣可以攤開變位表，這個入口不能因為收合而消失。
  if (f.pos !== 'VER') return row;
  right.append(openHint());
  return openable(row, f.word, out, back);
}

function hitRow({ card, state }, out, back, q = '') {
  const f = card.front ?? {};
  const head = cardHead(card);
  // 名詞化卡的 front.pos／posZh 講的是**基詞**的詞性（changer 是動詞），
  // 但這一列的標題是答案（le changement，名詞）。照通用格式印會變成
  // 「l'obligation　動詞・obliger・…」——那個「動詞」看起來像在說標題那個字。
  // 所以這一種卡自己寫一句，把基詞的位置講明白。
  const sub = card.kind === 'nom'
    ? [f.base ? `由${f.posZh ?? ''} ${f.base} 變來` : null, f.gloss].filter(Boolean).join('・')
    // f.fn 只有連接詞卡有（功能分類）。查詢是查資料的地方不是考場，
    // 這裡不必像複習那樣把它藏到作答之後。
    : [f.posZh, f.base, f.fn, f.gloss || f.zh || f.tenseZh].filter(Boolean).join('・');

  const left = h('div.hit-main',
    {},
    h('div.w.fr', { lang: 'fr', text: head }),
    h('div.m', { text: sub }),
  );
  // 這一列看得到的字裡找不到查的字時，說明命中在哪個欄位，不然看起來像搜錯了。
  // 釋義已經印在副標上的（查「去」出現 aller・去）就不再重講一次。
  const via = matchedVia(card, `${head} ${sub}`, q);
  if (via) {
    // 改寫題的題目是法文，挑連接詞的題目是中文——後者標成 lang=fr 會套上法文襯線字，
    // 報讀器也會用法文念中文。
    const cjk = via.text && /[㐀-鿿]/.test(via.text);
    left.append(h('div.m', {}, `命中在${via.label}`,
      via.text ? '：' : null,
      via.text ? (cjk ? via.text : h('span.fr', { lang: 'fr', text: via.text })) : null));
  }
  if (card.kind === 'conj') {
    left.append(h('div.m', {},
      h('span.fr', { lang: 'fr', text: `${f.pronoun} ${card.answer}` }),
      `・${f.tenseZh}`));
  }

  const right = h('div.hit-state', {},
    h('span.tag', { text: KIND_ZH[card.kind] ?? card.kind }),
    f.level ? h('span.lv', { text: f.level }) : null,
    state
      ? h('span.s.num', { text: `穩定 ${state.stability.toFixed(1)} 天・${relDays(daysTo(state.due))}到期` })
      : h('span.s.dim', { text: '未學過' }),
  );

  const row = h('div.hit', {}, left, right);

  const verb = f.pos === 'VER' ? f.word : null;
  if (!verb) return row;
  right.append(openHint());
  return openable(row, verb, out, back);
}

/**
 * 可以攤開變位表的列，右端多一個「變位表」加箭頭。平常藏著、滑過或鍵盤停到才出現：
 * 一整頁結果每列都掛著同一句話只是噪音。報讀器不念它，整列的 aria-label 已經講了。
 */
function openHint() {
  return h('span.open-hint', { 'aria-hidden': 'true' }, '變位表', icon('arrow'));
}

/**
 * 查詢字落在標題以外的哪個欄位。不分大小寫，但不處理重音——伺服器那邊怎麼比對的
 * 這裡不重做一份，對不上就不寫，寧可少一行說明也不寫錯的出處。
 */
function matchedVia(card, shown, q) {
  const needle = q.trim().toLowerCase();
  if (!needle || String(shown).toLowerCase().includes(needle)) return null;
  const f = card.front ?? {};
  const fields = [
    ['題目句子', f.prompt, true],
    ['中文釋義', f.gloss, false],
    ['中文釋義', f.zh, false],
    ['基詞', f.base, false],
    ['動詞', f.verb, false],
  ];
  for (const [label, value, show] of fields) {
    if (typeof value === 'string' && value.toLowerCase().includes(needle)) return { label, text: show ? value : null };
  }
  return null;
}

/** 讓一列變成可點、可用鍵盤打開的按鈕。滑鼠與鍵盤走同一條路。 */
function openable(row, verb, out, back) {
  row.classList.add('hit-open');
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  row.setAttribute('aria-label', `展開 ${verb} 的變位表`);
  row.dataset.verb = verb;
  const open = () => {
    const at = [...row.parentNode.children].indexOf(row);
    showVerb(verb, out, () => back(verb, at));
  };
  row.addEventListener('click', open);
  row.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); }
  });
  return row;
}

async function showVerb(name, out, back) {
  // 按下去的那一列被 clear 掉了，焦點得有地方接：落在動詞標題上，
  // 報讀器念出查的是哪個字，下一個 Tab 就是「回搜尋結果」。
  const heading = () => h('h2.fr.landing', { lang: 'fr', text: name, tabindex: -1 });
  const panel = h('section.verb', {}, h('div.verb-head', {}, heading()));
  clear(out).append(panel);
  panel.scrollIntoView({ block: 'start', behavior: 'auto' });
  panel.querySelector('h2')?.focus({ preventScroll: true });

  let data;
  try {
    data = await api.verb(name);
  } catch (err) {
    const retreat = h('button.btn.btn-sm', { type: 'button', onclick: back }, icon('back'), '回結果');
    const again = h('button.btn.btn-sm', { type: 'button', text: '再試一次', onclick: () => showVerb(name, out, back) });
    clear(panel).append(h('div.sec-err', {}, h('p', { text: `讀不到變位表：${err.message}` }), again, retreat));
    again.focus();
    return;
  }

  clear(panel);
  // 回去要回到剛才那份結果，不是回到空白頁——查完一個動詞常常還要查下一個。
  // 返回鈕放在字頭上方而不是右邊：它是這一頁的「上一層」，位置跟麵包屑一樣。
  const backBtn = h('button.btn.btn-quiet.btn-sm.verb-back', { type: 'button', onclick: back }, icon('back'), '回結果');
  const title = heading();
  panel.append(backBtn, h('div.verb-head', {},
    title,
    h('p.verb-sub', { text: verbSub(data) }),
  ));
  title.focus({ preventScroll: true });
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
  // 圖例放在表格上方：放在十二張表底下的話，看到圓點的當下要捲過整頁才找得到說明。
  panel.append(h('p.verb-legend', {}, h('span.dot', { 'aria-hidden': 'true' }), '會出題的時態。其餘只供查閱。'));
  panel.append(grid);
  // 十二張表由左上往右下依序落下，眼睛跟著順序掃一遍，就知道這一頁有多少東西。
  motion.rise(grid.children, { y: 8, stagger: 0.025, duration: 0.4 });
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
    DRILLED.has(tense) ? h('span.dot', { role: 'img', title: '這個時態會出題', 'aria-label': '會出題' }) : null,
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

/**
 * 空白時的說明。靠左對齊、跟搜尋框同一條左緣，不做置中的空狀態卡：
 * 這一頁的主角是那條底線，說明是它的註腳。
 * 三個例子各代表一種查法（動詞、連接詞、中文），點一下就知道中文也查得到，
 * 比寫一句「中文釋義也搜得到」好懂。
 */
function hint(example) {
  return h('div.dict-empty', {},
    h('p.dict-empty-note', { text: `查字不動排程，也不算作答。範圍就是題庫：${SCOPE}。` }),
    h('p.dict-try', {}, h('span', { text: '例如' }),
      ...['accueillir', 'pourtant', '去'].map((q) => h('button.dict-eg', {
        type: 'button', lang: /[㐀-鿿]/.test(q) ? 'zh-Hant' : 'fr', text: q, onclick: () => example(q),
      }))),
  );
}

function daysTo(iso) {
  return Math.round((new Date(iso) - Date.now()) / 86_400_000);
}
