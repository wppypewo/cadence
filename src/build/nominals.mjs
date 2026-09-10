/**
 * 名詞化配對（考卷第 IV 大題，14%）。
 *
 * 第 IV 大題要把從屬子句改寫成名詞組（bien qu'elle soit absente → malgré son absence）。
 * 這裡**只練其中一半**：哪一個派生名詞、配哪一個冠詞。
 * 完整的句框架（malgré／en cas de／sans + 名詞組）留在 rw 的自評範圍，
 * 因為那一層沒有唯一解，機器判不了。
 *
 * 配對怎麼來的：
 *   規則組 — 由 A1/A2/B1 詞表裡的動詞／形容詞依構詞規則推出候選名詞，
 *            候選字必須「同樣在詞表裡且標為 NOM」才收，所以出現的字全是實際存在的詞。
 *            標 [推論]。
 *   考卷組 — 111-2 考卷第 IV 大題的 7 題。chaud→chaleur、pleuvoir→pluie 這類
 *            不規則對應規則挖不到，直接登記。標 [教材 111-2 IV]。
 *
 * 性別不用推的：讀 french-exam-generator/data/genders.json（來源 fr.wiktionary）。
 * 查不到性別或查不到 h 的性質就不出題——冠詞是這一題型的一半分數，猜不得。
 *
 * **EXCLUDE、FROM_EXAM、derive() 與 LEVELS 原生在 french-exam-generator/tools/nominalize.py。**
 * 那邊沒有機器可讀的匯出格式，只能照抄一份過來。改這四樣任何一樣都要兩邊一起改——
 * 只改一邊不會壞掉，只會讓題庫悄悄多幾張或少幾張卡，這種錯自己不會冒出來。
 * 所以 `tests/nominals-drift.test.mjs` 直接跑那支 Python 把四樣逐一比回去，對不上就紅。
 * 那個檔不在（換機器、只帶 cadence 出門）時該題自動跳過，不是假裝通過。
 * 除此之外本檔不新增任何外部來源，兩張詞表與 genders.json 都是建置流程已經在讀的檔。
 */

/**
 * 規則挖出來但語意已經漂走的配對。逐條寫明理由，因為排除本身也可能判錯，要能被人覆核。
 * 出題時一併顯示基詞的中文釋義，也是為了讓判錯當場看得出來。
 */
export const EXCLUDE = new Map([
  ['direct|directeur', 'directeur 是「經理」，不是「直接」的名詞化'],
  ['garer|garage', 'garage 是場所（車庫），停車這個動作的名詞是 stationnement'],
  ['équiper|équipage', 'équipage 是（船機）組員；裝備該用 équipement'],
  ['entourer|entourage', 'entourage 指周遭的人，不是「包圍」這個動作'],
  ['public|publicité', 'publicité 是廣告，不是「公共性」'],
  ['destiner|destination', 'destination 是目的地，不是「打算用於」的動作名詞'],
  ['situer|situation', 'situation 是情況，不是「定位」這個動作'],
  ['conséquent|conséquence', 'conséquence 是後果；conséquent 的意思是「前後一致的」'],
]);

/** 111-2 考卷第 IV 大題原題。格式：[基詞, 詞性, 名詞, 性別, 考卷上的完整答案]。 */
export const FROM_EXAM = [
  ['absent', 'ADJ', 'absence', 'f', 'son absence'],
  ['chaud', 'ADJ', 'chaleur', 'f', 'la chaleur'],
  ['pleuvoir', 'VER', 'pluie', 'f', 'la pluie'],
  ['tomber en panne', 'VER', 'panne', 'f', 'la panne'],
  ['expliquer', 'VER', 'explication', 'f', 'les explications'],
  ['aider', 'VER', 'aide', 'f', 'ton aide'],
  ['timide', 'ADJ', 'timidité', 'f', 'la timidité'],
];

/** 收哪幾個等級。export 是為了讓漂移測試比得到——它也是照抄過來的。 */
export const LEVELS = new Set(['A1', 'A2', 'B1']);

/** 由動詞／形容詞產生候選派生名詞。只產生字串，成不成立由詞表決定。 */
export function derive(word, pos) {
  const out = [];
  if (pos === 'VER') {
    if (word.endsWith('quer')) out.push(`${word.slice(0, -4)}cation`);
    if (word.endsWith('er')) out.push(`${word.slice(0, -2)}ation`, `${word.slice(0, -2)}ement`, `${word.slice(0, -2)}age`);
    if (word.endsWith('ir')) out.push(`${word.slice(0, -2)}issement`);
  } else {
    if (word.endsWith('ent')) out.push(`${word.slice(0, -3)}ence`);
    if (word.endsWith('ant')) out.push(`${word.slice(0, -3)}ance`);
    const base = word.endsWith('e') ? word.slice(0, -1) : word;
    out.push(`${base}ité`, `${base}esse`, `${base}eur`);
  }
  return out;
}

/**
 * 挖出規則配對。兩端都要在詞表裡、都要在 A1/A2/B1 之內。
 * @param {Array<{word:string, pos:string, level:string}>} entries
 * @returns {Array<{base:string, pos:string, noun:string}>} 依基詞排序
 */
export function mineNominals(entries) {
  const tags = new Map();
  const level = new Map();
  for (const e of entries) {
    if (!tags.has(e.word)) tags.set(e.word, new Set());
    tags.get(e.word).add(e.pos);
    const key = `${e.word}|${e.pos}`;
    // 同一個 (字, 詞性) 只認第一次出現的等級，跟來源詞表的做法一致。
    if (!level.has(key)) level.set(key, e.level);
  }

  const seen = new Set();
  const pairs = [];
  for (const [word, poss] of tags) {
    for (const pos of poss) {
      if (pos !== 'VER' && pos !== 'ADJ') continue;
      if (!LEVELS.has(level.get(`${word}|${pos}`))) continue;
      for (const noun of derive(word, pos)) {
        if (noun === word) continue;
        if (!tags.get(noun)?.has('NOM')) continue;
        if (!LEVELS.has(level.get(`${noun}|NOM`))) continue;
        if (EXCLUDE.has(`${word}|${noun}`)) continue;
        const key = `${word}|${pos}|${noun}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pairs.push({ base: word, pos, noun });
      }
    }
  }
  return pairs.sort((a, b) => (`${a.base}|${a.pos}|${a.noun}` < `${b.base}|${b.pos}|${b.noun}` ? -1 : 1));
}

/** 定冠詞 ＋ 名詞。elide 為 null 表示 h 的性質沒查到，呼叫端不該用。 */
export function article(noun, gender, elide) {
  if (elide) return `l'${noun}`;
  return `${gender === 'f' ? 'la ' : 'le '}${noun}`;
}

/**
 * 可出題的配對。規則組在前、考卷組在後，**以名詞去重**：
 * 同一個名詞出兩張卡只是同一題問兩次，而規則組帶得出基詞的等級與釋義。
 * （實測 explication 兩邊都有，考卷那筆因此被吃掉。）
 *
 * @param {Array} entries 詞表（vocab_a1a2 ＋ vocab_b1）
 * @param {Object} genders genders.json，形如 { absence: { g:'f', elide:true } }
 * @returns {Array<{base, pos, noun, gender, elide, answer, answers, src}>}
 */
export function buildNominals(entries, genders) {
  const out = [];

  for (const { base, pos, noun } of mineNominals(entries)) {
    const rec = genders[noun] ?? {};
    const { g, elide } = { g: rec.g ?? null, elide: rec.elide ?? null };
    if ((g !== 'm' && g !== 'f') || elide === null) continue;
    const answer = article(noun, g, elide);
    out.push({ base, pos, noun, gender: g, elide, answer, answers: [answer], src: '[推論]' });
  }

  for (const [base, pos, noun, g, exam] of FROM_EXAM) {
    // 考卷答案用所有格（son absence）是因為原句有主詞；單獨練時定冠詞也對，
    // 兩個都收。縮寫與否仍照 Wiktionnaire，不照考卷猜。
    const elide = genders[noun]?.elide ?? null;
    const answers = [exam];
    if (elide !== null) {
      const plain = article(noun, g, elide);
      if (plain !== exam) answers.push(plain);
    }
    out.push({ base, pos, noun, gender: g, elide, answer: exam, answers, src: '[教材 111-2 IV]' });
  }

  const seen = new Set();
  return out.filter((it) => {
    if (seen.has(it.noun)) return false;
    seen.add(it.noun);
    return true;
  });
}
