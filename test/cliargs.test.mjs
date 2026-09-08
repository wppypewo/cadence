// 參數解析：只測本工具實際會遇到的形式。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, intOpt, parseSince } from '../src/cliargs.mjs';

const SPEC = { flags: ['json', 'color', 'apply', 'yes'], alias: { n: 'limit', o: 'output' } };

test('位置參數與旗標分開收', () => {
  const a = parseArgs(['search', '北海道', '--json'], SPEC);
  assert.deepEqual(a._, ['search', '北海道']);
  assert.equal(a.json, true);
});

test('--no-xxx 把旗標設成 false', () => {
  const a = parseArgs(['--no-color'], SPEC);
  assert.equal(a.color, false);
});

test('--key=value 與 --key value 等價', () => {
  assert.equal(parseArgs(['--out=/tmp/x'], SPEC).out, '/tmp/x');
  assert.equal(parseArgs(['--out', '/tmp/x'], SPEC).out, '/tmp/x');
});

test('短選項走 alias 表', () => {
  assert.equal(parseArgs(['-n', '5'], SPEC).limit, '5');
  assert.equal(parseArgs(['-o', 'r.html'], SPEC).output, 'r.html');
});

test('連字號的長選項轉成 camelCase', () => {
  assert.equal(parseArgs(['--max-bytes', '100'], SPEC).maxBytes, '100');
});

test('後面沒有值的非旗標選項當成 true', () => {
  const a = parseArgs(['--since', '--json'], SPEC);
  assert.equal(a.since, true);
  assert.equal(a.json, true);
});

test('負數可以當成選項的值，不會被誤認成下一個選項', () => {
  assert.equal(parseArgs(['--offset', '-3'], SPEC).offset, '-3');
});

test('-- 之後全部視為位置參數', () => {
  const a = parseArgs(['show', '--', '--json', '-n'], SPEC);
  assert.deepEqual(a._, ['show', '--json', '-n']);
  assert.equal(a.json, undefined);
});

test('defaults 會先鋪底，命令列覆寫它', () => {
  const a = parseArgs(['--limit', '9'], { ...SPEC, defaults: { limit: '20', mode: 'plain' } });
  assert.equal(a.limit, '9');
  assert.equal(a.mode, 'plain');
});

test('intOpt 對缺值與壞值都退回預設', () => {
  assert.equal(intOpt('7', 20), 7);
  assert.equal(intOpt(undefined, 20), 20);
  assert.equal(intOpt(true, 20), 20);
  assert.equal(intOpt('abc', 20), 20);
});

test('parseSince 支援相對寫法與 ISO 日期', () => {
  const d7 = Date.parse(parseSince('7d'));
  const delta = Date.now() - d7;
  assert.ok(Math.abs(delta - 7 * 86400000) < 5000, `7d 應該是七天前，實得 ${delta}`);
  assert.equal(parseSince('2026-08-01').slice(0, 10), '2026-08-01');
  assert.equal(parseSince(null), null);
  assert.equal(parseSince(true), null);
});

test('parseSince 對無法解析的字串要拋錯，不能默默回 null', () => {
  assert.throws(() => parseSince('上個月'), /無法解析時間/);
});
