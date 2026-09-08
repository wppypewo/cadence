/**
 * 打字作答的批改。前後端共用同一份實作——這個檔案會直接被瀏覽器 import，
 * 免得「畫面說對、伺服器記成錯」這種對不起來的情況。
 *
 * 立場：**重音算數**。écrire 打成 ecrire 就是錯的，不會放水。
 * 但錯法要講清楚：只差重音、只差大小寫、還是根本另一個字，回饋不同。
 */

/** Unicode 正規化 + 收掉多餘空白。撇號統一成 U+2019，法文排版用的是這個。 */
export function normalize(s) {
  return String(s ?? '')
    .normalize('NFC')
    .replace(/[ʼ'‘]/g, '’')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 去掉所有變音符號，用來判斷「是不是只差重音」。 */
export function stripAccents(s) {
  return normalize(s)
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .normalize('NFC')
    .replace(/œ/g, 'oe')
    .replace(/Œ/g, 'OE')
    .replace(/æ/g, 'ae')
    .replace(/Æ/g, 'AE');
}

const fold = (s) => stripAccents(s).toLocaleLowerCase('fr');

/**
 * 比對一個作答與一組可接受答案。
 *
 * @param {string} input 使用者打的字
 * @param {string[]} accepted 可接受答案（第一個是標準答案）
 * @returns {{correct:boolean, reason:string, matched:string|null}}
 *   reason: exact | accent | case | wrong | empty
 */
export function grade(input, accepted) {
  const answer = normalize(input);
  if (!answer) return { correct: false, reason: 'empty', matched: null };

  const candidates = accepted.map(normalize).filter(Boolean);
  if (candidates.includes(answer)) {
    return { correct: true, reason: 'exact', matched: answer };
  }

  const lower = answer.toLocaleLowerCase('fr');
  const caseMatch = candidates.find((c) => c.toLocaleLowerCase('fr') === lower);
  if (caseMatch) {
    // 大小寫不同不扣分：法文句首大寫與詞典形大寫是排版問題，不是拼字問題。
    return { correct: true, reason: 'case', matched: caseMatch };
  }

  const folded = fold(answer);
  const accentMatch = candidates.find((c) => fold(c) === folded);
  if (accentMatch) {
    return { correct: false, reason: 'accent', matched: accentMatch };
  }

  return { correct: false, reason: 'wrong', matched: null };
}

/**
 * 逐字比對，標出哪幾個位置不同，讓畫面可以只把錯的地方標紅。
 * 用最單純的等長對齊 + 長度差補尾巴：答案通常只差一兩個字元，
 * 上完整的編輯距離對齊在這裡沒有收益。
 *
 * @returns {Array<{ch:string, ok:boolean}>} 以「正確答案」為骨架
 */
export function diffChars(input, answer) {
  const a = [...normalize(input)];
  const b = [...normalize(answer)];
  return b.map((ch, i) => ({ ch, ok: a[i] === ch }));
}

/** 作答裡出現的所有變音字母，用來回報「你漏了哪個符號」。 */
export function missingAccents(input, answer) {
  const a = [...normalize(input)];
  const b = [...normalize(answer)];
  const out = [];
  for (let i = 0; i < b.length; i += 1) {
    if (a[i] !== b[i] && stripAccents(b[i]) === stripAccents(a[i] ?? '')) out.push(b[i]);
  }
  return [...new Set(out)];
}
