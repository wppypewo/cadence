// 使用統計：從索引直接算，不重讀原檔。
import { openDb, allSessions } from '../store.mjs';
import { dbPath, shortProject } from '../paths.mjs';
import { c, bytes, num, pct, table, kv, bar, heading, truncate, day, date } from '../fmt.mjs';
import { intOpt, parseSince } from '../cliargs.mjs';

export const spec = { flags: ['hours', 'weekday', 'months'], alias: { n: 'limit', p: 'project' } };

export function help() {
  return `${c.bold('ccarchive stats')} — 使用統計

用法  ccarchive stats [選項]

  -p, --project <關鍵字>  只算符合的專案
      --since <時間>      只算此時間之後（2026-01-01 或 30d / 4w / 6m）
      --months            逐月活躍度
      --weekday           星期分布
      --hours             一天中的時段分布
  -n, --limit <數字>      明細列幾筆（預設 10）
      --json              JSON 輸出`;
}

export async function run(args) {
  const db = openDb(dbPath(args.out), { create: false });
  let sessions = allSessions(db);
  if (args.project && args.project !== true) {
    const q = String(args.project).toLowerCase();
    sessions = sessions.filter((s) => (s.cwd || '').toLowerCase().includes(q));
  }
  if (args.since) {
    const since = parseSince(args.since);
    sessions = sessions.filter((s) => (s.last_ts || '') >= since);
  }
  if (sessions.length === 0) { db.close(); process.stdout.write(`${c.dim('沒有符合條件的 session。')}\n`); return 1; }

  const ids = new Set(sessions.map((s) => s.id));
  const msgRows = db.prepare("SELECT session_id, role, ts, sidechain FROM messages WHERE ts IS NOT NULL").all()
    .filter((r) => ids.has(r.session_id));
  db.close();

  const totals = agg(sessions);
  const buckets = timeBuckets(msgRows);
  const limit = intOpt(args.limit, 10);

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ totals, buckets, projects: byProject(sessions), tools: topTools(sessions), models: topModels(sessions) }, null, 2)}\n`);
    return 0;
  }

  const span = totals.firstTs && totals.lastTs
    ? Math.max(1, Math.round((Date.parse(totals.lastTs) - Date.parse(totals.firstTs)) / 86400000))
    : 1;

  process.stdout.write(`${heading('總覽')}\n`);
  process.stdout.write(`${kv([
    ['期間', `${date(totals.firstTs)} → ${date(totals.lastTs)}`, `${num(span)} 天`],
    ['session', num(sessions.length), `平均 ${(sessions.length / span).toFixed(1)} 個/天`],
    ['訊息', num(totals.msgs), `你 ${num(totals.userMsgs)} · Claude ${num(totals.asstMsgs)}${totals.sidechainMsgs ? ` · 子代理 ${num(totals.sidechainMsgs)}` : ''}`],
    ['磁碟', bytes(totals.size), `平均每個 session ${bytes(Math.round(totals.size / sessions.length))}`],
    ['活躍天數', num(buckets.activeDays), `${pct(buckets.activeDays, span)} 的日子有用`],
    ['最忙的一天', buckets.busiestDay?.k || '—', buckets.busiestDay ? `${num(buckets.busiestDay.v)} 則訊息` : ''],
  ])}\n`);

  process.stdout.write(`\n${heading('token 用量')}\n`);
  const t = totals.tokens;
  const cacheTotal = t.cacheRead + t.cacheWrite;
  process.stdout.write(`${kv([
    ['輸入', num(t.input), ''],
    ['輸出', num(t.output), ''],
    ['快取讀取', num(t.cacheRead), cacheTotal ? `佔全部讀取 ${pct(t.cacheRead, t.cacheRead + t.input)}` : ''],
    ['快取寫入', num(t.cacheWrite), ''],
  ])}\n`);
  if (t.cacheRead > t.input * 10) {
    process.stdout.write(`\n  ${c.dim(`快取讀取是新輸入的 ${Math.round(t.cacheRead / Math.max(1, t.input))} 倍——長對話的成本幾乎全在重讀既有脈絡。`)}\n`);
  }

  process.stdout.write(`\n${heading('專案')}\n`);
  const projects = byProject(sessions).slice(0, limit);
  const pmax = projects[0]?.msgs || 1;
  process.stdout.write(`${table(projects, [
    { label: '專案', value: (p) => truncate(shortProject(p.name), 32) },
    { label: 'session', align: 'right', value: (p) => num(p.sessions) },
    { label: '訊息', align: 'right', value: (p) => num(p.msgs) },
    { label: '大小', align: 'right', value: (p) => bytes(p.size) },
    { label: '最後活動', value: (p) => date(p.lastTs) },
    { label: '', value: (p) => c.dim(bar(p.msgs, pmax, 16)) },
  ], { indent: '  ' })}\n`);

  process.stdout.write(`\n${heading('模型')}\n`);
  const models = topModels(sessions);
  const mmax = models[0]?.n || 1;
  process.stdout.write(`${table(models, [
    { label: '模型', value: (m) => truncate(m.name, 30) },
    { label: '訊息', align: 'right', value: (m) => num(m.n) },
    { label: '佔比', align: 'right', value: (m) => pct(m.n, models.reduce((s, x) => s + x.n, 0)) },
    { label: '', value: (m) => c.dim(bar(m.n, mmax, 20)) },
  ], { indent: '  ' })}\n`);

  process.stdout.write(`\n${heading(`最常用的工具（前 ${limit}）`)}\n`);
  const tools = topTools(sessions).slice(0, limit);
  const tmax = tools[0]?.calls || 1;
  process.stdout.write(`${table(tools, [
    { label: '工具', value: (r) => truncate(r.name, 34) },
    { label: '呼叫', align: 'right', value: (r) => num(r.calls) },
    { label: '', value: (r) => c.dim(bar(r.calls, tmax, 22)) },
  ], { indent: '  ' })}\n`);

  if (args.months) renderBuckets('逐月活躍度', buckets.months, '則訊息');
  if (args.weekday) renderBuckets('星期分布', buckets.weekdays, '則訊息');
  if (args.hours) renderBuckets('時段分布（本機時間）', buckets.hours, '則訊息');
  if (!args.months && !args.weekday && !args.hours) {
    process.stdout.write(`\n  ${c.dim('加 --months / --weekday / --hours 看時間分布。')}\n`);
  }
  return 0;
}

function renderBuckets(title, rows, unit) {
  process.stdout.write(`\n${heading(title)}\n`);
  const max = Math.max(...rows.map((r) => r.v), 1);
  process.stdout.write(`${table(rows, [
    { label: '', value: (r) => r.k },
    { label: '', align: 'right', value: (r) => num(r.v) },
    { label: '', value: (r) => (r.v ? c.cyan(bar(r.v, max, 34)) : c.dim('·')) },
  ], { indent: '  ' })}\n`);
  process.stdout.write(`  ${c.dim(`單位：${unit}`)}\n`);
}

function agg(sessions) {
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let msgs = 0, userMsgs = 0, asstMsgs = 0, sidechainMsgs = 0, size = 0;
  let firstTs = null, lastTs = null;
  for (const s of sessions) {
    msgs += s.msgs; userMsgs += s.user_msgs; asstMsgs += s.asst_msgs;
    sidechainMsgs += s.sidechain_msgs; size += s.size;
    for (const k of Object.keys(tokens)) tokens[k] += s.tokens?.[k] || 0;
    if (s.first_ts && (!firstTs || s.first_ts < firstTs)) firstTs = s.first_ts;
    if (s.last_ts && (!lastTs || s.last_ts > lastTs)) lastTs = s.last_ts;
  }
  return { msgs, userMsgs, asstMsgs, sidechainMsgs, size, tokens, firstTs, lastTs };
}

function byProject(sessions) {
  const m = new Map();
  for (const s of sessions) {
    let r = m.get(s.project);
    if (!r) { r = { name: s.project, cwd: s.cwd, sessions: 0, msgs: 0, size: 0, lastTs: null }; m.set(s.project, r); }
    r.sessions++; r.msgs += s.msgs; r.size += s.size;
    if (s.last_ts && (!r.lastTs || s.last_ts > r.lastTs)) r.lastTs = s.last_ts;
  }
  return [...m.values()].sort((a, b) => b.msgs - a.msgs);
}

function topTools(sessions) {
  const m = new Map();
  for (const s of sessions) for (const [k, v] of Object.entries(s.tools || {})) m.set(k, (m.get(k) || 0) + v);
  return [...m].map(([name, calls]) => ({ name, calls })).sort((a, b) => b.calls - a.calls);
}

function topModels(sessions) {
  const m = new Map();
  for (const s of sessions) for (const [k, v] of Object.entries(s.models || {})) m.set(k, (m.get(k) || 0) + v);
  return [...m].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n);
}

const WEEKDAYS = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];

function timeBuckets(rows) {
  const days = new Map(), months = new Map();
  const weekdays = new Array(7).fill(0), hours = new Array(24).fill(0);
  for (const r of rows) {
    const d = new Date(r.ts);
    if (Number.isNaN(d.getTime())) continue;
    const dk = day(r.ts);
    days.set(dk, (days.get(dk) || 0) + 1);
    const mk = dk.slice(0, 7);
    months.set(mk, (months.get(mk) || 0) + 1);
    weekdays[d.getDay()]++;
    hours[d.getHours()]++;
  }
  let busiestDay = null;
  for (const [k, v] of days) if (!busiestDay || v > busiestDay.v) busiestDay = { k, v };
  return {
    activeDays: days.size,
    busiestDay,
    months: [...months].sort().map(([k, v]) => ({ k, v })),
    weekdays: weekdays.map((v, i) => ({ k: WEEKDAYS[i], v })),
    hours: hours.map((v, i) => ({ k: `${String(i).padStart(2, '0')}:00`, v })),
  };
}
