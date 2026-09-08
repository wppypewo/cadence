// 空間分析：把存檔的位元組拆成 12 類，指出「對話文字」其實只佔一小部分。
import { openDb, allSessions } from '../store.mjs';
import { dbPath } from '../paths.mjs';
import { BYTE_CATEGORIES, CATEGORY_LABELS } from '../normalize.mjs';
import { shortProject } from '../paths.mjs';
import { c, bytes, num, pct, table, kv, bar, heading, truncate } from '../fmt.mjs';
import { intOpt } from '../cliargs.mjs';

export const spec = { flags: ['by-project', 'by-session', 'tools'], alias: { n: 'limit', p: 'project' } };

export function help() {
  return `${c.bold('ccarchive bloat')} — 空間分析

用法  ccarchive bloat [選項]

  -p, --project <關鍵字>  只算符合的專案
      --by-project        依專案拆解
      --by-session        列出最肥的 session 與其主因
      --tools             列出最耗空間的工具
  -n, --limit <數字>      明細列幾筆（預設 15）
      --json              JSON 輸出

${c.dim('分類說明')}
  對話文字      你和 Claude 真正說的話
  工具結果      工具回傳的內容（message.content 內）
  工具結果副本  同一份工具結果被存進 toolUseResult 的第二份
  思考簽章      thinking 區塊的加密簽章，無法閱讀也無法重建
  附加清單      attachment 欄位（目錄樹、檔案摘要等自動附掛）
  JSON 結構     括號、欄位名、逗號等純結構開銷`;
}

export async function run(args) {
  const db = openDb(dbPath(args.out), { create: false });
  let sessions = allSessions(db);
  const sidecars = db.prepare('SELECT * FROM sidecars').all();
  db.close();

  if (args.project && args.project !== true) {
    const q = String(args.project).toLowerCase();
    sessions = sessions.filter((s) => (s.cwd || '').toLowerCase().includes(q));
  }
  if (sessions.length === 0) { process.stdout.write(`${c.dim('沒有符合條件的 session。')}\n`); return 1; }

  const total = sum(sessions.map((s) => s.size));
  const totals = Object.fromEntries(BYTE_CATEGORIES.map((k) => [k, 0]));
  for (const s of sessions) for (const k of BYTE_CATEGORIES) totals[k] += s.bytesBy[k] || 0;
  const accounted = sum(Object.values(totals));
  const sidecarBytes = sum(sidecars.map((r) => r.bytes));

  if (args.json) {
    process.stdout.write(`${JSON.stringify({
      sessions: sessions.length, totalBytes: total, categories: totals, sidecarBytes,
      byProject: byProject(sessions), bySession: bySession(sessions), tools: toolCost(sessions),
    }, null, 2)}\n`);
    return 0;
  }

  const limit = intOpt(args.limit, 15);

  process.stdout.write(`${heading('存檔規模')}\n`);
  process.stdout.write(`${kv([
    ['對話檔', bytes(total), `${num(sessions.length)} 個 session`],
    ['工具快取', bytes(sidecarBytes), `${num(sidecars.length)} 個目錄（shell-snapshots / todos 等）`],
    ['合計', bytes(total + sidecarBytes), ''],
  ])}\n`);

  process.stdout.write(`\n${heading('位元組去了哪裡')}\n`);
  const cats = BYTE_CATEGORIES.map((k) => ({ k, v: totals[k] })).filter((r) => r.v > 0)
    .sort((a, b) => b.v - a.v);
  const max = cats[0]?.v || 1;
  process.stdout.write(`${table(cats, [
    { label: '類別', value: (r) => CATEGORY_LABELS[r.k] || r.k },
    { label: '大小', align: 'right', value: (r) => bytes(r.v) },
    { label: '佔比', align: 'right', value: (r) => pct(r.v, accounted) },
    { label: '', value: (r) => barColor(r.k, bar(r.v, max, 28)) },
  ], { indent: '  ' })}\n`);

  const text = totals.text + totals.thinking;
  process.stdout.write(`\n  ${c.dim('真正的對話內容（文字＋思考）')} ${c.bold(bytes(text))} ${c.dim(`＝ 全部的 ${pct(text, accounted)}`)}\n`);
  if (totals.tool_result_dup > 0) {
    process.stdout.write(`  ${c.yellow('※')} ${c.dim(`「工具結果副本」是同一份結果的第二份拷貝，佔 ${pct(totals.tool_result_dup, accounted)}——這是格式本身的重複，不是你的使用方式造成的。`)}\n`);
  }

  if (args.byProject || args['by-project']) {
    process.stdout.write(`\n${heading('依專案')}\n`);
    const rows = byProject(sessions).slice(0, limit);
    const pmax = rows[0]?.bytes || 1;
    process.stdout.write(`${table(rows, [
      { label: '專案', value: (r) => truncate(shortProject(r.name), 34) },
      { label: 'session', align: 'right', value: (r) => num(r.sessions) },
      { label: '大小', align: 'right', value: (r) => bytes(r.bytes) },
      { label: '佔比', align: 'right', value: (r) => pct(r.bytes, total) },
      { label: '主因', value: (r) => `${CATEGORY_LABELS[r.top] || r.top} ${pct(r.topBytes, r.bytes)}` },
      { label: '', value: (r) => c.dim(bar(r.bytes, pmax, 18)) },
    ], { indent: '  ' })}\n`);
  }

  if (args.bySession || args['by-session']) {
    process.stdout.write(`\n${heading('最肥的 session')}\n`);
    const rows = bySession(sessions).slice(0, limit);
    process.stdout.write(`${table(rows, [
      { label: 'ID', value: (r) => c.cyan(r.id.slice(0, 8)) },
      { label: '大小', align: 'right', value: (r) => bytes(r.size) },
      { label: '訊息', align: 'right', value: (r) => num(r.msgs) },
      { label: '每則', align: 'right', value: (r) => bytes(Math.round(r.size / Math.max(1, r.msgs))) },
      { label: '主因', value: (r) => `${CATEGORY_LABELS[r.top] || r.top} ${pct(r.topBytes, r.size)}` },
      { label: '標題', value: (r) => truncate(r.title || c.dim('（無標題）'), 30) },
    ], { indent: '  ' })}\n`);
  }

  if (args.tools) {
    process.stdout.write(`\n${heading('工具呼叫次數')}\n`);
    const rows = toolCost(sessions).slice(0, limit);
    const tmax = rows[0]?.calls || 1;
    process.stdout.write(`${table(rows, [
      { label: '工具', value: (r) => truncate(r.name, 36) },
      { label: '呼叫', align: 'right', value: (r) => num(r.calls) },
      { label: 'session', align: 'right', value: (r) => num(r.sessions) },
      { label: '', value: (r) => c.dim(bar(r.calls, tmax, 24)) },
    ], { indent: '  ' })}\n`);
    process.stdout.write(`\n  ${c.dim('註：這是呼叫次數，不是位元組——單筆結果大小差異很大，索引不逐筆歸戶到工具。')}\n`);
  }

  if (!args.byProject && !args['by-project'] && !args.bySession && !args['by-session'] && !args.tools) {
    process.stdout.write(`\n  ${c.dim('加 --by-project / --by-session / --tools 看明細。')}\n`);
  }
  return 0;
}

function sum(xs) { return xs.reduce((a, b) => a + (b || 0), 0); }

function topCat(bytesBy) {
  let top = 'envelope', v = -1;
  for (const k of BYTE_CATEGORIES) {
    const n = bytesBy[k] || 0;
    if (n > v) { v = n; top = k; }
  }
  return { top, topBytes: v };
}

function byProject(sessions) {
  const m = new Map();
  for (const s of sessions) {
    let r = m.get(s.project);
    if (!r) { r = { name: s.project, cwd: s.cwd, sessions: 0, bytes: 0, by: {} }; m.set(s.project, r); }
    r.sessions++; r.bytes += s.size;
    for (const k of BYTE_CATEGORIES) r.by[k] = (r.by[k] || 0) + (s.bytesBy[k] || 0);
  }
  return [...m.values()].map((r) => ({ ...r, ...topCat(r.by) })).sort((a, b) => b.bytes - a.bytes);
}

function bySession(sessions) {
  return sessions.map((s) => ({
    id: s.id, size: s.size, msgs: s.msgs, title: s.title, project: s.cwd, ...topCat(s.bytesBy),
  })).sort((a, b) => b.size - a.size);
}

function toolCost(sessions) {
  const m = new Map();
  for (const s of sessions) {
    for (const [name, n] of Object.entries(s.tools || {})) {
      let r = m.get(name);
      if (!r) { r = { name, calls: 0, sessions: 0 }; m.set(name, r); }
      r.calls += n; r.sessions++;
    }
  }
  return [...m.values()].sort((a, b) => b.calls - a.calls);
}

// 讓「真正的內容」和「格式開銷」在視覺上分得開。
function barColor(k, s) {
  if (k === 'text' || k === 'thinking') return c.green(s);
  if (k === 'tool_result_dup' || k === 'envelope' || k === 'signature') return c.yellow(s);
  return c.dim(s);
}
