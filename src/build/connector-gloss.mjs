/**
 * 權威表那 25 個連接詞的中文與功能。
 *
 * **為什麼這份資料在 cadence 裡，不在 vault**：權威表
 * （final-exam-grammar-core.md 的「快速判斷表」）依語氣分列，只有兩欄，
 * 從頭到尾沒有中文欄；輔助表（french-connectors.md）有中文，但只收常用的那些。
 * 兩張表交集之外的 25 個條目，中文在 vault 裡**根本不存在**——
 * 所以這份不是把 vault 的東西抄一份，是補一份 vault 沒有的。
 *
 * 這個分別很要緊。backlog 上另有一條在講 `EXCLUDE`／`FROM_EXAM` 兩份清單各存一份、
 * 改一邊就靜靜分岔的病；那是複製，這不是。為了讓它保持不是複製，
 * 下面這張表**不得收錄輔助表已經有中文的連接詞**。兩道關卡擋著：
 * 合併時輔助表一律優先、這張表只填空（tests/bank.test.mjs 的「補釋義」那幾題），
 * 以及 `npm run build` 會把「這張表裡沒被用到的列」逐一列出來——
 * 哪天 vault 補了同一個連接詞，那一列就變成死的，照著警告刪掉。
 * 刪哪一列是人的判斷，build 只講不動手。
 *
 * 功能欄的用詞刻意沿用輔助表的那一套（時間／對立／對立讓步／條件／條件·原因／比較），
 * 不自己另立一套分類——同一副牌裡一半寫「條件」一半寫「假設」會讀成兩回事。
 */

/** 連接詞（照權威表的寫法）→ { fn 功能, zh 中文 }。 */
export const CONNECTOR_GLOSS = {
  // 時間 —— 這一組全部接 indicatif，差別在「哪一刻」與書面／口語。
  'lorsque': { fn: '時間', zh: '當…的時候（quand 的書面說法）' },
  'pendant que': { fn: '時間', zh: '在…的同時' },
  'chaque fois que': { fn: '時間', zh: '每當／每次…就' },
  'à mesure que': { fn: '時間', zh: '隨著…而逐漸' },
  'maintenant que': { fn: '時間', zh: '既然現在／如今…了' },
  'dès que': { fn: '時間', zh: '一…就（立刻）' },
  'aussitôt que': { fn: '時間', zh: '一…就（與 dès que 同義）' },
  'une fois que': { fn: '時間', zh: '一旦…之後' },
  'après que': { fn: '時間', zh: '在…之後' },

  // 對立 —— 都是「只不過」那一路，接 indicatif。
  'sauf que': { fn: '對立', zh: '只不過／除了…這一點' },
  "si ce n'est que": { fn: '對立', zh: '只不過是／要說有什麼不同就是' },
  // 權威表寫的是 si(讓步)。條件的 si 不在這張表上，兩者不要混。
  'si': { fn: '對立讓步', zh: '雖然／儘管（讓步用法，不是「如果」）' },

  // 條件 —— 接 indicatif 的那幾個。
  'dans la mesure où': { fn: '條件·原因', zh: '就…而言／在…的範圍內' },
  'excepté si': { fn: '條件', zh: '除非' },
  'selon que…ou': { fn: '條件', zh: '視…而定（是…還是…）' },
  'suivant que…ou': { fn: '條件', zh: '視…而定（selon que 的同義）' },

  // 對立讓步 —— 接 subjonctif。
  'encore que': { fn: '對立讓步', zh: '雖然／儘管（bien que 的書面同義）' },
  'si/quelque/pour + adj + que': { fn: '對立讓步', zh: '無論多麼…' },
  'quelque(s) + nom + que': { fn: '對立讓步', zh: '無論有多少…' },

  // 條件·假設 —— 接 subjonctif。這一組最容易只看字面認不出來。
  'pour peu que': { fn: '條件', zh: '只要稍微…就' },
  'soit que': { fn: '條件', zh: '或是…或是（soit que… soit que…）' },
  'en admettant que': { fn: '條件', zh: '就算／姑且假定' },
  'en supposant que': { fn: '條件', zh: '假設' },
  'si tant est que': { fn: '條件', zh: '如果真有這回事的話' },

  // 比較 —— 唯一接 imparfait／plus-que-parfait 的。
  'comme si': { fn: '比較', zh: '好像／彷彿' },
};
