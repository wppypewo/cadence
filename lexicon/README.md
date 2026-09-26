# lexicon/

cadence 自己的補充詞彙資料，進版控。`npm run build` 讀它們、疊在 fexgen 的詞表上，四份都列在來源指紋裡，改了下次啟動會自動重建。
缺哪一份建置照跑，只是少那一層覆寫（`src/build/sources.mjs` 的 `loadLexicon()`）。

數字為 2026-09-26 實測。

| 檔案 | 筆數 | 鍵 | 內容 |
|---|---|---|---|
| `spelling.json` | 21 | FLELex 原拼法 | 更正後的拼法：19 條 `oe` → `œ`（coeur → cœur），2 條全大寫誤標（`FAUX`、`VRAI` → 小寫；FLELex 裡 VRAI 同時標成形容詞與名詞） |
| `genders.json` | 4,706 | 更正後拼法 | A1–B2 全部名詞的 `{ g, elide }`：陽性 2,422、陰性 2,101、兩性皆可 183；1,031 筆以母音或啞音 h 開頭、冠詞要省音 |
| `glosses.json` | 6,541 | `更正後拼法\|詞性` | 中文釋義：fexgen 自動抓的 1,470 筆逐筆重審，加上 B2 的 5,068 個實詞；70 筆以 ⚠ 開頭 |
| `examples.json` | 8,360 | `FLELex 原拼法\|詞性` | Tatoeba 例句，每條最多 2 句，共 16,485 句，7,432 句附中文翻譯 |

每份都是一個鍵一行、依法文字母排序，幾千筆的檔案 diff 時才看得出改了哪個字。

## 為什麼鍵不一致

`examples.json` 用 FLELex 原拼法，其餘用更正後的拼法。例句是拿原拼法的詞形去 Tatoeba 比對出來的，
改鍵等於要重跑比對；建置時 `mergeEntries()` 在條目上留一個 `src` 欄記原拼法，查例句與英文定義都走它。
卡片 id 用更正後的拼法（`v:cœur|NOM|r`）。

## 釋義的優先序

同一個 `字|詞性` 有多個來源時（`src/build/bank.mjs` 的 `glossOf()`）：

1. `glosses.json` —— 卡背標「中文釋義為 cadence 逐筆整理」
2. fexgen 條目自帶的 `zh`（自動抓的 Wiktionnaire 中文翻譯）—— 1,470 筆全部重審進第 1 層，2026-09-26 實測這層已經沒有條目會走到，留著是給 fexgen 日後新增的字
3. fexgen 的 `gloss_*.json` 人工釋義（2,079 筆，以原拼法 `src` 查）—— 這份檔沒有重寫它們，那是 fexgen 最不可取代的資料

**⚠ 規則**：釋義**開頭**是 ⚠ 的條目視為雜訊，不出卡。實際內容是 FLELex 的標註錯誤：詞性誤標（frontière 標成形容詞）、變化形當詞條（aiguë）、原形還原錯（chérer）、拉丁片語的殘片（priori）。
例外是 `data/reviews.jsonl` 裡作答過的卡照留，進度不能因為重建而丟——目前只有 `v:est-à-dire|ADV|r` 一張。
釋義**中間**的「（⚠ 亦為…）」是同形異義的提醒，不算雜訊。

## 已知限制

- **依詞義變性別的同形字只取一個。** tour（塔 f／圈 m）、poste（郵局 f／職位 m）、livre（磅 f／書 m）這類，
  `genders.json` 記的是 Wiktionnaire 頁面上第一個名詞段落的性別。釋義若寫的是另一個詞義，卡面的性別會對不上。
- **455 句的命中字只在忽略大小寫時才對得上**，幾乎都是句首大寫。前端先找原樣、找不到再忽略大小寫，兩者都找不到就不標粗體。
- 形容詞的陰性與複數詞形是規則推出來的，會多生出不存在的字；那些字只是找不到句子，不會進檔。

## 來源與授權

| 來源 | 用在哪 | 授權 | 進版控的是什麼 |
|---|---|---|---|
| [fr.wiktionary](https://fr.wiktionary.org/) | 性別、省音；寫釋義時的參考材料 | CC BY-SA 4.0 | 只有性別與省音這兩個事實，以及自己寫的中文釋義。定義與翻譯原文留在 `.cache/` |
| [Tatoeba](https://tatoeba.org/) | 例句與中文翻譯 | CC BY 2.0 FR | 句子原文、句號、作者。前端每句都附回原句的連結與作者名，這是 CC BY 的署名要求 |
| FLELex（Ricky-KnowledgeBase `raw/sources/french/flelex`） | B2 詞表、詞頻 | CC BY-NC-SA 4.0 | 什麼都不進。建置時唯讀 |
| Verbiste（同上 `verbiste`） | 動詞例句比對用的變位詞形 | GPL-2.0-or-later | 什麼都不進。變位形只拿來「找」句子，`examples.json` 裡沒有任何一格變位表 |

`lexicon/.cache/` 在 `.gitignore` 裡，約 160 MB：Wiktionnaire 原文（`frwikt.json`、`parsed.json`）與 Tatoeba 匯出檔（`tatoeba/`）。

## 重新產生

四支腳本都在 `scripts/`，照這個順序跑。都只寫 `lexicon/`，不碰 fexgen 或 vault。

```bash
# 1. 抓 fr.wiktionary 的法文段落（約 8,200 個標題、每 50 個一批間隔 1.5 秒，可中斷重跑續抓）
node scripts/lexicon-wikt.mjs
# 2. 由 parsed.json 寫 genders.json 與 spelling.json，並和 fexgen 的 92 筆性別交叉比對
node scripts/lexicon-genders.mjs
# 3. 切批給人（或 agent）逐筆寫釋義，寫完的 out-NN.json 檢查後併回 glosses.json
node scripts/lexicon-glosses.mjs --batches <工作目錄> <批數>
node scripts/lexicon-glosses.mjs --merge <工作目錄>
# 4. 由 Tatoeba 匯出檔挑例句，寫 examples.json
node scripts/lexicon-tatoeba.mjs
```

第 3 步的 `--merge` 會擋簡體字與超過 40 字的釋義，有任何一筆不合格就整批不寫。

第 4 步要先把 Tatoeba 的五個匯出檔下載、`bunzip2` 解壓到 `lexicon/.cache/tatoeba/`：

```
https://downloads.tatoeba.org/exports/per_language/fra/fra_sentences_detailed.tsv.bz2
https://downloads.tatoeba.org/exports/per_language/fra/fra_user_languages.tsv.bz2
https://downloads.tatoeba.org/exports/per_language/fra/fra-cmn_links.tsv.bz2
https://downloads.tatoeba.org/exports/per_language/cmn/cmn_sentences_detailed.tsv.bz2
https://downloads.tatoeba.org/exports/per_language/cmn/cmn_transcriptions.tsv.bz2
```

中文翻譯優先用 `cmn_transcriptions.tsv` 裡 Tatoeba 自動產生的繁體轉寫（`Hant`），原本就是繁體的句子沒有轉寫，直接用原文。
