/**
 * 四科實作練習工作台。音檔與錄音只留在瀏覽器記憶體，送到伺服器的只有
 * 科目、時間、分數與文字紀錄；本機工具不該默默複製一份聲音檔。
 */

import { h, clear, announce } from './dom.mjs';
import { api } from './net.mjs';
import * as motion from './motion.mjs';

// 中文名跟 src/engine/today.mjs 的科目表一致：今天頁列的是那一份，點進來標題換了字會以為進錯科。
const SKILLS = {
  CE: { zh: '閱讀理解', fr: 'Compréhension des écrits', hint: '讀完一份文章或題組後，記下來源與結果。' },
  PE: { zh: '書寫表達', fr: 'Production écrite', hint: '計時寫作，草稿會留在這台瀏覽器。' },
  CO: { zh: '聽力理解', fr: "Compréhension de l'oral", hint: '選一個本機音檔，分遍聽完再記錄。' },
  PO: { zh: '口說表達', fr: "Production orale", hint: '計時錄音、立即回聽，再記下自評。' },
};

export function practiceView(root, ctx) {
  const skill = SKILLS[ctx.practiceSkill] ? ctx.practiceSkill : 'PE';
  const meta = SKILLS[skill];
  const from = ctx.practiceFrom;
  const box = h('div.workbench');
  root.append(box);

  let elapsed = 0;
  let startedAt = null;
  let tick = null;
  let stream = null;
  let recorder = null;
  let recordingUrl = null;
  let sourceUrl = null;
  let chunks = [];

  // <output> 隱含 role=status，每秒改字讀屏就跟著念一次；timer 角色預設不播報，要聽時間再自己移過去。
  const clock = h('output.practice-clock.num', { role: 'timer', text: '00:00', 'aria-label': '計時 0 分 0 秒' });
  const timerButton = h('button.btn.btn-primary', { type: 'button', text: '開始計時', onclick: toggleTimer });
  const resetButton = h('button.btn', { type: 'button', text: '歸零', onclick: resetTimer });
  const title = h('input.input', { type: 'text', maxlength: 120, placeholder: sourcePlaceholder(skill) });
  const score = h('input.input', { type: 'number', min: 0, max: 100, step: 0.5, inputmode: 'decimal' });
  const maxScore = h('input.input', { type: 'number', min: 0.5, max: 100, step: 0.5, inputmode: 'decimal', value: '25' });
  const assessment = assessmentTool(skill, score, maxScore);
  const notes = h('textarea.input.practice-notes', { maxlength: 4000, placeholder: '哪裡卡住、下次要改什麼（選填）' });
  // 一頁只有一顆主按鈕，而且跟著進度換手：還沒計時之前下一步是「開始計時」，
  // 計過時之後下一步是「儲存」。兩顆同時是主色的話，眼睛不知道先按哪一顆。
  const save = h('button.btn', { type: 'button', text: '儲存這次練習', onclick: saveAttempt });
  const status = h('p.field-error', { role: 'alert', hidden: true });
  const specific = specificTool(skill);

  // 有專屬工具（草稿、音檔、錄音）的科目排成兩欄：左邊做、右邊記。
  // 閱讀理解沒有工具，只剩表單，單欄就好，硬排兩欄會留下一整欄空白。
  const hasTool = skill !== 'CE';
  box.append(
    workbenchHead({ back: `← ${from.label}`, onBack: () => ctx.go(from.id), code: skill, title: meta.zh, fr: meta.fr }),
    h('section.practice-timer', { 'aria-label': '練習計時器' },
      clock,
      h('p.cue', { text: meta.hint }),
      h('div.practice-actions', {}, timerButton, resetButton),
    ),
    // dataset 的值會被轉成字串，傳 null 會變成 data-solo="null"，所以整個屬性物件二選一。
    h('div.wb-grid', hasTool ? {} : { dataset: { solo: '1' } },
      specific.node,
      h('form.practice-form', { onsubmit: (ev) => { ev.preventDefault(); saveAttempt(); } },
        // 跟左欄的工具標題同一層，兩欄的頂端才對得齊。
        h('div.practice-tool-head', {}, h('h3', { text: '這一次' })),
        field('題目或來源', title),
        h('div.score-fields', { hidden: assessment.usesRubric },
          field('得分（選填）', score),
          field('滿分', maxScore),
        ),
        assessment.node,
        field('練習筆記', notes),
        status,
        h('div.practice-actions', {}, save),
      ),
    ),
  );

  return cleanup;

  function toggleTimer() {
    if (startedAt) return pauseTimer();
    startedAt = Date.now();
    timerButton.textContent = '暫停';
    tick = window.setInterval(renderClock, 250);
    renderClock();
    syncPrimary();
  }

  function syncPrimary() {
    const begun = Boolean(startedAt) || elapsed > 0;
    timerButton.classList.toggle('btn-primary', !begun);
    save.classList.toggle('btn-primary', begun);
  }

  function pauseTimer() {
    if (!startedAt) return;
    elapsed += Date.now() - startedAt;
    startedAt = null;
    window.clearInterval(tick);
    tick = null;
    timerButton.textContent = elapsed ? '繼續' : '開始計時';
    renderClock();
  }

  function resetTimer() {
    pauseTimer();
    elapsed = 0;
    timerButton.textContent = '開始計時';
    renderClock();
    syncPrimary();
  }

  function renderClock() {
    const ms = elapsed + (startedAt ? Date.now() - startedAt : 0);
    const sec = Math.floor(ms / 1000);
    const min = Math.floor(sec / 60);
    clock.textContent = `${String(min).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
    clock.setAttribute('aria-label', `計時 ${min} 分 ${sec % 60} 秒`);
  }

  async function saveAttempt() {
    pauseTimer();
    status.hidden = true;
    const pending = assessment.pending?.();
    if (pending) {
      status.textContent = pending;
      status.hidden = false;
      return;
    }
    const got = score.value === '' ? null : Number(score.value);
    const max = score.value === '' ? null : Number(maxScore.value);
    if (got !== null && (!Number.isFinite(got) || !Number.isFinite(max) || max <= 0 || got < 0 || got > max)) {
      status.textContent = '分數要介於 0 與滿分之間。';
      status.hidden = false;
      return;
    }
    save.disabled = true;
    try {
      const body = {
        skill,
        source: title.value.trim() || specific.defaultSource(),
        durationSec: Math.round(elapsed / 1000),
        score: got,
        maxScore: max,
        notes: notes.value.trim() || null,
        text: specific.text(),
        wordCount: specific.wordCount(),
        details: assessment.details(),
      };
      const result = await api.practice(body);
      specific.clearDraft();
      announce(`${skill} 練習已儲存`);
      const done = savedPanel(result, ctx);
      clear(box).append(done);
      // 儲存鈕跟著表單一起被清掉，焦點接到標題上，不然會掉回 body。
      done.querySelector('.landing')?.focus();
      motion.stamp(done.querySelector('.stamp'));
    } catch (err) {
      status.textContent = err.message;
      status.hidden = false;
      save.disabled = false;
    }
  }

  function specificTool(kind) {
    if (kind === 'PE') return writingTool();
    if (kind === 'CO') return listeningTool();
    if (kind === 'PO') return speakingTool();
    return {
      node: document.createDocumentFragment(),
      text: () => null,
      wordCount: () => null,
      defaultSource: () => null,
      clearDraft: () => {},
    };
  }

  function writingTool() {
    const key = 'cadence.draft.PE';
    const draft = h('textarea.input.practice-draft.fr', {
      lang: 'fr', maxlength: 20000, placeholder: 'Écrivez votre texte ici…', 'aria-label': '寫作草稿',
      oninput: () => {
        count.textContent = `${countWords(draft.value)} mots`;
        try { localStorage.setItem(key, draft.value); } catch { /* 草稿仍留在目前頁面。 */ }
      },
    });
    try { draft.value = localStorage.getItem(key) ?? ''; } catch { /* 無痕模式可能拒絕儲存。 */ }
    const count = h('span.num', { text: `${countWords(draft.value)} mots` });
    const node = h('section.practice-tool', {},
      h('div.practice-tool-head', {}, h('h3', { text: '寫作草稿' }), count),
      draft,
      h('p.hint', { text: '草稿只存在這台瀏覽器；儲存練習後會清空。' }),
    );
    return {
      node, text: () => draft.value.trim() || null, wordCount: () => countWords(draft.value),
      defaultSource: () => '自由寫作',
      clearDraft: () => { try { localStorage.removeItem(key); } catch { /* 已儲存的紀錄不受影響。 */ } },
    };
  }

  function listeningTool() {
    const audio = h('audio.practice-audio', { controls: true, hidden: true });
    const file = h('input.input', {
      type: 'file', accept: 'audio/*',
      onchange: () => {
        if (sourceUrl) URL.revokeObjectURL(sourceUrl);
        const picked = file.files?.[0];
        if (!picked) return;
        sourceUrl = URL.createObjectURL(picked);
        audio.src = sourceUrl;
        audio.hidden = false;
        if (!title.value) title.value = picked.name;
      },
    });
    const passes = h('div.pass-list', {},
      check('第一遍：只抓主旨'), check('第二遍：記人物、時間與數字'), check('第三遍：核對答案與漏聽處'),
    );
    return {
      node: h('section.practice-tool', {}, h('h3', { text: '本機音檔' }), file, audio, passes),
      text: () => null, wordCount: () => null,
      defaultSource: () => file.files?.[0]?.name ?? null, clearDraft: () => {},
    };
  }

  function speakingTool() {
    const message = h('p.hint', { text: '錄音不會上傳；離開本頁就會消失。' });
    const audio = h('audio.practice-audio', { controls: true, hidden: true });
    const record = h('button.btn', { type: 'button', text: '開始錄音', onclick: toggleRecording });
    async function toggleRecording() {
      if (recorder?.state === 'recording') {
        recorder.stop();
        record.disabled = true;
        return;
      }
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        message.textContent = '這個瀏覽器不支援本機錄音，仍可用計時器完成練習。';
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        chunks = [];
        recorder = new MediaRecorder(stream);
        recorder.ondataavailable = (ev) => { if (ev.data.size) chunks.push(ev.data); };
        recorder.onstop = () => {
          if (recordingUrl) URL.revokeObjectURL(recordingUrl);
          recordingUrl = URL.createObjectURL(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
          audio.src = recordingUrl;
          audio.hidden = false;
          stream?.getTracks().forEach((track) => track.stop());
          stream = null;
          record.disabled = false;
          record.textContent = '重新錄音';
          message.textContent = '錄音完成。先回聽，再寫下要修正的地方。';
        };
        recorder.start();
        record.textContent = '停止錄音';
        if (!startedAt && elapsed === 0) toggleTimer();
      } catch (err) {
        message.textContent = `無法使用麥克風：${err.message}`;
      }
    }
    return {
      node: h('section.practice-tool', {}, h('h3', { text: '口說錄音' }), h('div.practice-actions', {}, record), audio, message),
      text: () => null, wordCount: () => null, defaultSource: () => '口說練習', clearDraft: () => {},
    };
  }

  function cleanup() {
    window.clearInterval(tick);
    stream?.getTracks().forEach((track) => track.stop());
    if (recordingUrl) URL.revokeObjectURL(recordingUrl);
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
  }
}

const MISTAKES = {
  CE: ['詞彙', '細節', '推論', '干擾選項', '時間不足'],
  CO: ['數字／時間', '連音／聲音', '語速', '細節', '干擾選項'],
};

const RUBRICS = {
  PE: [
    ['task', '完成題目要求', [0, 1, 3, 5]],
    ['cohesion', '連貫與銜接', [0, 1, 3, 5]],
    ['register', '語域合宜', [0, 1, 3, 5]],
    ['lexicon', '詞彙', [0, 1, 3, 5]],
    ['grammar', '文法與句型', [0, 1, 3, 5]],
  ],
  PO: [
    ['intro', '自我介紹／引導訪談', [0, 1, 2.5, 4]],
    ['interaction', '互動練習', [0, 1, 2.5, 4]],
    ['opinion', '表達觀點', [0, 1, 2.5, 4]],
    ['lexicon', '詞彙', [0, 1, 3, 5]],
    ['grammar', '文法與句型', [0, 1, 2.5, 4]],
    ['pronunciation', '發音與流暢度', [0, 1, 2.5, 4]],
  ],
};

function assessmentTool(skill, score, maxScore) {
  const rubric = RUBRICS[skill];
  if (rubric) {
    const selects = new Map();
    const total = h('output.num.rubric-total', { 'aria-live': 'polite' });
    const rows = h('div.rubric-grid');
    // 預設是「未評」而不是 0：原本各項預設 0，沒動就存檔會記成 0/25，
    // 進度頁因此出現「平均 0%」，分不出是考砸還是根本沒評。0 分只能是自己選的。
    const picked = () => [...selects.values()].filter((input) => input.value !== '');
    const update = () => {
      const done = picked();
      maxScore.value = '25';
      if (done.length === selects.size) {
        const value = done.reduce((sum, input) => sum + Number(input.value), 0);
        score.value = String(value);
        total.textContent = `${value} / 25`;
        return;
      }
      score.value = '';
      total.textContent = done.length ? `還有 ${selects.size - done.length} 項未評` : '未評分';
    };
    for (const [key, label, values] of rubric) {
      const input = h('select.input', { onchange: update },
        h('option', { value: '', text: '未評' }),
        ...values.map((value) => h('option', { value: String(value), text: String(value) })));
      selects.set(key, input);
      rows.append(h('label.rubric-row', {}, h('span', { text: label }), input));
    }
    update();
    return {
      usesRubric: true,
      node: h('fieldset.assessment', {}, h('legend', { text: 'DELF 評分規準' }), rows, total,
        h('p.hint', { text: '每一項都評了才算總分；全部不評也能存，只是不計分。這是一次練習的證據，不代表整體程度。' })),
      // 評一半的總分沒有意義，擋下來比默默當成 0 誠實。
      pending: () => {
        const n = picked().length;
        return n > 0 && n < selects.size ? `評分規準還有 ${selects.size - n} 項未評；全部評完，或全部改回「未評」。` : null;
      },
      details: () => (picked().length ? { rubric: Object.fromEntries([...selects].map(([key, input]) => [key, Number(input.value)])) } : null),
    };
  }
  const tags = new Map();
  const list = h('div.mistake-tags');
  for (const label of MISTAKES[skill] ?? []) {
    const input = h('input', { type: 'checkbox' });
    tags.set(label, input);
    list.append(h('label.inline-check', {}, input, h('span', { text: label })));
  }
  return {
    usesRubric: false,
    node: h('fieldset.assessment', {}, h('legend', { text: '這次失分在哪裡' }), list),
    details: () => ({ mistakes: [...tags].filter(([, input]) => input.checked).map(([label]) => label) }),
  };
}

function savedPanel(result, ctx) {
  const from = ctx.practiceFrom;
  const score = result.score === null ? null : `・${result.score}/${result.maxScore}`;
  return donePanel({
    code: result.skill,
    title: SKILLS[result.skill]?.zh ?? result.skill,
    line: `${formatDuration(result.durationSec)}${result.wordCount ? `・${result.wordCount} mots` : ''}${score ?? ''}`,
    actions: [
      ctx.guided
        ? h('button.btn.btn-primary', { type: 'button', text: '回今天，做下一項', onclick: () => ctx.go('today') })
        : h('button.btn.btn-primary', { type: 'button', text: `回${from.label}`, onclick: () => ctx.go(from.id) }),
      from.id === 'stats'
        ? h('button.btn', { type: 'button', text: '回今天', onclick: () => { ctx.endGuided(); ctx.go('today'); } })
        : h('button.btn', { type: 'button', text: '看進度', onclick: () => { ctx.endGuided(); ctx.go('stats'); } }),
    ],
    after: todayTally(result.skill),
  });
}

/**
 * 儲存後原本只剩代碼、標題、章和一行字，1440 寬時下半頁整片空白。
 * 補上今天四科的狀態：剛存的這科已經算做過，另外三科還剩什麼一眼看得到，
 * 「回今天，做下一項」要去哪裡也就有了答案。資料跟今天頁同一支 API，讀不到就整節不出。
 */
function todayTally(current) {
  const list = h('ul.skills');
  const box = afterSection('今天四科', list);
  api.today().then((d) => {
    for (const t of d.tasks) {
      const parts = [];
      // 卡片寫到期數，不寫 count：count 含全部可學的新卡，不設上限時是幾千張，讀起來像今天的欠帳。
      if (t.mode === 'cards') parts.push(t.due ? `到期 ${t.due} 張` : '卡片清完');
      if (t.checkable) parts.push(t.done ? '實作做過' : '實作還沒做');
      const done = (t.mode !== 'cards' || !t.due) && (!t.checkable || t.done);
      list.append(h('li.skill', { dataset: { done: done ? '1' : '0' }, 'aria-current': t.id === current ? 'true' : null },
        h('span.skill-code', { text: t.id }),
        h('div.skill-main', {}, h('span', { text: t.zh }), t.id === current ? h('span.dim', { text: '剛記錄' }) : null),
        h('span.tally', { text: parts.join('・') }),
      ));
    }
    motion.rise([box], { delay: 0.25 });
  }).catch(() => box.remove());
  return box;
}

/** 完成面板下方的附屬一節。練習與模考共用，模考拿去列分科分數。 */
export function afterSection(title, body) {
  return h('section.wb-after', {}, h('h3', { text: title }), body);
}

/** 科目中文名，給模考的分科列用。 */
export function skillName(code) {
  return SKILLS[code]?.zh ?? code;
}

let fieldSeq = 0;

/**
 * 表單欄位。標籤原本只是擺在控制項上面的一行字，沒有 for，
 * 讀螢幕念不出欄位名、點標籤也不會聚焦；id 由這裡發，呼叫端不用自己想名字。
 */
export function field(label, control) {
  control.id ||= `fld-${++fieldSeq}`;
  return h('div.field', {}, h('label', { htmlFor: control.id, text: label }), control);
}

/**
 * 練習與模考共用的頁首。科目代碼用主色小字放在標題上方，像辭典的詞條編號；
 * 返回鈕在最上面，位置跟辭典的「← 回結果」一致。
 */
export function workbenchHead({ back, onBack, code, title, fr = null, sub = null }) {
  return h('header.wb-head', {},
    h('button.btn.btn-quiet.btn-sm.wb-back', { type: 'button', text: back, onclick: onBack }),
    h('p.wb-code', { text: code }),
    h('h2', { text: title }),
    fr ? h('p.wb-fr.fr', { lang: 'fr', text: fr }) : null,
    sub ? h('p.wb-sub', { text: sub }) : null,
  );
}

/** 儲存後的畫面。蓋一枚跟今天頁打卡同款的章，這件事算做完了。 */
export function donePanel({ code, title, line, actions, after = null }) {
  // 版面照抄頁首：代碼、大標題，章蓋在標題旁。標題不再寫「已記錄」，那是章的工作；
  // 讀螢幕的人由儲存時的 announce() 得知結果，章本身 aria-hidden。
  return h('div.wb-done', {},
    h('p.wb-code', { text: code }),
    h('div.wb-done-title', {},
      h('h2.landing', { tabindex: -1, text: title }),
      h('span.stamp', { 'aria-hidden': 'true' }, '已記錄', h('b', { lang: 'fr', text: 'fait' })),
    ),
    h('p.wb-done-line.num', { text: line }),
    h('div.practice-actions', {}, ...actions),
    after,
  );
}

function check(label) {
  return h('label.inline-check', {}, h('input', { type: 'checkbox' }), h('span', { text: label }));
}

export function countWords(text) {
  // DELF 寫作的自查要看空白分詞；l’université 與 peut-être 都算一個書寫單位。
  return String(text).trim().split(/\s+/u).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

function formatDuration(sec) {
  if (!sec) return '未計時';
  const min = Math.floor(sec / 60);
  return min ? `${min} 分 ${sec % 60} 秒` : `${sec} 秒`;
}

function sourcePlaceholder(skill) {
  return ({ CE: '文章、書名或題組', PE: '題目或 prompt', CO: '音檔、影片或樣題', PO: '口說題目' })[skill];
}
