// 分岔分析：把共用訊息 uuid 的 session 分群，指出哪一份最完整、哪些是分岔複本。
import { openDb, allSessions, resolveSessionId } from '../store.mjs';
import { dbPath } from '../paths.mjs';
import { c, bytes, num, table, kv, date, truncate, heading, pct } from '../fmt.mjs';

export const spec = { flags: ['echoes', 'all'], alias: { n: 'limit', g: 'group' } };

export function help() {
  return `${c.bold('ccarchive lineage')} — 分岔分析

用法  ccarchive lineage [選項]
      ccarchive lineage <ID 前綴>      只看某個 session 所屬的群

  -g, --group <編號>   只看指定群組
  -n, --limit <數字>   最多顯示幾個群（預設 12）
      --all            顯示全部群組
      --echoes         另外列出「內容疑似同源但無 uuid 關聯」的配對
      --json           JSON 輸出

${c.dim('角色')}
  primary   群內重複位元組最少者，通常是最該保留的一份
  fork      由 /resume 或續接產生、與別人共用開頭的分岔
  subsumed  全部訊息都能在別處找到，理論上可安全移除
  solo      沒有任何共用訊息

${c.dim('注意')}  「共用」以訊息 uuid 交集為準，不是靠檔案內容比對。
      subsumed 為 0 代表沒有整檔可丟——這是實測結果，不是保守估計。`;
}

export async function run(args) {
  const db = openDb(dbPath(args.out), { create: false });
  const sessions = allSessions(db);
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const rows = db.prepare('SELECT * FROM lineage').all()
    .map((r) => ({ ...r, relatives: JSON.parse(r.relatives || '[]') }));
  const lin = new Map(rows.map((r) => [r.session_id, r]));

  let focusGroup = null;
  if (args._[0]) {
    const id = resolveSessionId(db, String(args._[0]));
    if (!id) { db.close(); throw new Error(`找不到 session：${args._[0]}`); }
    const r = lin.get(id);
    if (!r) { db.close(); throw new Error('該 session 尚未做過分岔分析，請重新 scan'); }
    focusGroup = r.group_id;
  } else if (args.group !== undefined && args.group !== true) {
    focusGroup = Number(args.group);
  }

  const echoes = args.echoes ? JSON.parse(db.prepare("SELECT v FROM meta WHERE k = 'echoes'").get()?.v || '[]') : [];
  db.close();

  // 分群
  const groups = new Map();
  for (const r of rows) {
    if (r.role === 'solo') continue;
    const g = groups.get(r.group_id) || [];
    g.push(r); groups.set(r.group_id, g);
  }
  for (const g of groups.values()) {
    g.sort((a, b) => a.redundant_bytes - b.redundant_bytes || b.unique_msgs - a.unique_msgs);
  }

  const tally = { solo: 0, fork: 0, primary: 0, subsumed: 0 };
  let redundantTotal = 0, totalBytes = 0;
  for (const r of rows) {
    tally[r.role] = (tally[r.role] || 0) + 1;
    redundantTotal += r.redundant_bytes;
    totalBytes += (byId.get(r.session_id)?.size) || 0;
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify({
      summary: { ...tally, groups: groups.size, redundantBytes: redundantTotal, totalBytes },
      groups: [...groups].map(([id, list]) => ({ id, members: list })),
      echoes,
    }, null, 2)}\n`);
    return 0;
  }

  // 總覽
  process.stdout.write(`${heading('分岔總覽')}\n`);
  process.stdout.write(`${kv([
    ['session 總數', num(rows.length), ''],
    ['分岔群組', num(groups.size), `涵蓋 ${num(rows.length - tally.solo)} 個 session`],
    ['primary', num(tally.primary), '群內最該保留的一份'],
    ['fork', num(tally.fork), '與別人共用開頭'],
    ['subsumed', num(tally.subsumed), tally.subsumed === 0 ? '沒有整檔可直接丟' : '全部訊息都在別處'],
    ['solo', num(tally.solo), '無共用訊息'],
    ['重複位元組', bytes(redundantTotal), `佔存檔 ${pct(redundantTotal, totalBytes)}`],
  ])}\n`);

  if (tally.subsumed === 0) {
    process.stdout.write(`\n${c.dim('  ')}${c.yellow('※')} ${c.dim('重複位元組分散在多個檔案的開頭，沒有任何一個檔案的訊息能被別人完全覆蓋。')}\n`);
    process.stdout.write(`${c.dim('    刪整個 session 檔一定會連帶失去獨有內容——這就是「刪短對話沒用」的原因。')}\n`);
  }

  // 群組明細
  const limit = args.all ? Infinity : (args.limit && args.limit !== true ? Number(args.limit) : 12);
  let list = [...groups.entries()].sort((a, b) => sumRedundant(b[1]) - sumRedundant(a[1]));
  if (focusGroup !== null) list = list.filter(([id]) => id === focusGroup);

  process.stdout.write(`\n${heading(focusGroup !== null ? `群組 #${focusGroup}` : `分岔群組（依重複量排序，顯示 ${Math.min(limit, list.length)}/${list.length}）`)}\n`);

  for (const [gid, members] of list.slice(0, limit)) {
    const label = members.map((m) => byId.get(m.session_id)?.title).find(Boolean) || '未命名';
    process.stdout.write(`\n  ${c.bold(`#${gid}`)} ${c.cyan(truncate(label, 40))}  ${c.dim(`${members.length} 個檔案 · 重複 ${bytes(sumRedundant(members))}`)}\n`);
    process.stdout.write(`${table(members.map((m) => ({ m, s: byId.get(m.session_id) || {} })), [
      { label: '角色', value: (r) => roleBadge(r.m.role) },
      { label: 'ID', value: (r) => c.cyan(r.m.session_id.slice(0, 8)) },
      { label: '最後活動', value: (r) => date(r.s.last_ts) },
      { label: '獨有', align: 'right', value: (r) => num(r.m.unique_msgs) },
      { label: '共用', align: 'right', value: (r) => num(r.m.shared_msgs) },
      { label: '大小', align: 'right', value: (r) => bytes(r.s.size || 0) },
      { label: '重複', align: 'right', value: (r) => (r.m.redundant_bytes ? c.yellow(bytes(r.m.redundant_bytes)) : c.dim('—')) },
      { label: '標題', value: (r) => truncate(r.s.title || '', 24) },
    ], { indent: '    ' })}\n`);
  }

  if (!args.all && list.length > limit) {
    process.stdout.write(`\n  ${c.dim(`還有 ${list.length - limit} 個群組，加 --all 顯示全部。`)}\n`);
  }

  if (args.echoes) {
    process.stdout.write(`\n${heading('內容疑似同源（無 uuid 關聯）')}\n`);
    if (echoes.length === 0) {
      process.stdout.write(`  ${c.dim('沒有發現。')}\n`);
    } else {
      process.stdout.write(`${table(echoes.slice(0, 20), [
        { label: 'A', value: (e) => c.cyan(e.a.slice(0, 8)) },
        { label: 'B', value: (e) => c.cyan(e.b.slice(0, 8)) },
        { label: '重疊', align: 'right', value: (e) => `${num(e.shared)}/${num(e.smallSize)}` },
        { label: '比例', align: 'right', value: (e) => `${(e.ratio * 100).toFixed(0)}%` },
        { label: '標題', value: (e) => truncate(byId.get(e.a)?.title || '', 30) },
      ], { indent: '  ' })}\n`);
      process.stdout.write(`\n  ${c.dim('這是提示，不是回收依據——compact 續接會重寫訊息，uuid 全新但內容重疊。')}\n`);
    }
  }
  return 0;
}

function sumRedundant(list) { return list.reduce((s, m) => s + m.redundant_bytes, 0); }

function roleBadge(role) {
  switch (role) {
    case 'primary': return c.green('primary');
    case 'fork': return c.yellow('fork');
    case 'subsumed': return c.red('subsumed');
    default: return c.dim('solo');
  }
}
