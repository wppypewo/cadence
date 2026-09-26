/**
 * 雲端事件表 → 本機 JSONL 備份的合併規則。純函式，腳本負責讀寫檔與連線。
 *
 * 備份檔和 data/reviews.jsonl 一樣只增不改：已經寫下的行永遠不動，雲端多出來的列追加在後面。
 * 比對用 event_id，不用整行內容——Postgres 的 jsonb 會重排 payload 的鍵順序，
 * 同一筆事件兩次抓下來的 JSON 字串不一定相同。
 */

/** 雲端列去掉 owner_id 再存：RLS 下每一列都是同一個人，存了只是重複。 */
export function backupRow(row) {
  const { owner_id: _owner, ...rest } = row;
  return rest;
}

/**
 * existingText：備份檔目前的內容（檔案不存在就給空字串）。
 * rows：雲端依 at、event_id 排好的列。
 * 回傳要追加的文字、追加幾列，以及本機有但雲端已經沒有的 event_id。
 * 後者只回報不處理——雲端列被刪掉時，這份備份正是要留住它們。
 */
export function planAppend(existingText, rows) {
  const seen = new Set();
  existingText.split('\n').forEach((line, index) => {
    if (!line.trim()) return;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`第 ${index + 1} 行不是合法 JSON，拒絕追加`);
    }
    if (typeof parsed?.event_id !== 'string') throw new Error(`第 ${index + 1} 行缺 event_id，拒絕追加`);
    seen.add(parsed.event_id);
  });
  const local = new Set(seen);

  const lines = [];
  const cloud = new Set();
  for (const row of rows) {
    if (typeof row?.event_id !== 'string') throw new Error('雲端列缺 event_id');
    cloud.add(row.event_id);
    if (seen.has(row.event_id)) continue;
    seen.add(row.event_id);
    lines.push(JSON.stringify(backupRow(row)));
  }

  // 既有檔最後一行若沒有換行，先補一個，免得第一筆新列黏在舊行後面。
  const lead = existingText && !existingText.endsWith('\n') && lines.length ? '\n' : '';
  return {
    text: lines.length ? `${lead}${lines.join('\n')}\n` : '',
    appended: lines.length,
    missingFromCloud: [...local].filter((id) => !cloud.has(id)),
  };
}
