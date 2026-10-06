/**
 * 題型代碼的中文名。**這個物件的鍵序就是全站的題型顯示順序**：
 * 範圍選單、進度頁各類別進度都照這個排，先詞彙、再變位、再句子層級。
 *
 * 不用 API 回來的順序，是因為 SQL 那邊是 `ORDER BY c.kind`，也就是英文代碼的
 * 字母序——conj、connector、nom、pick、rw、vocab-produce、vocab-recall。
 * 那個順序在畫面上讀起來沒有意義，而且跟範圍選單的排法對不起來。
 *
 * 原本六個頁面各抄一份，改一個字要改六處；放在 app.mjs 又會跟各頁互相 import，
 * 所以獨立成這個沒有任何依賴的檔。
 */
export const KIND_ZH = {
  'vocab-recall': '看字回想',
  'vocab-produce': '中翻法',
  conj: '動詞變位',
  connector: '連接詞',
  pick: '挑連接詞',
  rw: '改寫整句',
  nom: '名詞化',
};

/**
 * 一張卡在清單裡代表它的那個字。
 *
 * 順序是先看題面的詞、連接詞、動詞，最後才退回 answer。連接詞卡的 answer 是它要接的
 * 語氣（subjonctif），先拿 answer 的話，進度頁「最弱的卡」整排都會印成語氣名稱，
 * 看不出是哪個連接詞（2026-10-04 critique 抓到的）。查詢頁與進度頁共用這一份，免得兩邊又各寫一套順序。
 */
export function cardHead(card) {
  const f = card.front ?? {};
  return f.word || f.connector || f.verb || card.answer || card.id;
}

/**
 * 四科的中文名。主鍵寫「練聽力」、旁邊那句卻寫「還沒打卡：CO／PO」，同一眼讀到兩套叫法；
 * 按鍵、打卡鍵與待打卡清單都從這裡拿，進度頁的「練X」也是。帳本列的科目代號是給對照官方評分格用的，不在此列。
 */
export const SKILL_ZH = { CE: '閱讀', PE: '寫作', CO: '聽力', PO: '口說' };

/**
 * 答錯原因的短稱，進度頁的清單與長條圖用。
 * wrong 在打字題是拼錯、在選擇題是按錯選項；資料庫只存一個 wrong，
 * 原本進度頁一律印「拼錯」，連接詞卡選錯也被說成拼錯（2026-10-06 critique 抓到的）。
 * 長條圖是好幾張卡加總，分不出哪一種，所以兩種都寫上。
 */
export const REASON_ZH = {
  wrong: '拼錯／選錯', accent: '漏重音', case: '大小寫', empty: '沒作答',
  elision: '省音', family: '性數／形式', missing: '少要素', article: '冠詞錯',
};

/** 單張卡的錯法：看得到卡，就能把 wrong 說準。 */
export function reasonFor(card, reason) {
  if (reason === 'wrong') return card?.mode === 'choice' ? '選錯' : '拼錯';
  return REASON_ZH[reason] ?? reason ?? '';
}
