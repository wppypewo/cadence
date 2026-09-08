// 分岔分析：/resume 會把既有訊息原樣複製到新檔，這裡測角色判定與重複位元組的算法。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLineage, findContentEchoes } from '../src/lineage.mjs';
import { uuid } from './helpers.mjs';

/** 造一個 session 列與它的訊息（每則固定 100 bytes）。 */
function mk(id, uuids, { firstTs = '2026-01-01T00:00:00.000Z', bytes = 100 } = {}) {
  return {
    session: { id, msgs: uuids.length, first_ts: firstTs, size: uuids.length * bytes },
    msgs: uuids.map((u) => ({ uuid: u, bytes })),
  };
}

function build(...parts) {
  const sessions = parts.map((p) => p.session);
  const map = new Map(parts.map((p) => [p.session.id, p.msgs]));
  const { rows, groups, sharedUuidCount } = buildLineage(sessions, map);
  return { row: (id) => rows.find((r) => r.sessionId === id), rows, groups, sharedUuidCount };
}

const ids = (a, b) => Array.from({ length: b - a }, (_, i) => uuid(a + i));

test('沒有共用 uuid 的 session 各自是 solo，且分屬不同群', () => {
  const r = build(mk('A', ids(0, 5)), mk('B', ids(100, 105)));
  assert.equal(r.row('A').role, 'solo');
  assert.equal(r.row('B').role, 'solo');
  assert.notEqual(r.row('A').groupId, r.row('B').groupId);
  assert.equal(r.sharedUuidCount, 0);
  assert.equal(r.row('A').redundantBytes, 0);
});

test('分岔：後手複製前 5 則再自己續寫，兩邊同群', () => {
  const A = mk('A', ids(0, 10));
  const B = mk('B', [...ids(0, 5), ...ids(200, 208)]);
  const r = build(A, B);
  assert.equal(r.row('A').groupId, r.row('B').groupId);
  assert.equal(r.row('A').sharedMsgs, 5);
  assert.equal(r.row('B').sharedMsgs, 5);
  assert.equal(r.row('A').uniqueMsgs, 5);
  assert.equal(r.row('B').uniqueMsgs, 8);
  assert.equal(r.sharedUuidCount, 5);
});

test('保留者是訊息較多的那一份，重複位元組算在另一份頭上', () => {
  const r = build(mk('A', ids(0, 10)), mk('B', [...ids(0, 5), ...ids(200, 203)]));
  assert.equal(r.row('A').redundantBytes, 0, 'A 訊息較多，應該是保留者');
  assert.equal(r.row('B').redundantBytes, 500, 'B 的 5 則共用訊息是重複的');
});

test('訊息數相同時比時間，先出現的是保留者', () => {
  const early = mk('A', ids(0, 6), { firstTs: '2026-01-01T00:00:00.000Z' });
  const late = mk('B', [...ids(0, 3), ...ids(300, 303)], { firstTs: '2026-02-01T00:00:00.000Z' });
  const r = build(early, late);
  assert.equal(r.row('A').redundantBytes, 0);
  assert.ok(r.row('B').redundantBytes > 0);
});

test('重複位元組最少的那一份被標成 primary', () => {
  const r = build(mk('A', ids(0, 10)), mk('B', [...ids(0, 5), ...ids(200, 203)]));
  assert.equal(r.row('A').role, 'primary');
  assert.equal(r.row('B').role, 'fork');
});

test('每則訊息都在別處出現、自己沒有獨有內容的檔案標成 subsumed', () => {
  const r = build(mk('A', ids(0, 10)), mk('C', ids(0, 4)));
  assert.equal(r.row('C').role, 'subsumed');
  assert.equal(r.row('C').uniqueMsgs, 0);
  assert.equal(r.row('C').redundantBytes, 400, 'subsumed 的整檔都是重複的');
});

test('三個檔案透過交集連成同一群（傳遞性）', () => {
  // A∩B 有交集、B∩C 有交集，A∩C 沒有——仍應是同一群。
  const A = mk('A', ids(0, 6));
  const B = mk('B', [...ids(3, 6), ...ids(400, 406)]);
  const C = mk('C', [...ids(400, 403), ...ids(500, 505)]);
  const r = build(A, B, C);
  const g = r.row('A').groupId;
  assert.equal(r.row('B').groupId, g);
  assert.equal(r.row('C').groupId, g);
  assert.equal(r.groups.get(g).length, 3);
});

test('relatives 依共用訊息數由多到少排序', () => {
  const A = mk('A', ids(0, 20));
  const B = mk('B', [...ids(0, 10), ...ids(600, 602)]);
  const C = mk('C', [...ids(0, 2), ...ids(700, 706)]);
  const r = build(A, B, C);
  const rel = r.row('A').relatives;
  assert.equal(rel[0].id, 'B');
  assert.equal(rel[0].shared, 10);
  assert.equal(rel[1].id, 'C');
  assert.equal(rel[1].shared, 2);
});

test('沒有 uuid 的訊息一律算成獨有，不會被誤併成一群', () => {
  const A = { session: { id: 'A', msgs: 3, first_ts: null, size: 300 }, msgs: [{ uuid: null, bytes: 100 }, { uuid: null, bytes: 100 }, { uuid: null, bytes: 100 }] };
  const B = { session: { id: 'B', msgs: 2, first_ts: null, size: 200 }, msgs: [{ uuid: null, bytes: 100 }, { uuid: null, bytes: 100 }] };
  const r = build(A, B);
  assert.equal(r.row('A').role, 'solo');
  assert.equal(r.row('B').role, 'solo');
  assert.notEqual(r.row('A').groupId, r.row('B').groupId);
});

test('內容雜湊重疊但無共用 uuid 的，另外報成疑似同源', () => {
  const sessions = [{ id: 'A' }, { id: 'B' }, { id: 'C' }];
  const hashes = new Map([
    ['A', ['h1', 'h2', 'h3', 'h4']],
    ['B', ['h1', 'h2', 'h3', 'h9']],
    ['C', ['z1', 'z2', 'z3']],
  ]);
  const lineageRows = sessions.map((s) => ({ sessionId: s.id, role: 'solo', groupId: 0 }));
  const out = findContentEchoes(sessions, hashes, lineageRows);
  assert.equal(out.length, 1);
  assert.equal(out[0].shared, 3);
  assert.ok(out[0].ratio >= 0.75);
  assert.deepEqual([out[0].a, out[0].b].sort(), ['A', 'B']);
});

test('已經由 uuid 連成同群的，不重複報成疑似同源', () => {
  const sessions = [{ id: 'A' }, { id: 'B' }];
  const hashes = new Map([['A', ['h1', 'h2', 'h3']], ['B', ['h1', 'h2', 'h3']]]);
  const lineageRows = [
    { sessionId: 'A', role: 'primary', groupId: 2 },
    { sessionId: 'B', role: 'fork', groupId: 2 },
  ];
  assert.equal(findContentEchoes(sessions, hashes, lineageRows).length, 0);
});

test('重疊比例低於門檻不報', () => {
  const sessions = [{ id: 'A' }, { id: 'B' }];
  const hashes = new Map([
    ['A', ['h1', 'h2', 'x1', 'x2', 'x3', 'x4', 'x5', 'x6']],
    ['B', ['h1', 'h2', 'y1', 'y2', 'y3', 'y4', 'y5', 'y6']],
  ]);
  const rows = sessions.map((s) => ({ sessionId: s.id, role: 'solo', groupId: 0 }));
  assert.equal(findContentEchoes(sessions, hashes, rows).length, 0);
  assert.equal(findContentEchoes(sessions, hashes, rows, { minRatio: 0.2, minShared: 2 }).length, 1);
});
