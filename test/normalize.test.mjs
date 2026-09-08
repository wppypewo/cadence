// 位元組歸因與訊息正規化。歸因的核心不變量是：各類別加總等於該行的實際位元組數。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attributeBytes, normalizeMessage, contentToText, sessionMeta,
  BYTE_CATEGORIES, CATEGORY_LABELS,
} from '../src/normalize.mjs';

/** 把一個物件包成 readJsonl 會產出的那種記錄。 */
function rec(o) {
  const line = JSON.stringify(o);
  return { lineNo: 1, bytes: Buffer.byteLength(line, 'utf8'), ok: true, value: o };
}
const sum = (b) => BYTE_CATEGORIES.reduce((s, k) => s + b[k], 0);

test('每個類別都有中文說明，報表不會出現原始 key', () => {
  for (const k of BYTE_CATEGORIES) {
    assert.ok(CATEGORY_LABELS[k], `${k} 缺少說明文字`);
  }
});

test('歸因加總等於該行位元組數', () => {
  const r = rec({
    type: 'user', uuid: 'u1', parentUuid: null, sessionId: 's1',
    timestamp: '2026-01-01T00:00:00.000Z', cwd: '/tmp/demo', version: '2.0.0',
    message: { role: 'user', content: [{ type: 'text', text: '幫我看一下這段程式' }] },
  });
  const b = attributeBytes(r);
  assert.equal(sum(b), r.bytes);
});

test('對話文字進 text，識別碼進 ids，環境欄位進 context', () => {
  const r = rec({
    type: 'user', uuid: 'u1', parentUuid: 'u0', sessionId: 's1',
    cwd: '/some/very/long/working/directory/path', version: '2.0.0',
    message: { role: 'user', content: [{ type: 'text', text: 'x'.repeat(500) }] },
  });
  const b = attributeBytes(r);
  assert.ok(b.text >= 500, 'text 應該至少含那 500 個字元');
  assert.ok(b.ids > 0);
  assert.ok(b.context > 0);
  assert.equal(b.thinking, 0);
});

test('思考簽章與思考內容分開計，簽章不算成內容', () => {
  const r = rec({
    type: 'assistant', uuid: 'a1', sessionId: 's1',
    message: {
      role: 'assistant', model: 'claude-opus-5',
      content: [{ type: 'thinking', thinking: '想一下', signature: 'S'.repeat(400) }],
    },
  });
  const b = attributeBytes(r);
  assert.ok(b.signature >= 400, `簽章應該獨立計算，實得 ${b.signature}`);
  assert.ok(b.thinking > 0 && b.thinking < 40);
  assert.equal(sum(b), r.bytes);
});

test('工具呼叫的參數進 tool_use，token 計量進 usage', () => {
  const r = rec({
    type: 'assistant', uuid: 'a1', sessionId: 's1',
    message: {
      role: 'assistant', model: 'claude-opus-5',
      content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls -la /tmp' } }],
      usage: { input_tokens: 1000, output_tokens: 20, cache_read_input_tokens: 50000 },
    },
  });
  const b = attributeBytes(r);
  assert.ok(b.tool_use > 0);
  assert.ok(b.usage > 0);
  assert.equal(b.text, 0);
});

test('toolUseResult 是與 tool_result 重複的第二份，要獨立成一類', () => {
  const payload = { stdout: 'y'.repeat(600), stderr: '' };
  const r = rec({
    type: 'user', uuid: 'u1', sessionId: 's1',
    toolUseResult: payload,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'y'.repeat(600) }] }],
    },
  });
  const b = attributeBytes(r);
  assert.ok(b.tool_result_dup >= 600, `副本應被單獨計算，實得 ${b.tool_result_dup}`);
  assert.ok(b.tool_result >= 600);
  assert.equal(sum(b), r.bytes);
});

test('工具結果裡的內嵌影像歸 image，不混進 tool_result', () => {
  const r = rec({
    type: 'user', uuid: 'u1', sessionId: 's1',
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        content: [
          { type: 'text', text: '截圖如下' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(2000) } },
        ],
      }],
    },
  });
  const b = attributeBytes(r);
  assert.ok(b.image >= 2000);
  assert.ok(b.tool_result > 0 && b.tool_result < 200);
});

test('attachment 這類清單型的行單獨成一類', () => {
  const r = rec({ type: 'user', uuid: 'u1', attachment: { type: 'deferred_tools_delta', tools: Array.from({ length: 50 }, (_, i) => `tool_${i}`) } });
  const b = attributeBytes(r);
  assert.ok(b.attachment > 300);
});

test('壞行整行算進 envelope，不會被漏掉', () => {
  const b = attributeBytes({ lineNo: 9, bytes: 1234, ok: false, value: null });
  assert.equal(b.envelope, 1234);
  assert.equal(sum(b), 1234);
});

test('contentToText 攤平內容，思考預設不納入', () => {
  const content = [
    { type: 'thinking', thinking: '內心話' },
    { type: 'text', text: '正文' },
    { type: 'tool_use', name: 'Bash', input: {} },
  ];
  assert.equal(contentToText(content), '正文\n[工具呼叫 Bash]');
  assert.match(contentToText(content, { includeThinking: true }), /內心話/);
  assert.equal(contentToText('純字串'), '純字串');
  assert.equal(contentToText(undefined), '');
});

test('normalizeMessage 取出角色、時間、工具名與雜湊', () => {
  const r = rec({
    type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: 's1',
    timestamp: '2026-01-01T00:00:00.000Z',
    message: {
      role: 'assistant', model: 'claude-opus-5',
      content: [{ type: 'text', text: '好的' }, { type: 'tool_use', name: 'Read', input: {} }],
      usage: { input_tokens: 5, output_tokens: 7 },
    },
  });
  const m = normalizeMessage(r, 3);
  assert.equal(m.role, 'assistant');
  assert.equal(m.seq, 3);
  assert.equal(m.model, 'claude-opus-5');
  assert.deepEqual(m.toolNames, ['Read']);
  assert.equal(m.usage.input, 5);
  assert.equal(m.hash.length, 16);
});

test('同樣的文字得到同樣的雜湊，這是內容比對的基礎', () => {
  const mk = (t) => normalizeMessage(rec({ type: 'user', uuid: 'x', message: { role: 'user', content: [{ type: 'text', text: t }] } }), 0);
  assert.equal(mk('一樣的話').hash, mk('一樣的話').hash);
  assert.notEqual(mk('一樣的話').hash, mk('不一樣的話').hash);
});

test('系統插入的提醒被標成 meta，不會被當成使用者提問', () => {
  const m = normalizeMessage(rec({
    type: 'user', uuid: 'u1',
    message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>請注意</system-reminder>' }] },
  }), 0);
  assert.equal(m.isMeta, true);
});

test('非對話行回傳 null', () => {
  assert.equal(normalizeMessage(rec({ type: 'summary', summary: '標題' }), 0), null);
  assert.equal(normalizeMessage({ ok: false, bytes: 10, value: null }, 0), null);
});

test('sessionMeta 認得三種標題來源', () => {
  assert.deepEqual(sessionMeta({ type: 'custom-title', customTitle: '手動命名' }), { title: '手動命名', titleSource: 'custom' });
  assert.deepEqual(sessionMeta({ type: 'ai-title', aiTitle: '自動命名' }), { title: '自動命名', titleSource: 'ai' });
  assert.deepEqual(sessionMeta({ type: 'summary', summary: '壓縮摘要' }), { title: '壓縮摘要', titleSource: 'summary' });
  assert.equal(sessionMeta({ type: 'user' }), null);
  assert.equal(sessionMeta(null), null);
});
