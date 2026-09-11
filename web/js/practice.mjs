/**
 * 四科實作練習工作台。音檔與錄音只留在瀏覽器記憶體，送到伺服器的只有
 * 科目、時間、分數與文字紀錄；本機工具不該默默複製一份聲音檔。
 */

import { h, clear, icon, announce } from './dom.mjs';
import { api } from './net.mjs';

const SKILLS = {
  CE: { zh: '閱讀理解', fr: 'Compréhension des écrits', hint: '讀完一份文章或題組後，記下來源與結果。' },
  PE: { zh: '書面表達', fr: 'Production écrite', hint: '計時寫作，草稿會留在這台瀏覽器。' },
  CO: { zh: '聽力理解', fr: "Compréhension de l'oral", hint: '選一個本機音檔，分遍聽完再記錄。' },
  PO: { zh: '口語表達', fr: "Production orale", hint: '計時錄音、立即回聽，再記下自評。' },
};

export function practiceView(root, ctx) {
  const skill = SKILLS[ctx.practiceSkill] ? ctx.practiceSkill : 'PE';
  const meta = SKILLS[skill];
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

  const clock = h('output.practice-clock.num', { text: '00:00', 'aria-label': '計時 0 分 0 秒' });
  const timerButton = h('button.btn.btn-primary', { type: 'button', text: '開始計時', onclick: toggleTimer });
  const resetButton = h('button.btn', { type: 'button', text: '歸零', onclick: resetTimer });
  const title = h('input.input', { type: 'text', maxlength: 120, placeholder: sourcePlaceholder(skill) });
  const score = h('input.input', { type: 'number', min: 0, max: 100, step: 0.5, inputmode: 'decimal' });
  const maxScore = h('input.input', { type: 'number', min: 0.5, max: 100, step: 0.5, inputmode: 'decimal', value: '25' });
  const notes = h('textarea.input.practice-notes', { maxlength: 4000, placeholder: '哪裡卡住、下次要改什麼（選填）' });
  const save = h('button.btn.btn-primary', { type: 'button', text: '儲存這次練習', onclick: saveAttempt });
  const status = h('p.field-error', { role: 'alert', hidden: true });
  const specific = specificTool(skill);

  box.append(
    h('header.page-head', {},
      h('div', {}, h('h2', { text: `${skill} ${meta.zh}` }), h('p', { lang: 'fr', text: meta.fr })),
      h('button.btn.btn-quiet', { type: 'button', text: '返回今天', onclick: () => ctx.go('today') }),
    ),
    h('section.card.practice-timer', { 'aria-label': '練習計時器' },
      h('div', {}, h('p.cue', { text: meta.hint }), clock),
      h('div.practice-actions', {}, timerButton, resetButton),
    ),
    specific.node,
    h('form.card.practice-form', { onsubmit: (ev) => { ev.preventDefault(); saveAttempt(); } },
      h('div.field', {}, h('label', { text: '題目或來源' }), title),
      h('div.score-fields', {},
        h('div.field', {}, h('label', { text: '得分（選填）' }), score),
        h('div.field', {}, h('label', { text: '滿分' }), maxScore),
      ),
      h('div.field', {}, h('label', { text: '練習筆記' }), notes),
      status,
      h('div.practice-actions', {}, save),
    ),
  );

  return cleanup;

  function toggleTimer() {
    if (startedAt) return pauseTimer();
    startedAt = Date.now();
    timerButton.textContent = '暫停';
    tick = window.setInterval(renderClock, 250);
    renderClock();
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
      };
      const result = await api.practice(body);
      specific.clearDraft();
      announce(`${skill} 練習已儲存`);
      clear(box).append(savedPanel(result, ctx));
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
      lang: 'fr', maxlength: 20000, placeholder: 'Écrivez votre texte ici…',
      oninput: () => {
        count.textContent = `${countWords(draft.value)} mots`;
        try { localStorage.setItem(key, draft.value); } catch { /* 草稿仍留在目前頁面。 */ }
      },
    });
    try { draft.value = localStorage.getItem(key) ?? ''; } catch { /* 無痕模式可能拒絕儲存。 */ }
    const count = h('span.num', { text: `${countWords(draft.value)} mots` });
    const node = h('section.card.practice-tool', {},
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
      node: h('section.card.practice-tool', {}, h('h3', { text: '本機音檔' }), file, audio, passes),
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
      node: h('section.card.practice-tool', {}, h('h3', { text: '口說錄音' }), h('div.practice-actions', {}, record), audio, message),
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

function savedPanel(result, ctx) {
  const score = result.score === null ? null : `・${result.score}/${result.maxScore}`;
  return h('div.card.empty', {},
    icon('check'),
    h('h2.landing', { tabindex: -1, text: `${result.skill} 練習已記錄` }),
    h('p', { text: `${formatDuration(result.durationSec)}${result.wordCount ? `・${result.wordCount} mots` : ''}${score ?? ''}` }),
    h('div.practice-actions', {},
      h('button.btn.btn-primary', { type: 'button', text: ctx.guided ? '回今天，做下一項' : '回今天', onclick: () => ctx.go('today') }),
      h('button.btn', { type: 'button', text: '看統計', onclick: () => { ctx.endGuided(); ctx.go('stats'); } }),
    ),
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
