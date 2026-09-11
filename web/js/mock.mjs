/** 四科模考共同紀錄。分科與總分分開顯示，避免總分蓋掉單科低於門檻。 */

import { h, clear, icon, announce } from './dom.mjs';
import { api } from './net.mjs';

const SKILLS = ['CE', 'CO', 'PE', 'PO'];

export function mockView(root, ctx) {
  const box = h('div.workbench');
  root.append(box);
  const source = h('input.input', { type: 'text', maxlength: 120, placeholder: '例如：France Éducation international 樣題 1' });
  const date = h('input.input', { type: 'date', value: new Date().toLocaleDateString('sv') });
  const notes = h('textarea.input.practice-notes', { maxlength: 4000, placeholder: '時間分配、失分原因、下次要修正的地方（選填）' });
  const status = h('p.field-error', { role: 'alert', hidden: true });
  const result = h('div.mock-result', { 'aria-live': 'polite' });
  const inputs = new Map();

  const scores = h('div.mock-scores');
  for (const skill of SKILLS) {
    const got = h('input.input', { type: 'number', min: 0, max: 25, step: 0.5, inputmode: 'decimal', required: true, oninput: update });
    const max = h('input.input', { type: 'number', min: 0.5, max: 100, step: 0.5, value: '25', inputmode: 'decimal', required: true, oninput: update });
    inputs.set(skill, { got, max });
    scores.append(h('div.mock-score', {}, h('strong', { text: skill }), got, h('span', { text: '/' }), max));
  }

  box.append(
    h('header.page-head', {},
      h('div', {}, h('h2', { text: '模考紀錄' }), h('p', { text: '一次留下四科，總分與各科門檻分開看。' })),
      h('button.btn.btn-quiet', { type: 'button', text: '返回統計', onclick: () => ctx.go('stats') }),
    ),
    h('form.card.practice-form', { onsubmit: save },
      h('div.form-grid', {},
        h('div.field', {}, h('label', { text: '模考來源' }), source),
        h('div.field', {}, h('label', { text: '日期' }), date),
      ),
      h('fieldset.mock-fieldset', {}, h('legend', { text: '四科分數' }), scores),
      result,
      h('div.field', {}, h('label', { text: '檢討' }), notes),
      status,
      h('div.practice-actions', {}, h('button.btn.btn-primary', { type: 'submit', text: '儲存模考' })),
    ),
  );
  update();

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
      const record = await api.mock({ source: source.value.trim() || null, day: date.value, scores: parsed, notes: notes.value.trim() || null });
      announce('模考已儲存');
      clear(box).append(h('div.card.empty', {},
        icon('check'), h('h2.landing', { tabindex: -1, text: '模考已記錄' }),
        h('p', { text: `${record.day}・${record.total}/${record.maxTotal}` }),
        h('div.practice-actions', {},
          h('button.btn.btn-primary', { text: '看統計', onclick: () => ctx.go('stats') }),
          h('button.btn', { text: '回今天', onclick: () => ctx.go('today') }),
        ),
      ));
    } catch (err) {
      status.textContent = err.message;
      status.hidden = false;
      button.disabled = false;
    }
  }

  function update() {
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
