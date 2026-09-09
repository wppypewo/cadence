/**
 * 打字作答的批改。前後端共用同一份實作——這個檔案會直接被瀏覽器 import，
 * 免得「畫面說對、伺服器記成錯」這種對不起來的情況。
 *
 * 立場：**重音算數**。écrire 打成 ecrire 就是錯的，不會放水。
 * 但錯法要講清楚：只差重音、只差大小寫、還是根本另一個字，回饋不同。
 *
 * 方框挑連接詞（pick）另有一套三級判定，放在本檔下半部。
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

// ---------------------------------------------------------------------------
// 方框挑連接詞（pick）的三級批改
//
// 規格見 vault 的 wiki/outputs/study-packs/french-retrieval-drill.md
// 「pick 分三級批改」，實作移植自 french-exam-generator/tools/drill.py。
// ---------------------------------------------------------------------------

/**
 * 方框裡一格選項涵蓋的所有詞形。
 *
 * 方框印的是「詞形族」而不是單一寫法：`quel(le)(s) que` 一格涵蓋
 * quel que／quelle que／quels que／quelles que 四種，考的正是選對之後
 * 還要配對主語的性數。`Quelque(s)…que` 的「…que」是「中間插名詞或形容詞」
 * 的標記，不是字面要寫的字。
 */
export function expandOption(opt) {
  const core = String(opt ?? '').trim().replace(/…que|\.\.\.que/g, '').trim();
  let forms = [''];
  let i = 0;
  while (i < core.length) {
    if (core[i] === '(') {
      const j = core.indexOf(')', i);
      if (j === -1) break;
      const inner = core.slice(i + 1, j);
      forms = forms.flatMap((f) => [f, f + inner]);
      i = j + 1;
    } else {
      const ch = core[i];
      forms = forms.map((f) => f + ch);
      i += 1;
    }
  }
  return new Set(forms.map((f) => f.replace(/\s+/g, ' ').trim().toLowerCase()).filter(Boolean));
}

/** 統一撇號與空白。**不還原省音**——省音本身就是考點，不能抹掉。 */
export function normPick(s) {
  return String(s ?? '').replace(/\*\*/g, '').replace(/[’‘]/g, "'")
    .replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * 把省音還原回完整形，只用來判斷「屬於方框哪一格」。
 *
 * 還原後要壓掉多出來的空白：`à moins d’` 展開成 `à moins de ` 帶尾空格，
 * 不壓就跟 `à moins de` 比不相等，省音錯會被誤判成選錯格。
 */
export function unelide(s) {
  return String(s ?? '')
    .replace(/[’‘]/g, "'")
    .replace(/qu'/g, 'que ')
    .replace(/d'/g, 'de ')
    .replace(/s'/g, 'si ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 這個寫法屬於方框裡的哪一格。取最長匹配；分不出回 null。 */
export function familyOf(text, options = []) {
  const u = unelide(normPick(text));
  let best = null;
  let bestLen = -1;
  for (const opt of options) {
    for (const form of expandOption(opt)) {
      const f = unelide(form);
      if (u.startsWith(f) && f.length > bestLen) {
        best = opt;
        bestLen = f.length;
      }
    }
  }
  return best;
}

/**
 * 三級批改。reason 為 exact／elision／family／wrong／empty。
 *
 * 分三級是因為這三種錯要補的東西不同：省音是抄寫細節、
 * 性數是 quel que 那組的主考點、選錯格才是真的不懂這個連接詞。
 *
 * 三種錯一律 correct=false——省音與性數在考卷上照樣不給分，
 * 分級是為了讓回饋講得出你錯在哪，不是為了放水。
 * `quoique`（一字＝雖然）與 `quoi que`（兩字＝無論什麼）不算同一格：
 * 意思不同，答錯就是選錯格。方框把兩者列成兩格，這一點自然成立。
 *
 * @returns {{correct:boolean, reason:string, matched:string|null}}
 */
export function gradePick(input, answer, options = []) {
  const g = normPick(input);
  const a = normPick(answer);
  if (!g) return { correct: false, reason: 'empty', matched: null };
  if (g === a) return { correct: true, reason: 'exact', matched: answer };
  if (unelide(g) === unelide(a)) return { correct: false, reason: 'elision', matched: answer };
  const fa = familyOf(a, options);
  if (fa && familyOf(g, options) === fa) {
    return { correct: false, reason: 'family', matched: answer };
  }
  return { correct: false, reason: 'wrong', matched: null };
}

// 用指定連接詞改寫整句（rw）的半自動批改
// 規格見 vault 的 wiki/outputs/study-packs/french-retrieval-drill.md
// 「`rw` 查的是兩件事，不是整句」，實作移植自 french-exam-generator/tools/drill.py。

/**
 * 檢查改寫句裡的必要要素。
 *
 * **整句不比對。** 同一題常有好幾種都對的寫法（`Si agréable qu'il soit`／
 * `Si agréable soit-il`），拿整句做字串比對只會製造假的錯。
 * 有定論的只有兩件事：指定的連接詞用了沒有、後面接的語氣對不對。
 * 那兩件寫在筆記的「必要要素」欄，由 must 傳進來，不寫死在程式裡。
 *
 * must 是「組的陣列」：組與組是且（每組都要中），組內是或（任一寫法即可）。
 * 判定用「包含」而非相等——要素是句子的一部分，本來就被前後文包著。
 *
 * 重音差錯另外提示、不判錯：這裡的考點是連接詞與語氣，
 * 拼寫另有 vocab 題型在管，一個錯不罰兩次。
 *
 * @param {string} given 使用者寫的整句
 * @param {string[][]} must 必要要素
 * @returns {{correct:boolean, reason:string, miss:string[][], accent:string[][]}}
 *   correct 的意思是「要素齊全，可以進自評」，不是「整句正確」。
 *   reason: exact | accent | missing | empty
 */
export function gradeRewrite(given, must = []) {
  const g = normPick(given);
  const gf = fold(g);
  const groups = (must ?? [])
    .map((alts) => (alts ?? []).map((a) => normPick(a)).filter(Boolean))
    .filter((alts) => alts.length);

  if (!g) return { correct: false, reason: 'empty', miss: groups, accent: [] };

  const miss = [];
  const accent = [];
  for (const alts of groups) {
    if (alts.some((f) => g.includes(f))) continue;
    if (alts.some((f) => gf.includes(fold(f)))) accent.push(alts);
    else miss.push(alts);
  }
  if (miss.length) return { correct: false, reason: 'missing', miss, accent };
  return { correct: true, reason: accent.length ? 'accent' : 'exact', miss, accent };
}

// 名詞化（nom）的批改
// 規格見 vault 的 wiki/outputs/study-packs/french-retrieval-drill.md
// 「92 組派生名詞｜自動，冠詞計分」，實作移植自 french-exam-generator/tools/drill.py。

/**
 * 名詞組（冠詞 ＋ 派生名詞）的批改。
 *
 * **冠詞算分。** 考卷第 IV 大題寫錯 le／la 就沒分，這裡也一樣判錯。
 * 但「名詞對了只錯冠詞」跟「根本不知道要用哪個名詞」不是同一種錯，
 * 分開報，才看得出下次該補的是性別還是構詞。
 *
 * 判定順序：完全相同 → 只差重音 → 只差冠詞 → 全錯。
 * 重音排在冠詞之前，否則 `la timidite` 會被說成冠詞錯。
 *
 * @param {string} given 使用者寫的名詞組
 * @param {string[]} accepted 可接受答案（第一個是標準答案）
 * @param {string} noun 這一題的名詞本體，用來判斷「只錯冠詞」
 * @returns {{correct:boolean, reason:string, matched:string|null}}
 *   reason: exact | accent | article | wrong | empty
 */
export function gradeNom(given, accepted = [], noun = '') {
  const g = normPick(given);
  if (!g) return { correct: false, reason: 'empty', matched: null };

  const candidates = (accepted ?? []).map((a) => normPick(a)).filter(Boolean);
  if (candidates.includes(g)) {
    return { correct: true, reason: 'exact', matched: accepted[0] ?? null };
  }
  const gf = fold(g);
  if (candidates.some((c) => fold(c) === gf)) {
    return { correct: false, reason: 'accent', matched: accepted[0] ?? null };
  }

  // 撇號後面補一個空白再切，l'absence 的最後一段才會是 absence。
  const last = g.replace(/'/g, "' ").split(' ').filter(Boolean).pop() ?? '';
  if (noun && fold(last) === fold(normPick(noun))) {
    return { correct: false, reason: 'article', matched: accepted[0] ?? null };
  }
  return { correct: false, reason: 'wrong', matched: null };
}
