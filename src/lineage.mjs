// 分岔分析：/resume 與續接會把既有訊息原樣複製到新的 session 檔，
// 造成同一段對話在磁碟上存在多份。這裡用訊息 uuid 的交集把這些檔案連成群組，
// 並算出每個檔案「自己獨有」與「與別人重複」的部分。

/**
 * @param {Array} sessions  來自 store.allSessions 的列（需含 id, msgs, first_ts, size）
 * @param {Map<string, Array<{uuid, bytes}>>} messagesBySession
 */
export function buildLineage(sessions, messagesBySession) {
  const byId = new Map(sessions.map((s) => [s.id, s]));

  // uuid → 擁有該訊息的 session 清單
  const owners = new Map();
  for (const [sid, msgs] of messagesBySession) {
    for (const m of msgs) {
      if (!m.uuid) continue;
      let list = owners.get(m.uuid);
      if (!list) { list = []; owners.set(m.uuid, list); }
      if (!list.includes(sid)) list.push(sid);
    }
  }

  // 只有多重擁有者的 uuid 才有意義
  const shared = new Map();
  for (const [uuid, list] of owners) if (list.length > 1) shared.set(uuid, list);

  // union-find 把有交集的 session 併成群
  const parent = new Map(sessions.map((s) => [s.id, s.id]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  for (const list of shared.values()) for (let i = 1; i < list.length; i++) union(list[0], list[i]);

  // 每個 uuid 的保留者：訊息數最多者優先，其次時間最早，最後比 id 求穩定
  const keeper = new Map();
  for (const [uuid, list] of shared) {
    let best = null;
    for (const sid of list) {
      const s = byId.get(sid);
      if (!s) continue;
      if (!best || better(s, byId.get(best))) best = sid;
    }
    keeper.set(uuid, best);
  }

  // 兩兩重疊計數，用來描述群內關係
  const pairCount = new Map();
  for (const list of shared.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const k = list[i] < list[j] ? `${list[i]}|${list[j]}` : `${list[j]}|${list[i]}`;
        pairCount.set(k, (pairCount.get(k) || 0) + 1);
      }
    }
  }

  const rows = [];
  const groupSeen = new Map();
  for (const s of sessions) {
    const msgs = messagesBySession.get(s.id) || [];
    let sharedMsgs = 0, uniqueMsgs = 0, sharedBytes = 0, uniqueBytes = 0, redundantBytes = 0;
    for (const m of msgs) {
      if (m.uuid && shared.has(m.uuid)) {
        sharedMsgs++; sharedBytes += m.bytes;
        if (keeper.get(m.uuid) !== s.id) redundantBytes += m.bytes;
      } else {
        uniqueMsgs++; uniqueBytes += m.bytes;
      }
    }
    const root = find(s.id);
    let gid = groupSeen.get(root);
    if (gid === undefined) { gid = groupSeen.size; groupSeen.set(root, gid); }

    const relatives = [];
    for (const [k, n] of pairCount) {
      const [a, b] = k.split('|');
      if (a === s.id) relatives.push({ id: b, shared: n });
      else if (b === s.id) relatives.push({ id: a, shared: n });
    }
    relatives.sort((x, y) => y.shared - x.shared);

    rows.push({
      sessionId: s.id,
      groupId: gid,
      role: sharedMsgs === 0 ? 'solo' : uniqueMsgs === 0 ? 'subsumed' : 'fork',
      sharedMsgs, uniqueMsgs, sharedBytes, uniqueBytes, redundantBytes,
      relatives: relatives.slice(0, 8),
    });
  }

  // 群內把重複位元組最少者標成 primary，方便報表指出「這群留哪一個」
  const byGroup = new Map();
  for (const r of rows) {
    if (r.role === 'solo') continue;
    const list = byGroup.get(r.groupId) || [];
    list.push(r); byGroup.set(r.groupId, list);
  }
  for (const list of byGroup.values()) {
    list.sort((a, b) => a.redundantBytes - b.redundantBytes || b.uniqueMsgs - a.uniqueMsgs);
    if (list[0] && list[0].role === 'fork') list[0].role = 'primary';
  }

  return { rows, groups: byGroup, sharedUuidCount: shared.size };
}

function better(a, b) {
  if (!b) return true;
  if (a.msgs !== b.msgs) return a.msgs > b.msgs;
  const ta = a.first_ts || '', tb = b.first_ts || '';
  if (ta !== tb) return ta < tb;
  return a.id < b.id;
}

/**
 * 內容層級的疑似同源：兩個 session 沒有共用 uuid，但使用者訊息的文字雜湊高度重疊。
 * 這通常是 compact 續接（訊息被重寫過，uuid 全新）或同一段話被重跑。
 * 這種關係不保證可安全刪除，只作提示。
 */
export function findContentEchoes(sessions, promptHashesBySession, lineageRows, { minRatio = 0.5, minShared = 2 } = {}) {
  const groupOf = new Map(lineageRows.map((r) => [r.sessionId, r.role === 'solo' ? null : r.groupId]));
  const ids = sessions.map((s) => s.id).filter((id) => (promptHashesBySession.get(id) || []).length > 0);
  const sets = new Map(ids.map((id) => [id, new Set(promptHashesBySession.get(id))]));
  const out = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i], b = ids[j];
      const ga = groupOf.get(a), gb = groupOf.get(b);
      if (ga !== null && ga !== undefined && ga === gb) continue; // 已由 uuid 關聯，不重複報
      const sa = sets.get(a), sb = sets.get(b);
      let n = 0;
      const small = sa.size <= sb.size ? sa : sb;
      const large = small === sa ? sb : sa;
      for (const h of small) if (large.has(h)) n++;
      if (n < minShared) continue;
      const ratio = n / small.size;
      if (ratio < minRatio) continue;
      out.push({ a, b, shared: n, smallSize: small.size, ratio });
    }
  }
  return out.sort((x, y) => y.shared - x.shared);
}
