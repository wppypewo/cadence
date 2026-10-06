/** 四科模考共同紀錄。分科與總分分開顯示，避免總分蓋掉單科低於門檻。 */

import { h, clear, announce } from './dom.mjs';
import { api } from './net.mjs';
import { workbenchHead, donePanel, field, afterSection, skillName } from './practice.mjs';
import * as motion from './motion.mjs';

const SKILLS = ['CE', 'CO', 'PE', 'PO'];
// 四科是分好幾次、跨好幾頁做完的：每做完一科就會去工作台再回來。
// 分數只放在表單裡的話，切一次頁就全沒了，所以跟寫作草稿一樣先存在這台瀏覽器。
const DRAFT_KEY = 'cadence.draft.mock';

export function mockView(root, ctx) {
  const box = h('div.workbench');
  root.append(box);
  const source = h('input.input', { type: 'text', maxlength: 120, value: 'B1 基準模考', placeholder: '例如：France Éducation international 樣題 1' });
  const date = h('input.input', { type: 'date', value: new Date().toLocaleDateString('sv') });
  const notes = h('textarea.input.practice-notes', { maxlength: 4000, placeholder: '時間分配、失分原因、下次要修正的地方（選填）' });
  const status = h('p.field-error', { role: 'alert', hidden: true });
  const result = h('div.mock-result', { 'aria-live': 'polite' });
  const inputs = new Map();

  const scores = h('div.mock-scores');
  for (const skill of SKILLS) {
    const got = h('input.input', { type: 'number', min: 0, max: 25, step: 0.5, inputmode: 'decimal', required: true, 'aria-label': `${skill} 得分`, oninput: update });
    // 滿分可以改，得分的上限要跟著改，不然滿分填 50 時瀏覽器會擋下 26 以上的得分。
    const max = h('input.input', { type: 'number', min: 0.5, max: 100, step: 0.5, value: '25', inputmode: 'decimal', required: true, 'aria-label': `${skill} 滿分`, oninput: () => { got.max = max.value || '100'; update(); } });
    inputs.set(skill, { got, max });
    scores.append(h('div.mock-score', {}, h('strong', { text: skill }), got, h('span.of', { text: '/' }), max));
  }

  box.append(
    workbenchHead({
      back: '進度', onBack: () => ctx.go('stats'), code: '模考', title: 'B1 基準模考',
      sub: '四科各做一次，完成一科就回來填分，最後一起儲存。',
    }),
    h('div.wb-grid', {},
      h('ol.baseline-flow', { 'aria-label': '基準模考流程' },
        ...SKILLS.map((skill, index) => h('li.baseline-step', {},
          h('span.num', { 'aria-hidden': 'true', text: String(index + 1) }),
          h('div', {}, h('strong', { text: skill }), h('small', { text: baselineInstruction(skill) })),
          h('button.btn.btn-sm', { type: 'button', text: `開 ${skill} 工作台`, onclick: () => ctx.openPractice(skill) }),
        )),
      ),
      h('form.practice-form', { onsubmit: save },
        h('div.form-grid', {},
          field('模考來源', source),
          field('日期', date),
        ),
        h('fieldset.mock-fieldset', {}, h('legend', { text: '四科分數' }), scores),
        result,
        field('檢討', notes),
        status,
        h('div.practice-actions', {}, h('button.btn.btn-primary', { type: 'submit', text: '儲存模考' })),
      ),
    ),
  );
  restoreDraft();
  for (const el of [source, date, notes]) el.addEventListener('input', storeDraft);
  // 第一次只算總分不存：沒動過的表單存下去，隔天打開日期會停在今天以前。
  update({ store: false });

  function storeDraft() {
    const draft = { source: source.value, day: date.value, notes: notes.value, scores: {} };
    for (const [skill, { got, max }] of inputs) draft.scores[skill] = { got: got.value, max: max.value };
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch { /* 草稿仍留在目前頁面。 */ }
  }

  function restoreDraft() {
    let draft = null;
    try { draft = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? 'null'); } catch { /* 無痕模式或壞掉的草稿就從空白開始。 */ }
    if (!draft || typeof draft !== 'object') return;
    if (typeof draft.source === 'string') source.value = draft.source;
    if (typeof draft.day === 'string' && draft.day) date.value = draft.day;
    if (typeof draft.notes === 'string') notes.value = draft.notes;
    for (const [skill, { got, max }] of inputs) {
      const v = draft.scores?.[skill];
      if (typeof v?.max === 'string' && v.max) { max.value = v.max; got.max = v.max; }
      if (typeof v?.got === 'string') got.value = v.got;
    }
  }

  async function save(ev) {
    ev.preventDefault();
    status.hidden = true;
    const parsed = readScores(inputs);
    if (!parsed) {
      status.textContent = '四科都要填，且分數要介於 0 與各科滿分之間。';
      status.hidden = false;
      return;
    }
    const button = ev.submitter;
    button.disabled = true;
    try {
      const record = await api.mock({ baseline: true, source: source.value.trim() || null, day: date.value, scores: parsed, notes: notes.value.trim() || null });
      try { localStorage.removeItem(DRAFT_KEY); } catch { /* 已儲存的紀錄不受影響。 */ }
      announce('模考已儲存');
      const done = donePanel({
        code: '模考',
        title: 'B1 基準模考',
        line: `${record.day}・${record.total}/${record.maxTotal}`,
        actions: [
          h('button.btn.btn-primary', { type: 'button', text: '看進度', onclick: () => ctx.go('stats') }),
          h('button.btn', { type: 'button', text: '回今天', onclick: () => ctx.go('today') }),
        ],
        after: breakdown(record),
      });
      clear(box).append(done);
      done.querySelector('.landing')?.focus();
      motion.stamp(done.querySelector('.stamp'));
    } catch (err) {
      status.textContent = err.message;
      status.hidden = false;
      button.disabled = false;
    }
  }

  function update({ store = true } = {}) {
    if (store) storeDraft();
    const parsed = readScores(inputs);
    if (!parsed) {
      result.textContent = '填完四科後顯示總分與門檻。';
      result.dataset.tone = '';
      return;
    }
    const total = SKILLS.reduce((n, skill) => n + parsed[skill].score, 0);
    const maxTotal = SKILLS.reduce((n, skill) => n + parsed[skill].maxScore, 0);
    const low = SKILLS.filter((skill) => parsed[skill].score / parsed[skill].maxScore < 0.2);
    const pass = total / maxTotal >= 0.5 && low.length === 0;
    result.textContent = `${total}/${maxTotal}・${pass ? '已跨過目前門檻' : low.length ? `${low.join('、')} 低於單科門檻` : '總分尚未過半'}`;
    result.dataset.tone = pass ? 'ok' : 'warn';
  }
}

function baselineInstruction(skill) {
  return ({
    CE: '計時完成一份閱讀題組，再核對答案。',
    CO: '依正式播放次數完成一份聽力題組。',
    PE: '45 分鐘完成至少 160 mots，依五項規準評分。',
    PO: '完成三部分並回聽錄音，依六項規準評分。',
  })[skill];
}

function readScores(inputs) {
  const out = {};
  for (const [skill, { got, max }] of inputs) {
    const score = Number(got.value);
    const maxScore = Number(max.value);
    if (got.value === '' || !Number.isFinite(score) || !Number.isFinite(maxScore) || maxScore <= 0 || score < 0 || score > maxScore) return null;
    out[skill] = { score, maxScore };
  }
  return out;
}

/**
 * 分科分數。完成面板那一行只寫總分，總分過半仍可能有一科低於單科門檻，
 * 所以四科逐列攤開，低於門檻的那列標出來；也順便填掉面板下方的空白。
 */
function breakdown(record) {
  const list = h('ul.skills');
  for (const skill of SKILLS) {
    const v = record.scores?.[skill];
    if (!v) continue;
    const low = v.score / v.maxScore < 0.2;
    list.append(h('li.skill', { dataset: { low: low ? '1' : '0' } },
      h('span.skill-code', { text: skill }),
      h('div.skill-main', {}, h('span', { text: skillName(skill) }), low ? h('span.dim', { text: '低於單科門檻' }) : null),
      h('span.tally.num', { text: `${v.score}/${v.maxScore}` }),
    ));
  }
  return afterSection('分科', list);
}
