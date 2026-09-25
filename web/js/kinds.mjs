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
