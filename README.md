# cadence

本地法文複習工作台。把已經存在的詞彙表、變位表與連接詞筆記，變成每天真的會打開的東西。

沒有帳號、沒有雲端、沒有第三方套件。`npm start` 之後在 `http://127.0.0.1:4173` 打開，全部跑在這台機器上。

```bash
npm run build     # 從四個資料來源產生題庫（第一次必跑）
npm start         # 啟動伺服器並打開瀏覽器
```

不想開終端機的話，在 Finder 裡雙擊 `cadence.command`：它會自己找到專案目錄、
確認 node 在、建好題庫、開瀏覽器。已經有一個 cadence 在跑就不會再開一個，
直接把瀏覽器叫出來。可以拖到 Dock 上。

## 它做什麼

16,401 張卡，七種題型：

| 題型 | 張數 | 出題方式 |
|---|---|---|
| 動詞變位 | 9,073 | 給不定式＋時態＋人稱，打出變位 |
| 看字回想 | 3,549 | 給法文，自評想不想得起中文 |
| 中翻法 | 3,474 | 給中文，打出法文，重音算數 |
| 名詞化 | 92 | 給基詞，打出冠詞＋派生名詞 |
| 改寫整句 | 88 | 給句子與要求，改寫後自評 |
| 挑連接詞 | 75 | 四選一 |
| 連接詞 | 50 | 這個連接詞後面接直陳式還是虛擬式 |

五個檢視：

- **今天** — DELF 四科各列一行，今天各要做什麼。預設落地頁。
- **複習** — 今天該做的卡。打字題即時批改，錯法分成拼錯與漏重音，大小寫不算錯。
- **統計** — 各類別進度、練習頻率熱力圖、最弱的卡、錯誤類型分布、未來 30 天工作量。
- **推演** — 給一個考試日期，模擬到那天為止的每日負擔與預期記得的張數。
- **查詢** — 查一個字，看它的釋義、詞性、等級與完整變位表。

## 為什麼是這五個檢視

「今天」回答「現在坐下來，先做哪一件事」。DELF B1 的及格條件是四科總分 50/100
**且單科不低於 5/25**，任一科掛零直接出局；七種題型攤在同一個佇列裡，練久了會自然
全部倒向卡片最多的變位，另外幾科一張也沒動。這一頁存在的理由就是讓那件事藏不住。
CO 與 PO 沒有卡片（題庫裡沒有音檔，發音與互動機器也判不了），那兩列指向 `study/`
底下的官方樣題入口與 GPT 練習用的固定 prompt，做了沒有系統記不到，畫面上直接這樣寫。

複習頁是每天真正在用的頁面，其餘三個回答人腦算不出來的問題：

- **統計**回答「我到底練到哪、哪裡最弱」。答錯次數與錯誤類型是累積出來的，記不住。
- **推演**回答「考試那天我大概會記得多少、每天要做幾張才夠」。16,000 張卡各自有自己的穩定度與到期日，遺忘曲線是冪律不是直線，這個計算憑感覺估不出來。
- **查詢**回答「這個字到底怎麼變位」，省掉每次翻書。

## 排程：FSRS-6

間隔不是固定表，是每張卡各自算的。

FSRS 為每張卡維護三個量：**S**（穩定度，記憶從剛複習完掉到九成把握所需的天數）、**D**（難度 1–10）、**R**（此刻的可提取機率）。下次複習日由「你希望複習時還有幾成把握」反推。預設 0.9。

`src/engine/fsrs.mjs` 是 py-fsrs（MIT）`fsrs/scheduler.py` 的逐行移植，不是重新發明。**732 組黃金向量**由參考實作的原始碼直接執行產生，跑在 `tests/fsrs.test.mjs` 裡；移植如果有偏差，測試會紅。

## 資料的存法

```
data/reviews.jsonl   每次作答一行 JSON，只增不改。事實來源，進版控。
data/checkins.jsonl  CO／PO 的手動打卡，一天一行，同樣只增不改、同樣進版控。
data/cadence.db      SQLite 索引。題庫、記憶狀態、統計都在這，可整個重算，不進版控。
data/bank/           建置產物，由 npm run build 現算，不進版控。
```

這樣切的理由：SQLite 檔壞掉、schema 改版、或這個專案被丟掉，練了幾百天的紀錄都還在，而且是 `cat` 就讀得懂的格式。索引壞了跑 `npm run reindex` 從兩個 JSONL 重建。

## 資料與授權

題庫由四個來源在**建置時**現算，本 repo 不收任何衍生資料：

| 來源 | 用途 | 授權 |
|---|---|---|
| `french-exam-generator/data` | 詞彙、2,000 多筆人工中文釋義、英文定義、陰陽性 | 個人資料，未公開 |
| Ricky-KnowledgeBase `raw/sources/french/verbiste` | 784 張動詞變位表 | **Verbiste，GPL-2.0-or-later** |
| Ricky-KnowledgeBase `wiki/concepts/french` | 連接詞後接語氣等文法規則 | 個人筆記 |
| Ricky-KnowledgeBase `wiki/outputs/study-packs` | 改寫題與挑選題的現成題目 | 個人筆記 |

Verbiste（Copyright 2003–2016 Pierre Sarrazin）是 GPL-2.0-or-later。本專案只在 `npm run build` 時讀取那份 XML，產物一律寫進 `data/bank/`，而 `data/bank/` 在 `.gitignore` 裡。**這是刻意的隔離**：GPL 的傳染性只在散布衍生作品時發生，不散布就不觸發。要改這個安排之前先想清楚後果。

四個來源的位置可用環境變數覆寫：`CADENCE_FEXGEN`、`CADENCE_VERBISTE`、`CADENCE_VAULT`、`CADENCE_PACKS`。

有一份資料不在上表：`src/build/connector-gloss.mjs`。權威表依語氣分列、沒有中文欄，輔助表有中文但只收常用的，兩張表交集之外那 25 個連接詞的中文在 vault 裡不存在，所以由本專案自己寫。合併時輔助表一律優先、這份只填空；vault 哪天補了同一個連接詞，`npm run build` 會把那一列點出來要人刪掉。

另有 `CADENCE_DATA` 可以換掉題庫、索引與作答紀錄的落點（預設是 repo 內的 `data/`）。它的用途是測試與示範：`data/reviews.jsonl` 與 `data/checkins.jsonl` 是這個 repo 唯二不可重建的檔案，隨手跑幾張卡就會寫進去。目錄要自己先備好（`bank/` 與 `reviews.jsonl`；打卡檔第一次打卡時自動建立），不會自動建立。

```bash
CADENCE_DATA=/tmp/cadence-demo npm start
```

## 指令

```bash
cadence serve     [--port 4173] [--no-open]   啟動本機伺服器
cadence build     [--verbose]                 重建題庫
cadence reindex                               從兩個 JSONL 重建 SQLite 索引
cadence stats     [--json]                    在終端機印出進度
cadence forecast  --exam YYYY-MM-DD [--limit 60] [--new 15] [--target 0.85]
cadence doctor    [--json]                    檢查資料來源、題庫、索引是否一致
```

## 開發

```bash
npm test      # 215 題，含 732 組 FSRS 黃金向量
npm run lint  # node --check 全檔語法檢查
```

零執行期依賴，零建置步驟。Node ≥ 24（用到內建的 `node:sqlite`）。
測試裡有四題會呼叫 `python3`：名詞化的排除清單與構詞規則是從
`french-exam-generator/tools/nominalize.py` 照抄的，那四題直接跑原生版本比對，
改一邊就紅。沒有 `python3` 或那個檔不在的機器上，那四題跳過，其餘照跑。前端是原生 ESM 加手寫 CSS，瀏覽器直接載 `web/js/*.mjs`，沒有打包器。

細節見 [docs/](docs/)：

- [docs/architecture.md](docs/architecture.md) — 模組怎麼分、資料怎麼流
- [docs/fsrs.md](docs/fsrs.md) — FSRS-6 的移植與驗證方式
- [docs/grading.md](docs/grading.md) — 打字題怎麼批改，重音為什麼算數
