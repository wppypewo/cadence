/**
 * 「這句你認得幾個字」的判斷邏輯。純函式，不碰資料庫。
 *
 * 題庫裡的字只有原形（manger、maison），句子裡出現的是變化過的形（mangeait、maisons），
 * 所以要先把句子裡的形還原成題庫收的那個字。還原失敗的字一律算「題庫外」，不計入分母——
 * 分母若把 de／le／vous 這些題庫根本沒收的虛詞算進去，「你認得 7／12」就會永遠偏低，
 * 而且低的原因跟你學了多少無關。
 */

// 法文字母。撇號與連字號不算字母，l'eau 會拆成 l 與 eau，peut-être 拆成 peut 與 être。
const WORD = /[A-Za-zÀ-ÖØ-öø-ÿŒœÆæ]+/g;

/** 把句子切成「字」與「字之間的東西」，原文一字不漏，前端照順序接回去就是原句。 */
export function tokenize(sentence) {
  const text = String(sentence ?? '');
  const out = [];
  let i = 0;
  for (const m of text.matchAll(WORD)) {
    if (m.index > i) out.push({ text: text.slice(i, m.index), word: false });
    out.push({ text: m[0], word: true });
    i = m.index + m[0].length;
  }
  if (i < text.length) out.push({ text: text.slice(i), word: false });
  return out;
}

// 名詞與形容詞的陰性／複數字尾。-es 排在 -s 前面：兩個都找得到時（例如題庫同時收了
// grand 與 grande），寧可還原到最短的原形，才會落到同一張看字回想卡上。
const INFLECTIONS = ['es', 's', 'x', 'e'];
const VERB_ENDINGS = ['er', 'ir', 're'];

/**
 * 把一個形還原成題庫裡的字。依序：原形 → 變位表 → 陰性複數 → 砍字尾補 -er/-ir/-re。
 *
 * 最後一步是猜的，所以要求詞幹至少 3 個字母：不設下限的話 tes 會砍成 t 再補成 tre 之類的假命中。
 * 2026-09-16 對 163 句實測：命中 1,200 個字，抽查 traitent→traiter、souhaiteriez→souhaiter、
 * prenne→prendre、venu→venir 都對。
 *
 * @param {string} raw 句子裡的原形，大小寫不拘
 * @param {{has:(w:string)=>boolean, verbOf:(form:string)=>string|null}} lex
 * @returns {{word:string, via:'exact'|'conj'|'form'|'stem'}|null}
 */
export function resolveForm(raw, lex) {
  const form = String(raw).toLowerCase();
  if (!form) return null;
  if (lex.has(form)) return { word: form, via: 'exact' };

  const verb = lex.verbOf(form);
  if (verb && lex.has(verb)) return { word: verb, via: 'conj' };

  for (const end of INFLECTIONS) {
    if (form.length > end.length + 1 && form.endsWith(end)) {
      const base = form.slice(0, -end.length);
      if (lex.has(base)) return { word: base, via: 'form' };
    }
  }

  for (let cut = 1; cut <= 5 && form.length - cut >= 3; cut += 1) {
    const stem = form.slice(0, -cut);
    for (const end of VERB_ENDINGS) {
      if (lex.has(stem + end)) return { word: stem + end, via: 'stem' };
    }
  }
  return null;
}

/**
 * 對一句話逐字判斷。
 *
 * @param {string} sentence
 * @param {{has:Function, verbOf:Function}} lex
 * @param {(word:string)=>'mature'|'seen'|'fresh'} statusOf 題庫裡的字學到哪
 * @returns {{tokens:Array<{text:string, word:string|null, status:string|null}>,
 *            counts:{inBank:number, seen:number, mature:number, outside:number}}}
 */
export function readCheck(sentence, lex, statusOf) {
  const counts = { inBank: 0, seen: 0, mature: 0, outside: 0 };
  const tokens = tokenize(sentence).map((t) => {
    if (!t.word) return { text: t.text, word: null, status: null };
    const hit = resolveForm(t.text, lex);
    if (!hit) {
      counts.outside += 1;
      return { text: t.text, word: null, status: 'outside' };
    }
    const status = statusOf(hit.word);
    counts.inBank += 1;
    // 「穩了」本身也是「學過」，seen 是兩者合計，前端的「認得 N 個」用的就是這個數字。
    if (status === 'mature' || status === 'seen') counts.seen += 1;
    if (status === 'mature') counts.mature += 1;
    return { text: t.text, word: hit.word, status };
  });
  return { tokens, counts };
}
